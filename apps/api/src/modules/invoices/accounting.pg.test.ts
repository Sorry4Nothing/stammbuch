import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorHandler } from "../../lib/errors.js";
import { createPostgresStore } from "../accounting/postgres-store.js";
import { AccountingService } from "../accounting/service.js";
import { type Actor, PERMISSIONS, createInvoicesModule } from "./index.js";
import { createPgDeps } from "./pg-accounting.js";
import { InvoiceService } from "./service.js";
import { OTHER_TENANT, TENANT, invoiceInput, settingsInput } from "./test-fixtures.js";
import { PgTestServer } from "./test-pg.js";

// Forderung beim Versenden (#55) gegen PostgreSQL: Versenden, manuelle Zahlung, Storno, gesperrte Periode,
// Mandantentrennung. Der Weg über die Routen prüft auch die Handelnden-ID und die Fehlerabbildung.
const USER = "u-pg-1";
const page = { offset: 0, limit: 100 };
const who = (tenantId: string) => ({ tenantId, userId: USER });

let server: PgTestServer;
beforeAll(async () => {
  server = await PgTestServer.start();
}, 120_000);
afterAll(() => server?.stop());

async function prepared() {
  const ctx = await server.newContext("2026-11-04T10:00:00Z");
  const db = ctx.db;
  const deps = { ...createPgDeps(db), now: () => ctx.clock.now };
  const service = new InvoiceService(deps);
  const accounting = new AccountingService(createPostgresStore(db), () => ctx.clock.now);
  await service.saveSettings(TENANT, settingsInput());
  await service.saveSettings(OTHER_TENANT, settingsInput());

  const app = Fastify();
  app.setErrorHandler(errorHandler);
  const authenticate = (req: { headers: Record<string, unknown> }): Promise<Actor | null> => {
    const tenant = req.headers["x-tenant"];
    // Ohne das Recht zum Buchen (z. B. nur Erfassen): Prüfung der Rückbuchung.
    const permissions = new Set(
      req.headers["x-ohne-buchen"] ? PERMISSIONS.filter((p) => p !== "invoices:book") : PERMISSIONS,
    );
    return Promise.resolve(
      typeof tenant === "string" ? { userId: USER, tenantId: tenant, permissions } : null,
    );
  };
  const mod = createInvoicesModule({ ...deps, authenticate });
  await app.register(async (scope) => mod.register(scope));
  const call = (method: "POST" | "GET", url: string, payload?: object, tenant = TENANT) =>
    app.inject({ method, url, headers: { "x-tenant": tenant }, ...(payload ? { payload } : {}) });

  const draft = async (over = {}, tenant = TENANT) =>
    (await service.createDraft(tenant, invoiceInput({ customerId: "K1", ...over }))).invoice;
  const item = async (reference: string, tenant = TENANT) =>
    (
      await accounting.listOpenItems(
        who(tenant),
        { personId: "K1", onlyOpen: false, asOf: "2026-11-04" },
        page,
      )
    ).find((i) => i.reference === reference);
  return { ...ctx, service, accounting, call, draft, item, app };
}

