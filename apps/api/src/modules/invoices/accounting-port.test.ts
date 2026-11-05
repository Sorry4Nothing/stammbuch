import { describe, expect, it } from "vitest";
import { DomainError } from "../accounting/domain.js";
import { createMemoryStore } from "../accounting/repository.js";
import { AccountingService } from "../accounting/service.js";
import { createAccountingPort } from "./accounting-port.js";
import {
  MemoryInvoiceRepository,
  MemoryReminderRepository,
  MemorySettingsRepository,
} from "./memory.js";
import { OTHER_TENANT, TENANT, invoiceInput, settingsInput } from "./test-fixtures.js";
import { InvoiceService } from "./service.js";

// Forderung beim Versenden (#55) mit der Buchhaltung im Speicher. Dieselben Fälle laufen gegen PostgreSQL in
// accounting.pg.test.ts.
const USER = "u1";
const NOW = new Date("2026-11-04T10:00:00Z");
const page = { offset: 0, limit: 100 };

function setup() {
  const store = createMemoryStore();
  const accounting = new AccountingService(store, () => NOW);
  const repos = {
    invoices: new MemoryInvoiceRepository(),
    reminders: new MemoryReminderRepository(),
    settings: new MemorySettingsRepository(),
  };
  const serviceFor = (tenantId: string) =>
    new InvoiceService({
      ...repos,
      accounting: createAccountingPort(accounting, { tenantId, userId: USER }),
      now: () => NOW,
    });
  const ctx = (tenantId: string) => ({ tenantId, userId: USER });
  return { accounting, serviceFor, ctx };
}

async function prepared(over = {}) {
  const s = setup();
  const service = s.serviceFor(TENANT);
  await service.saveSettings(TENANT, settingsInput(over));
  const send = async (input = {}) => {
    const d = await service.createDraft(TENANT, invoiceInput({ customerId: "K1", ...input }));
    return service.send(TENANT, d.invoice.id, USER);
  };
  const item = async (reference: string) =>
    (
      await s.accounting.listOpenItems(
        s.ctx(TENANT),
        { personId: "K1", onlyOpen: false, asOf: "2026-11-04" },
        page,
      )
    ).find((i) => i.reference === reference);
  const credits = () => s.accounting.openCredits(s.ctx(TENANT), { personId: "K1" });
  const balances = async (tenant = TENANT) =>
    Object.fromEntries(
      (await s.accounting.trialBalance(s.ctx(tenant), {})).rows
        .filter((r) => r.debit || r.credit)
        .map((r) => [r.code, [r.debit, r.credit]]),
    );
  return { ...s, service, send, item, credits, balances };
}

describe("Versenden bucht die Forderung", () => {
  it("Soll Debitoren, Haben Erlös und Mehrwertsteuer; offener Posten mit Rechnungsnummer und Fälligkeit", async () => {
    const t = await prepared();
    const v = await t.send();
    expect(v.invoice.totals.totalCents).toBe(26594);
    expect(v.invoice.number).toBe("RE-2026-0001");

    const entries = await t.accounting.listEntries(t.ctx(TENANT), {}, page);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "invoice", bookingDate: "2026-11-01" });
    expect(entries[0]?.lines).toEqual([
      { accountCode: "1100", side: "debit", amount: 26594, personId: "K1" },
      { accountCode: "3400", side: "credit", amount: 25500 },
      { accountCode: "2200", side: "credit", amount: 1094 },
    ]);
    expect(await t.item("RE-2026-0001")).toMatchObject({
      amount: 26594,
      remaining: 26594,
      status: "open",
      documentDate: "2026-11-01",
      dueDate: v.invoice.dueDate,
    });
    expect((await t.accounting.reconcileDebtors(t.ctx(TENANT))).difference).toBe(0);
  });

  it("Sammelrechnung bucht auf die Mitgliederbeiträge", async () => {
    const t = await prepared({ defaultVatMode: "none", defaultVatRateBp: 0 });
    await t.service.setFeatures(TENANT, { collectiveInvoicing: true });
    const run = await t.service.runCollective(TENANT, {
      runId: "lauf-2026",
      period: "Beitrag 2026",
      vatMode: "none",
      items: [
        {
          memberId: "m1",
          payerKey: "K1",
          payer: invoiceInput().debtor,
          description: "Beitrag Erika",
          amountCents: 6000,
        },
        {
          memberId: "m2",
          payerKey: "K1",
          payer: invoiceInput().debtor,
          description: "Beitrag Max",
          amountCents: 4000,
        },
      ],
    });
    await t.service.send(TENANT, run.created[0]!, USER);
    expect(await t.balances()).toEqual({ "1100": [10000, 0], "3000": [0, 10000] });
  });

  it("Rappenrundung geht in den Erlös; offener Posten entspricht dem Rechnungsbetrag", async () => {
    const line = (unitCents: number) => [
      { description: "Pos", quantityMilli: 1000, unitCents, vatRateBp: 0 },
    ];
    const t = await prepared({ roundTo5: true });
    await t.send({ lines: line(1003) }); // 10.03 -> 10.05
    await t.send({ lines: line(1002) }); // 10.02 -> 10.00
    expect(await t.item("RE-2026-0001")).toMatchObject({ amount: 1005 });
    expect(await t.item("RE-2026-0002")).toMatchObject({ amount: 1000 });
    expect(await t.balances()).toEqual({ "1100": [2005, 0], "3400": [0, 2005] });
  });

  it("ohne Kundennummer oder in Fremdwährung wird nicht versendet", async () => {
    const t = await prepared();
    for (const over of [{ customerId: undefined }, { customerId: "K 1!" }, { currency: "EUR" }]) {
      const d = await t.service.createDraft(TENANT, invoiceInput(over as never));
      await expect(t.service.send(TENANT, d.invoice.id, USER)).rejects.toMatchObject({
        statusCode: 422,
      });
      expect((await t.service.get(TENANT, d.invoice.id)).invoice.status).toBe("draft");
    }
    expect(await t.accounting.listEntries(t.ctx(TENANT), {}, page)).toEqual([]);
  });

  it("gesperrte Periode bricht das Versenden ab: Entwurf bleibt, nichts gebucht", async () => {
    const t = await prepared();
    await t.accounting.closePeriod(t.ctx(TENANT), "2026-10");
    const d = await t.service.createDraft(
      TENANT,
      invoiceInput({ customerId: "K1", issueDate: "2026-10-15" }),
    );
    const err = await t.service.send(TENANT, d.invoice.id, USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ code: "PERIOD_CLOSED" });
    const after = (await t.service.get(TENANT, d.invoice.id)).invoice;
    expect(after).toMatchObject({ status: "draft", number: null });
    expect(await t.accounting.listEntries(t.ctx(TENANT), {}, page)).toEqual([]);
  });

  it("unbekanntes oder falsches Erlöskonto wird schon bei Einstellung und Entwurf abgelehnt", async () => {
    const t = await prepared();
    for (const code of ["3999", "6940", "1020"]) {
      await expect(
        t.service.saveSettings(TENANT, settingsInput({ defaultRevenueAccount: code }), USER),
      ).rejects.toMatchObject({ statusCode: 422 });
      await expect(
        t.service.createDraft(
          TENANT,
          invoiceInput({
            customerId: "K1",
            lines: [{ description: "x", quantityMilli: 1000, unitCents: 100, accountCode: code }],
          }),
          USER,
        ),
      ).rejects.toMatchObject({ statusCode: 422 });
    }
    // Ohne Handelnden gibt es keine Prüfung gegen den Kontenplan und damit kein Konto.
    expect((await t.service.getSettings(TENANT))?.defaultRevenueAccount).toBeNull();
  });

  it("Buchung auf ein Konto, das es nicht gibt, bricht ab (Verteidigung in der Tiefe)", async () => {
    const t = await prepared();
    const v = await t.send();
    const port = createAccountingPort(
      t.accounting,
      { tenantId: TENANT, userId: USER },
      { revenueAccountCode: "3999" },
    );
    // Beleg aus der Zeit vor #67: Positionen ohne Konto, die Regel greift.
    const legacy = {
      ...v.invoice,
      id: "00000000-0000-4000-8000-0000000000aa",
      number: "RE-2026-0099",
      lines: v.invoice.lines.map((l) => ({
        description: l.description,
        quantityMilli: l.quantityMilli,
        unitCents: l.unitCents,
        vatRateBp: l.vatRateBp,
      })),
    };
    await expect(port.invoiceBooked(legacy)).rejects.toBeInstanceOf(DomainError);
  });
});