describe("Forderung und Zahlung gegen PostgreSQL", () => {
  it("Versenden, Teil- und Restzahlung per API schliessen den offenen Posten", async () => {
    const t = await prepared();
    const d = await t.draft();
    const sent = await t.call("POST", `/invoices/${d.id}/send`);
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ number: "RE-2026-0001", status: "sent", openCents: 26594 });

    const entries = await t.accounting.listEntries(who(TENANT), {}, page);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.createdBy).toBe(USER);
    expect(entries[0]?.lines).toEqual([
      { accountCode: "1100", side: "debit", amount: 26594, personId: "K1" },
      { accountCode: "3400", side: "credit", amount: 25500 },
      { accountCode: "2200", side: "credit", amount: 1094 },
    ]);
    expect(await t.item("RE-2026-0001")).toMatchObject({
      amount: 26594,
      remaining: 26594,
      dueDate: "2026-12-01",
    });

    const pay = (amountCents: number) =>
      t.call("POST", `/invoices/${d.id}/payments`, { amountCents, paidOn: "2026-11-03" });
    expect((await pay(10000)).statusCode).toBe(200);
    expect(await t.item("RE-2026-0001")).toMatchObject({ allocated: 10000, status: "partial" });
    expect((await pay(16594)).json()).toMatchObject({ status: "paid", openCents: 0 });
    expect(await t.item("RE-2026-0001")).toMatchObject({ remaining: 0, status: "paid" });
    expect(await t.accounting.openCredits(who(TENANT), { personId: "K1" })).toEqual([]);
    expect((await t.accounting.reconcileDebtors(who(TENANT))).difference).toBe(0);
  });

  it("Überzahlung lässt Guthaben stehen, der Posten ist trotzdem geschlossen", async () => {
    const t = await prepared();
    const d = await t.draft();
    await t.call("POST", `/invoices/${d.id}/send`);
    const res = await t.call("POST", `/invoices/${d.id}/payments`, {
      amountCents: 30000,
      paidOn: "2026-11-03",
    });
    expect(res.statusCode).toBe(200);
    expect(await t.item("RE-2026-0001")).toMatchObject({ remaining: 0, status: "paid" });
    expect(await t.accounting.openCredits(who(TENANT), { personId: "K1" })).toMatchObject([
      { available: 3406 },
    ]);
  });

  it("Storno und Gutschrift per API gleichen den Posten aus", async () => {
    const t = await prepared();
    const a = await t.draft();
    const b = await t.draft();
    await t.call("POST", `/invoices/${a.id}/send`);
    await t.call("POST", `/invoices/${b.id}/send`);
    expect((await t.call("POST", `/invoices/${a.id}/cancel`)).statusCode).toBe(200);
    expect(await t.item("RE-2026-0001")).toMatchObject({ remaining: 0, status: "paid" });
    const credit = await t.call("POST", `/invoices/${b.id}/credit-notes`, {
      lines: [{ description: "Kulanz", quantityMilli: 1000, unitCents: 5000, vatRateBp: 0 }],
    });
    expect(credit.statusCode).toBe(201);
    expect(await t.item("RE-2026-0002")).toMatchObject({ allocated: 5000, remaining: 21594 });
    expect(await t.accounting.openCredits(who(TENANT), { personId: "K1" })).toEqual([]);
    expect((await t.accounting.reconcileDebtors(who(TENANT))).difference).toBe(0);
  });

  it("gesperrte Periode: 409, Entwurf bleibt, keine Nummer verbraucht, nichts gebucht", async () => {
    const t = await prepared();
    await t.accounting.closePeriod(who(TENANT), "2026-10");
    const old = await t.draft({ issueDate: "2026-10-15" });
    const res = await t.call("POST", `/invoices/${old.id}/send`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe("Die Buchungsperiode ist abgeschlossen.");
    expect(await t.accounting.listEntries(who(TENANT), {}, page)).toEqual([]);
    expect((await t.service.get(TENANT, old.id)).invoice).toMatchObject({
      status: "draft",
      number: null,
    });

    // Die nächste Rechnung bekommt weiterhin die erste Nummer: keine Lücke durch den Abbruch.
    const next = await t.draft();
    const ok = await t.call("POST", `/invoices/${next.id}/send`);
    expect(ok.json()).toMatchObject({ number: "RE-2026-0001", status: "sent" });
  });

  it("ohne Kundennummer wird nicht versendet (422), ohne Handelnden nicht gebucht", async () => {
    const t = await prepared();
    const d = await t.draft({ customerId: undefined });
    expect((await t.call("POST", `/invoices/${d.id}/send`)).statusCode).toBe(422);
    const ok = await t.draft();
    await expect(t.service.send(TENANT, ok.id)).rejects.toMatchObject({ statusCode: 401 });
    expect((await t.service.get(TENANT, ok.id)).invoice.status).toBe("draft");
    expect(await t.accounting.listEntries(who(TENANT), {}, page)).toEqual([]);
  });

  it("Mandantentrennung: Buchungen und Posten sind je Mandant getrennt", async () => {
    const t = await prepared();
    const a = await t.draft();
    const b = await t.draft({}, OTHER_TENANT);
    await t.call("POST", `/invoices/${a.id}/send`);

    // Mandant B kann die Rechnung von A weder versenden noch bezahlen.
    const foreignSend = await t.call("POST", `/invoices/${a.id}/send`, undefined, OTHER_TENANT);
    expect(foreignSend.statusCode).toBe(404);
    const foreignPay = await t.call(
      "POST",
      `/invoices/${a.id}/payments`,
      { amountCents: 100, paidOn: "2026-11-03" },
      OTHER_TENANT,
    );
    expect(foreignPay.statusCode).toBe(404);
    expect(await t.accounting.listEntries(who(OTHER_TENANT), {}, page)).toEqual([]);
    expect(await t.item("RE-2026-0001", OTHER_TENANT)).toBeUndefined();

    await t.call("POST", `/invoices/${b.id}/send`, undefined, OTHER_TENANT);
    expect(await t.accounting.listEntries(who(OTHER_TENANT), {}, page)).toHaveLength(1);
    expect(await t.accounting.listEntries(who(TENANT), {}, page)).toHaveLength(1);
    expect(await t.item("RE-2026-0001", OTHER_TENANT)).toMatchObject({ remaining: 26594 });
    expect(await t.item("RE-2026-0001")).toMatchObject({ remaining: 26594 });
  });
});

describe("Erlöskonto je Position und Rückbuchung gegen PostgreSQL (#67, #68)", () => {
  const line = (unitCents: number, accountCode?: string, vatRateBp = 0) => ({
    description: "Position",
    quantityMilli: 1000,
    unitCents,
    vatRateBp,
    ...(accountCode ? { accountCode } : {}),
  });
  const create = (t: Awaited<ReturnType<typeof prepared>>, lines: object[], over = {}) =>
    t.call("POST", "/invoices", {
      customerId: "K1",
      debtor: invoiceInput().debtor,
      issueDate: "2026-11-01",
      lines,
      ...over,
    });
  const idOf = (res: { json(): { id: string } }) => res.json().id;

  it("mehrere Konten je Beleg: Positionen speichern ihr Konto, das Versenden schreibt das Standardkonto fest", async () => {
    const t = await prepared();
    const res = await create(t, [
      line(10000, "3000"),
      line(9000, "3200", 810),
      line(4000, undefined, 810),
    ]);
    expect(res.statusCode).toBe(201);
    expect(res.json().lines.map((l: { accountCode?: string }) => l.accountCode)).toEqual([
      "3000",
      "3200",
      undefined,
    ]);
    const sent = await t.call("POST", `/invoices/${idOf(res)}/send`);
    expect(sent.statusCode).toBe(200);
    expect(sent.json().lines.map((l: { accountCode: string }) => l.accountCode)).toEqual([
      "3000",
      "3200",
      "3400",
    ]);
    // Aus der Datenbank gelesen, nicht aus dem Speicher.
    const reread = await t.call("GET", `/invoices/${idOf(res)}`);
    expect(reread.json().lines).toEqual(sent.json().lines);

    const entries = await t.accounting.listEntries(who(TENANT), {}, page);
    expect(entries[0]?.lines).toEqual([
      { accountCode: "1100", side: "debit", amount: 24053, personId: "K1" },
      { accountCode: "3000", side: "credit", amount: 10000 },
      { accountCode: "3200", side: "credit", amount: 9000 },
      { accountCode: "3400", side: "credit", amount: 4000 },
      { accountCode: "2200", side: "credit", amount: 1053 },
    ]);
    expect((await t.accounting.reconcileDebtors(who(TENANT))).difference).toBe(0);

    // Storno spiegelt jedes Konto.
    expect((await t.call("POST", `/invoices/${idOf(res)}/cancel`)).statusCode).toBe(200);
    const trial = await t.accounting.trialBalance(who(TENANT), {});
    for (const code of ["1100", "3000", "3200", "3400", "2200"]) {
      const row = trial.rows.find((r) => r.code === code)!;
      expect(row.debit, code).toBe(row.credit);
    }
    expect(trial.balanced).toBe(true);
  });

  it("Konto prüfen: Form (400), Kontenplan des Mandanten (422), Standardkonto in den Einstellungen", async () => {
    const t = await prepared();
    expect((await create(t, [line(100, "12")])).statusCode).toBe(400);
    expect((await create(t, [line(100, "3999")])).statusCode).toBe(422);
    expect((await create(t, [line(100, "6940")])).statusCode).toBe(422); // Aufwandkonto
    // Konto eines anderen Mandanten: im Kontenplan von A unbekannt.
    await t.accounting.createAccount(who(OTHER_TENANT), {
      code: "3500",
      name: "Spenden",
      type: "revenue",
    });
    expect((await create(t, [line(100, "3500")])).statusCode).toBe(422);

    const settings = {
      creditor: settingsInput().creditor,
      iban: settingsInput().iban,
    };
    const put = (defaultRevenueAccount: string | null, tenant = TENANT) =>
      t.app.inject({
        method: "PUT",
        url: "/invoices/settings",
        headers: { "x-tenant": tenant },
        payload: { ...settings, defaultRevenueAccount },
      });
    expect((await put("3999")).statusCode).toBe(422);
    expect((await put("3500")).statusCode).toBe(422);
    expect((await put("3200")).json().defaultRevenueAccount).toBe("3200");
    expect((await put("3500", OTHER_TENANT)).statusCode).toBe(200);
    expect((await put(null)).json().defaultRevenueAccount).toBeNull();

    // Das Standardkonto gilt beim Versenden, spätere Änderung berührt den gebuchten Beleg nicht.
    await put("3200");
    const id = idOf(await create(t, [line(5000)]));
    await t.call("POST", `/invoices/${id}/send`);
    await put(null);
    expect((await t.call("GET", `/invoices/${id}`)).json().lines[0].accountCode).toBe("3200");
  });

  it("die Datenbank hält das Konto eines versendeten Belegs fest und prüft die Form", async () => {
    const t = await prepared();
    const id = idOf(await create(t, [line(5000, "3200")]));
    const owner = new pg.Client({ connectionString: t.database.ownerUrl });
    await owner.connect();
    try {
      // Entwurf: änderbar (Form wird geprüft).
      await expect(
        owner.query("UPDATE rechnung_position SET erloeskonto = 'abc' WHERE rechnung_id = $1", [
          id,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      await t.call("POST", `/invoices/${id}/send`);
      await expect(
        owner.query("UPDATE rechnung_position SET erloeskonto = '3000' WHERE rechnung_id = $1", [
          id,
        ]),
      ).rejects.toMatchObject({ code: "23001" });
    } finally {
      await owner.end();
    }
  });

  it("Rückbuchung per API: Posten wieder offen, Buchung gespiegelt, nur einmal, Protokoll", async () => {
    const t = await prepared();
    const id = idOf(await create(t, [line(10000, "3000"), line(16594, "3200")]));
    await t.call("POST", `/invoices/${id}/send`);
    const pay = (amountCents: number, paidOn = "2026-11-03", tenant = TENANT, headers = {}) =>
      t.app.inject({
        method: "POST",
        url: `/invoices/${id}/payments`,
        headers: { "x-tenant": tenant, ...headers },
        payload: { amountCents, paidOn },
      });
    expect((await pay(10000)).statusCode).toBe(200);
    expect((await pay(16594)).json()).toMatchObject({ status: "paid", openCents: 0 });

    const back = await pay(-16594, "2026-11-04");
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ status: "sent", paidCents: 10000, openCents: 16594 });
    expect(await t.item("RE-2026-0001")).toMatchObject({
      allocated: 10000,
      remaining: 16594,
      status: "partial",
    });
    expect(await t.accounting.openCredits(who(TENANT), { personId: "K1" })).toEqual([]);
    expect((await t.accounting.reconcileDebtors(who(TENANT))).difference).toBe(0);
    expect((await t.accounting.verifyIntegrity(who(TENANT))).ok).toBe(true);
    const audit = await t.accounting.listAudit(who(TENANT), { offset: 0, limit: 200 });
    expect(audit.find((a) => a.action === "payment.returned")).toMatchObject({
      actor: USER,
      detail: { amount: 16594, reopened: 16594 },
    });

    // Doppelt, falscher Betrag, Datum vor der Zahlung: 422, nichts gebucht.
    const entries = (await t.accounting.listEntries(who(TENANT), {}, page)).length;
    expect((await pay(-16594, "2026-11-05")).statusCode).toBe(422);
    expect((await pay(-5000, "2026-11-05")).statusCode).toBe(422);
    expect((await pay(-10000, "2026-11-02")).statusCode).toBe(422);
    expect((await t.accounting.listEntries(who(TENANT), {}, page)).length).toBe(entries);

    // Mandant B kennt die Rechnung nicht.
    expect((await pay(-10000, "2026-11-05", OTHER_TENANT)).statusCode).toBe(404);
  });

  it("Rückbuchung verlangt das Recht zum Buchen; Zahlungen erfassen reicht dafür nicht", async () => {
    const t = await prepared();
    const id = idOf(await create(t, [line(10000, "3200")]));
    await t.call("POST", `/invoices/${id}/send`);
    const pay = (amountCents: number) =>
      t.app.inject({
        method: "POST",
        url: `/invoices/${id}/payments`,
        headers: { "x-tenant": TENANT, "x-ohne-buchen": "1" },
        payload: { amountCents, paidOn: "2026-11-03" },
      });
    expect((await pay(10000)).statusCode).toBe(200);
    expect((await pay(-10000)).statusCode).toBe(403);
    expect(await t.item("RE-2026-0001")).toMatchObject({ allocated: 10000, status: "paid" });
  });

  it("gesperrte Periode: Rückbuchung 409, die Rechnung bleibt bezahlt, nichts halb geschrieben", async () => {
    const t = await prepared();
    const id = idOf(await create(t, [line(10000, "3200")], { issueDate: "2026-09-15" }));
    await t.call("POST", `/invoices/${id}/send`);
    const pay = (amountCents: number, paidOn: string) =>
      t.call("POST", `/invoices/${id}/payments`, { amountCents, paidOn });
    expect((await pay(10000, "2026-09-20")).statusCode).toBe(200);
    await t.accounting.closePeriod(who(TENANT), "2026-10");
    const entries = (await t.accounting.listEntries(who(TENANT), {}, page)).length;

    const blocked = await pay(-10000, "2026-10-05");
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toBe("Die Buchungsperiode ist abgeschlossen.");
    expect((await t.service.get(TENANT, id)).invoice.payments).toHaveLength(1);
    expect((await t.service.get(TENANT, id)).invoice.status).toBe("paid");
    expect((await t.accounting.listEntries(who(TENANT), {}, page)).length).toBe(entries);
    expect(await t.item("RE-2026-0001")).toMatchObject({ allocated: 10000, status: "paid" });

    expect((await pay(-10000, "2026-11-04")).statusCode).toBe(200);
    expect(await t.item("RE-2026-0001")).toMatchObject({ remaining: 10000, status: "open" });
  });
});