describe("Zahlungen schliessen den offenen Posten", () => {
  const pay = (t: Awaited<ReturnType<typeof prepared>>, id: string, amountCents: number) =>
    t.service.recordPayment(TENANT, id, { amountCents, paidOn: "2026-11-03" }, USER);

  it("Zahlung in zwei Teilen: Restposten, dann bezahlt, kein Guthaben", async () => {
    const t = await prepared();
    const v = await t.send();
    await pay(t, v.invoice.id, 10000);
    expect(await t.item("RE-2026-0001")).toMatchObject({
      allocated: 10000,
      remaining: 16594,
      status: "partial",
    });
    await pay(t, v.invoice.id, 16594);
    expect(await t.item("RE-2026-0001")).toMatchObject({ remaining: 0, status: "paid" });
    expect(await t.credits()).toEqual([]);
    expect((await t.accounting.reconcileDebtors(t.ctx(TENANT))).difference).toBe(0);
    expect(await t.balances()).toMatchObject({ "1020": [26594, 0], "1100": [26594, 26594] });
  });

  it("Überzahlung: Posten bezahlt, Überschuss bleibt als Guthaben", async () => {
    const t = await prepared();
    const v = await t.send();
    await pay(t, v.invoice.id, 30000);
    expect(await t.item("RE-2026-0001")).toMatchObject({ remaining: 0, status: "paid" });
    expect(await t.credits()).toMatchObject([{ amount: 30000, available: 3406 }]);
    expect((await t.accounting.reconcileDebtors(t.ctx(TENANT))).difference).toBe(0);
  });

  it("Storno und Teilgutschrift gleichen den offenen Posten aus", async () => {
    const t = await prepared();
    const a = await t.send();
    const b = await t.send();
    await t.service.cancel(TENANT, a.invoice.id, USER);
    expect(await t.item("RE-2026-0001")).toMatchObject({ remaining: 0, status: "paid" });

    await t.service.credit(
      TENANT,
      b.invoice.id,
      [{ description: "Kulanz", quantityMilli: 1000, unitCents: 5000, vatRateBp: 0 }],
      undefined,
      USER,
    );
    expect(await t.item("RE-2026-0002")).toMatchObject({ allocated: 5000, remaining: 21594 });
    expect(await t.credits()).toEqual([]);
    expect((await t.accounting.reconcileDebtors(t.ctx(TENANT))).difference).toBe(0);
    // Erlös 25500 + 25500 - 25500 (Storno) - 5000 (Gutschrift ohne MwSt)
    const bal = await t.balances();
    expect(bal["3400"]).toEqual([30500, 51000]);
    expect(bal["2200"]).toEqual([1094, 2188]);
  });

  it("Mandantentrennung: Buchungen und Posten eines Mandanten sind für den anderen unsichtbar", async () => {
    const t = await prepared();
    await t.send();
    const other = t.serviceFor(OTHER_TENANT);
    await other.saveSettings(OTHER_TENANT, settingsInput());
    const d = await other.createDraft(OTHER_TENANT, invoiceInput({ customerId: "K1" }));
    // Der Mandant B sieht die Rechnung von A nicht, versenden scheitert mit 404 und bucht nichts.
    const foreign = (await t.service.list(TENANT, { limit: 10, offset: 0 })).items[0]!;
    await expect(other.send(OTHER_TENANT, foreign.invoice.id, USER)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(await t.accounting.listEntries(t.ctx(OTHER_TENANT), {}, page)).toEqual([]);
    await other.send(OTHER_TENANT, d.invoice.id, USER);
    expect(await t.balances(OTHER_TENANT)).toMatchObject({ "1100": [26594, 0] });
    expect((await t.balances())["1100"]).toEqual([26594, 0]);
    expect(
      await t.accounting.listOpenItems(
        t.ctx(OTHER_TENANT),
        { personId: "K1", onlyOpen: true },
        page,
      ),
    ).toHaveLength(1);
  });
});

describe("Erlöskonto je Position (#67)", () => {
  const line = (unitCents: number, accountCode?: string, vatRateBp = 0, description = "Pos") => ({
    description,
    quantityMilli: 1000,
    unitCents,
    vatRateBp,
    ...(accountCode ? { accountCode } : {}),
  });
  const entryLines = async (t: Awaited<ReturnType<typeof prepared>>, tenant = TENANT) =>
    (await t.accounting.listEntries(t.ctx(tenant), {}, page)).map((e) => e.lines);

  it("bucht mehrere Konten je Beleg; Netto je Konto, Mehrwertsteuer gesammelt auf 2200, Summen gehen auf", async () => {
    const t = await prepared();
    const v = await t.send({
      lines: [
        line(10000, "3000"),
        line(9000, "3200", 810, "Kurs"),
        line(4000, undefined, 810, "Beratung"), // Standardkonto 3400
      ],
    });
    // Netto 230.00, MwSt 8.1 % auf 130.00 = 10.53, Total 240.53
    expect(v.invoice.totals).toMatchObject({ netCents: 23000, vatCents: 1053, totalCents: 24053 });
    expect(v.invoice.lines.map((l) => l.accountCode)).toEqual(["3000", "3200", "3400"]);
    expect(await entryLines(t)).toEqual([
      [
        { accountCode: "1100", side: "debit", amount: 24053, personId: "K1" },
        { accountCode: "3000", side: "credit", amount: 10000 },
        { accountCode: "3200", side: "credit", amount: 9000 },
        { accountCode: "3400", side: "credit", amount: 4000 },
        { accountCode: "2200", side: "credit", amount: 1053 },
      ],
    ]);
    expect(await t.item("RE-2026-0001")).toMatchObject({ amount: 24053 });
    expect((await t.accounting.reconcileDebtors(t.ctx(TENANT))).difference).toBe(0);
  });

  it("gleiche Konten mehrerer Positionen werden zusammengezogen", async () => {
    const t = await prepared();
    await t.send({ lines: [line(1000, "3200"), line(2500, "3000"), line(500, "3200")] });
    expect((await entryLines(t))[0]).toEqual([
      { accountCode: "1100", side: "debit", amount: 4000, personId: "K1" },
      { accountCode: "3200", side: "credit", amount: 1500 },
      { accountCode: "3000", side: "credit", amount: 2500 },
    ]);
  });

  it("Rappenrundung geht an das Konto mit dem grössten Netto, bei Gleichstand an das erste", async () => {
    const t = await prepared({ roundTo5: true });
    await t.send({ lines: [line(1003, "3000"), line(1004, "3200")] }); // 20.07 -> 20.05
    await t.send({ lines: [line(1002, "3000"), line(1002, "3200")] }); // 20.04 -> 20.05
    await t.send({ lines: [line(1001, "3200"), line(1003, "3000")] }); // 20.04 -> 20.05
    expect(await entryLines(t)).toEqual([
      [
        { accountCode: "1100", side: "debit", amount: 2005, personId: "K1" },
        { accountCode: "3000", side: "credit", amount: 1003 },
        { accountCode: "3200", side: "credit", amount: 1002 },
      ],
      [
        { accountCode: "1100", side: "debit", amount: 2005, personId: "K1" },
        { accountCode: "3000", side: "credit", amount: 1003 },
        { accountCode: "3200", side: "credit", amount: 1002 },
      ],
      [
        { accountCode: "1100", side: "debit", amount: 2005, personId: "K1" },
        { accountCode: "3200", side: "credit", amount: 1001 },
        { accountCode: "3000", side: "credit", amount: 1004 },
      ],
    ]);
    expect((await t.accounting.reconcileDebtors(t.ctx(TENANT))).difference).toBe(0);
  });

  it("Standardkonto des Mandanten gilt für Positionen ohne Konto; Sammelrechnungen bleiben auf 3000", async () => {
    const t = await prepared({ defaultRevenueAccount: "3200", defaultVatMode: "none" });
    await t.service.setFeatures(TENANT, { collectiveInvoicing: true });
    const v = await t.send({ lines: [line(5000)] });
    expect(v.invoice.lines[0]?.accountCode).toBe("3200");
    const run = await t.service.runCollective(TENANT, {
      runId: "lauf-2026",
      period: "Beitrag 2026",
      vatMode: "none",
      items: [
        {
          memberId: "m1",
          payerKey: "K1",
          payer: invoiceInput().debtor,
          description: "Beitrag",
          amountCents: 6000,
        },
      ],
    });
    await t.service.send(TENANT, run.created[0]!, USER);
    expect(await t.balances()).toEqual({
      "1100": [11000, 0],
      "3200": [0, 5000],
      "3000": [0, 6000],
    });
  });

  it("spätere Änderung des Standardkontos lässt gebuchte Belege und ihre Gutschrift unberührt", async () => {
    const t = await prepared({ defaultRevenueAccount: "3200" });
    const a = await t.send({ lines: [line(5000, undefined, 810)] });
    await t.service.saveSettings(TENANT, settingsInput({ defaultRevenueAccount: null }), USER);
    const b = await t.send({ lines: [line(7000)] });
    expect(b.invoice.lines[0]?.accountCode).toBe("3400");
    // Der gebuchte Beleg trägt sein Konto fest; Storno bucht spiegelbildlich auf 3200, nicht auf das neue Standardkonto.
    expect((await t.service.get(TENANT, a.invoice.id)).invoice.lines[0]?.accountCode).toBe("3200");
    await t.service.cancel(TENANT, a.invoice.id, USER);
    const bal = await t.balances();
    expect(bal["3200"]).toEqual([5000, 5000]);
    expect(bal["3400"]).toEqual([0, 7000]);
    expect(bal["2200"]).toEqual([405, 405]);
  });

  it("Storno und Gutschrift buchen spiegelbildlich auf jedes Konto", async () => {
    const t = await prepared();
    const v = await t.send({
      lines: [line(10000, "3000"), line(9000, "3200", 810), line(4000, undefined, 810)],
    });
    await t.service.cancel(TENANT, v.invoice.id, USER);
    expect(await t.balances()).toEqual({
      "1100": [24053, 24053],
      "3000": [10000, 10000],
      "3200": [9000, 9000],
      "3400": [4000, 4000],
      "2200": [1053, 1053],
    });
    expect(await t.item("RE-2026-0001")).toMatchObject({ remaining: 0, status: "paid" });
    expect((await t.accounting.reconcileDebtors(t.ctx(TENANT))).difference).toBe(0);
  });

  it("Teilgutschrift: ohne Konto bei einem Konto der Rechnung, bei mehreren muss die Position es nennen", async () => {
    const t = await prepared();
    const single = await t.send({ lines: [line(5000, "3200")] });
    const multi = await t.send({ lines: [line(5000, "3200"), line(5000, "3000")] });
    const credit = (id: string, accountCode?: string) =>
      t.service.credit(
        TENANT,
        id,
        [
          {
            description: "Kulanz",
            quantityMilli: 1000,
            unitCents: 1000,
            ...(accountCode ? { accountCode } : {}),
          },
        ],
        undefined,
        USER,
      );
    await credit(single.invoice.id);
    expect((await t.balances())["3200"]).toEqual([1000, 5000 + 5000]);
    await expect(credit(multi.invoice.id)).rejects.toMatchObject({ statusCode: 422 });
    await credit(multi.invoice.id, "3000");
    const bal = await t.balances();
    expect(bal["3000"]).toEqual([1000, 5000]);
    expect(bal["3200"]).toEqual([1000, 10000]);
    expect((await t.accounting.reconcileDebtors(t.ctx(TENANT))).difference).toBe(0);
  });

  it("Mandantentrennung: Konten aus dem Kontenplan eines anderen Mandanten sind unbekannt", async () => {
    const t = await prepared();
    const other = t.serviceFor(OTHER_TENANT);
    await other.saveSettings(OTHER_TENANT, settingsInput());
    await t.accounting.createAccount(t.ctx(OTHER_TENANT), {
      code: "3500",
      name: "Spenden",
      type: "revenue",
    });
    await other.saveSettings(OTHER_TENANT, settingsInput({ defaultRevenueAccount: "3500" }), USER);
    await expect(
      t.service.saveSettings(TENANT, settingsInput({ defaultRevenueAccount: "3500" }), USER),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      t.service.createDraft(TENANT, invoiceInput({ lines: [line(100, "3500")] }), USER),
    ).rejects.toMatchObject({ statusCode: 422 });

    const d = await other.createDraft(OTHER_TENANT, invoiceInput({ customerId: "K1" }));
    const sent = await other.send(OTHER_TENANT, d.invoice.id, USER);
    expect(sent.invoice.lines.every((l) => l.accountCode === "3500")).toBe(true);
    expect(await t.balances(OTHER_TENANT)).toMatchObject({ "3500": [0, 25500] });
    expect(await t.balances()).toEqual({});
  });

  it("gesperrte Periode lehnt auch einen Beleg mit mehreren Konten ab", async () => {
    const t = await prepared();
    await t.accounting.closePeriod(t.ctx(TENANT), "2026-10");
    const d = await t.service.createDraft(
      TENANT,
      invoiceInput({
        customerId: "K1",
        issueDate: "2026-10-15",
        lines: [line(100, "3000"), line(200, "3200")],
      }),
    );
    await expect(t.service.send(TENANT, d.invoice.id, USER)).rejects.toMatchObject({
      code: "PERIOD_CLOSED",
    });
    expect(await entryLines(t)).toEqual([]);
    expect((await t.service.get(TENANT, d.invoice.id)).invoice.status).toBe("draft");
  });
});

describe("Rückbuchung einer Zahlung (#68)", () => {
  type T = Awaited<ReturnType<typeof prepared>>;
  const pay = (t: T, id: string, amountCents: number, paidOn = "2026-11-03") =>
    t.service.recordPayment(TENANT, id, { amountCents, paidOn }, USER);

  it("bucht die Zahlung spiegelbildlich, öffnet den Posten wieder und lässt die übrige Zahlung stehen", async () => {
    const t = await prepared();
    const v = await t.send();
    await pay(t, v.invoice.id, 10000);
    await pay(t, v.invoice.id, 16594);
    const back = await pay(t, v.invoice.id, -16594, "2026-11-04");
    expect(back.invoice.status).toBe("sent");
    expect(back).toMatchObject({ paidCents: 10000, openCents: 16594 });
    expect(back.invoice.payments.map((p) => p.amountCents)).toEqual([10000, 16594, -16594]);

    expect(await t.item("RE-2026-0001")).toMatchObject({
      allocated: 10000,
      remaining: 16594,
      status: "partial",
    });
    expect(await t.credits()).toEqual([]);
    expect((await t.accounting.reconcileDebtors(t.ctx(TENANT))).difference).toBe(0);
    expect(await t.balances()).toMatchObject({
      "1020": [26594, 16594],
      "1100": [26594 + 16594, 26594],
    });

    const entries = await t.accounting.listEntries(t.ctx(TENANT), {}, page);
    const reversal = entries.at(-1)!;
    expect(reversal).toMatchObject({ kind: "reversal", bookingDate: "2026-11-04" });
    expect(reversal.reversalOf).toBe(entries[2]?.id); // Rechnung, Zahlung 1, Zahlung 2
    expect(reversal.lines).toEqual([
      { accountCode: "1020", side: "credit", amount: 16594 },
      { accountCode: "1100", side: "debit", amount: 16594, personId: "K1" },
    ]);
    const audit = await t.accounting.listAudit(t.ctx(TENANT), page);
    expect(audit.find((a) => a.action === "payment.returned")).toMatchObject({
      actor: USER,
      detail: { amount: 16594, reopened: 16594 },
    });
    expect((await t.accounting.verifyIntegrity(t.ctx(TENANT))).ok).toBe(true);
  });

  it("volle Zahlung zurück: Rechnung und Posten sind wieder offen, Fälligkeit bleibt; erneute Zahlung schliesst wieder", async () => {
    const t = await prepared();
    const v = await t.send();
    await pay(t, v.invoice.id, 26594);
    expect((await t.service.get(TENANT, v.invoice.id)).invoice.status).toBe("paid");
    const back = await pay(t, v.invoice.id, -26594);
    expect(back).toMatchObject({ paidCents: 0, openCents: 26594 });
    expect(back.invoice.status).toBe("sent");
    expect(back.invoice.dueDate).toBe(v.invoice.dueDate);
    expect(await t.item("RE-2026-0001")).toMatchObject({
      allocated: 0,
      remaining: 26594,
      status: "open",
      dueDate: v.invoice.dueDate,
    });

    await pay(t, v.invoice.id, 26594);
    expect(await t.item("RE-2026-0001")).toMatchObject({ remaining: 0, status: "paid" });
    // Zweite Zahlung und deren Rückbuchung: die erste Rückbuchung hat die erste Zahlung aufgehoben.
    await pay(t, v.invoice.id, -26594);
    expect(await t.item("RE-2026-0001")).toMatchObject({ remaining: 26594, status: "open" });
    expect((await t.accounting.reconcileDebtors(t.ctx(TENANT))).difference).toBe(0);
    expect((await t.accounting.verifyIntegrity(t.ctx(TENANT))).ok).toBe(true);
  });

  it("Überzahlung: die Rückbuchung nimmt auch das Guthaben zurück", async () => {
    const t = await prepared();
    const v = await t.send();
    await pay(t, v.invoice.id, 30000);
    expect(await t.credits()).toMatchObject([{ available: 3406 }]);
    await pay(t, v.invoice.id, -30000);
    expect(await t.credits()).toEqual([]);
    expect(await t.item("RE-2026-0001")).toMatchObject({ remaining: 26594, status: "open" });
    expect((await t.accounting.reconcileDebtors(t.ctx(TENANT))).difference).toBe(0);
    expect(await t.balances()).toMatchObject({ "1020": [30000, 30000], "1100": [56594, 30000] });
  });

  it("jede Zahlung lässt sich nur einmal zurückbuchen; Betrag und Datum müssen zur Zahlung passen", async () => {
    const t = await prepared();
    const v = await t.send();
    await pay(t, v.invoice.id, 10000);
    const count = async () => (await t.accounting.listEntries(t.ctx(TENANT), {}, page)).length;
    const before = await count();

    await expect(pay(t, v.invoice.id, -5000)).rejects.toMatchObject({ statusCode: 422 });
    await expect(pay(t, v.invoice.id, -10000, "2026-11-02")).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(await count()).toBe(before);

    await pay(t, v.invoice.id, -10000);
    expect(await count()).toBe(before + 1);
    await expect(pay(t, v.invoice.id, -10000)).rejects.toMatchObject({ statusCode: 422 });
    expect(await count()).toBe(before + 1);
    expect((await t.service.get(TENANT, v.invoice.id)).invoice.payments).toHaveLength(2);
  });

  it("gesperrte Periode: nichts wird zurückgebucht, nichts bleibt halb geschrieben", async () => {
    const t = await prepared();
    const v = await t.send({ issueDate: "2026-09-15" });
    await pay(t, v.invoice.id, 26594, "2026-09-20");
    await t.accounting.closePeriod(t.ctx(TENANT), "2026-10");
    const count = async () => (await t.accounting.listEntries(t.ctx(TENANT), {}, page)).length;
    const before = await count();

    const err = await pay(t, v.invoice.id, -26594, "2026-10-05").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ code: "PERIOD_CLOSED" });
    expect(await count()).toBe(before);
    expect(await t.item("RE-2026-0001")).toMatchObject({ allocated: 26594, status: "paid" });
    const inv = (await t.service.get(TENANT, v.invoice.id)).invoice;
    expect(inv.payments).toHaveLength(1);
    expect(inv.status).toBe("paid");

    // In einer offenen Periode geht dieselbe Rückbuchung.
    await pay(t, v.invoice.id, -26594, "2026-11-04");
    expect(await t.item("RE-2026-0001")).toMatchObject({ remaining: 26594, status: "open" });
  });

  it("Mandantentrennung: ein anderer Mandant kann nicht zurückbuchen", async () => {
    const t = await prepared();
    const v = await t.send();
    await pay(t, v.invoice.id, 10000);
    const other = t.serviceFor(OTHER_TENANT);
    await other.saveSettings(OTHER_TENANT, settingsInput());
    await expect(
      other.recordPayment(
        OTHER_TENANT,
        v.invoice.id,
        { amountCents: -10000, paidOn: "2026-11-04" },
        USER,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await t.accounting.listEntries(t.ctx(OTHER_TENANT), {}, page)).toEqual([]);
    expect(await t.item("RE-2026-0001")).toMatchObject({ allocated: 10000 });
  });

  it("Buchhaltung: gleicher Schlüssel liefert das erste Ergebnis, andere Anfrage mit gleichem Schlüssel ist ein Konflikt", async () => {
    const t = await prepared();
    const v = await t.send();
    await pay(t, v.invoice.id, 10000);
    const done = await pay(t, v.invoice.id, -10000, "2026-11-04");
    const [original, ret] = done.invoice.payments;
    const input = {
      idempotencyKey: `invoice-payment-return:${ret!.id}`,
      paymentKey: `invoice-payment:${original!.id}`,
      bookingDate: "2026-11-04",
      reason: "Rückbuchung Zahlung RE-2026-0001",
    };
    const count = async () => (await t.accounting.listEntries(t.ctx(TENANT), {}, page)).length;
    const before = await count();
    const again = await t.accounting.returnPayment(t.ctx(TENANT), input);
    expect(again.replayed).toBe(true);
    expect(await count()).toBe(before);
    await expect(
      t.accounting.returnPayment(t.ctx(TENANT), { ...input, bookingDate: "2026-11-05" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // Neue Anfrage für dieselbe Zahlung: bereits zurückgebucht.
    await expect(
      t.accounting.returnPayment(t.ctx(TENANT), { ...input, idempotencyKey: "anderer-schluessel" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("Buchhaltung: eine nicht gebuchte Zahlung und ein Datum vor der Zahlung werden abgelehnt", async () => {
    const t = await prepared();
    const v = await t.send();
    const done = await pay(t, v.invoice.id, 10000, "2026-11-03");
    const key = `invoice-payment:${done.invoice.payments[0]!.id}`;
    const base = { idempotencyKey: "rueck-0001", paymentKey: key, reason: "Rücklastschrift" };
    await expect(
      t.accounting.returnPayment(t.ctx(TENANT), {
        ...base,
        paymentKey: "unbekannt-0001",
        bookingDate: "2026-11-04",
      }),
    ).rejects.toMatchObject({ code: "RULE_VIOLATION" });
    await expect(
      t.accounting.returnPayment(t.ctx(TENANT), { ...base, bookingDate: "2026-11-02" }),
    ).rejects.toMatchObject({ code: "RULE_VIOLATION" });
    // Die Zahlung eines anderen Mandanten ist hier unbekannt.
    await expect(
      t.accounting.returnPayment(t.ctx(OTHER_TENANT), { ...base, bookingDate: "2026-11-04" }),
    ).rejects.toMatchObject({ code: "RULE_VIOLATION" });
    expect(await t.item("RE-2026-0001")).toMatchObject({ allocated: 10000 });
  });
});
