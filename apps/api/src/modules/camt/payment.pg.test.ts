import { Datenbank } from "@stammbuch/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createTestDatabase, withCredentials } from "../../../../../packages/db/test/helpers.js";
import { AccountingService } from "../accounting/service.js";
import { createPostgresStore } from "../accounting/postgres-store.js";
import { createOpenItemLookup } from "../invoices/open-items.js";
import { createPgDeps } from "../invoices/pg-accounting.js";
import { InvoiceService } from "../invoices/service.js";
import { invoiceInput, settingsInput } from "../invoices/test-fixtures.js";
import { invoicePaymentPort } from "./pg.js";
import { PgCamtRepository } from "./repository.pg.js";
import type { CamtContext } from "./repository.pg.js";
import { CamtRestService } from "./rest.js";
import { CamtImportService } from "./service.js";
import type { OpenItemLookup } from "./service.js";

// Zahlung buchen (#41): CAMT-Zuordnung, Rechnung und Buchhaltung gegen echtes PostgreSQL.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const userA = "aaaaaaaa-0000-4000-8000-000000000001";
const userB = "bbbbbbbb-0000-4000-8000-000000000001";
const ctxA: CamtContext = { kundeId: A, benutzerId: userA };
const ctxB: CamtContext = { kundeId: B, benutzerId: userB };
const accA = { tenantId: A, userId: userA };

/** QR-Referenz mit gültiger Prüfziffer ist nicht nötig: die Rechnung vergibt sie selbst. */
let seq = 0;
function camt(
  entries: {
    qrr: string;
    amount: string;
    ccy?: string;
    date?: string;
    ref?: string;
    /** Rückbuchung einer Zahlung: Belastung mit Storno-Kennzeichen. */
    reversal?: boolean;
  }[],
) {
  const n = ++seq;
  const body = entries
    .map(
      (e, i) => `
      <Ntry>
        <NtryRef>${i + 1}</NtryRef>
        <Amt Ccy="${e.ccy ?? "CHF"}">${e.amount}</Amt>
        <CdtDbtInd>${e.reversal ? "DBIT" : "CRDT"}</CdtDbtInd>${e.reversal ? "<RvslInd>true</RvslInd>" : ""}
        <Sts><Cd>BOOK</Cd></Sts>
        <BookgDt><Dt>${e.date ?? "2026-11-02"}</Dt></BookgDt>
        <AcctSvcrRef>${e.ref ?? `REF-${n}-${i}`}</AcctSvcrRef>
        <NtryDtls><TxDtls>
          <RltdPties><Dbtr><Pty><Nm>Beispiel Verein</Nm></Pty></Dbtr></RltdPties>
          <RmtInf><Strd><CdtrRefInf>
            <Tp><CdOrPrtry><Prtry>QRR</Prtry></CdOrPrtry></Tp><Ref>${e.qrr}</Ref>
          </CdtrRefInf></Strd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>`,
    )
    .join("");
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.08"><BkToCstmrDbtCdtNtfctn>
  <GrpHdr><MsgId>MSG-${n}</MsgId><CreDtTm>2026-11-02T06:00:00</CreDtTm></GrpHdr>
  <Ntfctn><Id>NTF-${n}</Id><CreDtTm>2026-11-02T06:00:00</CreDtTm>
    <Acct><Id><IBAN>CH4431999123000889012</IBAN></Id></Acct>${body}
  </Ntfctn></BkToCstmrDbtCdtNtfctn></Document>`);
}

describe("CAMT: Zahlung buchen", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let owner: pg.Client;
  let db: Datenbank;
  let invoices: InvoiceService;
  let accounting: AccountingService;
  let customers = 0;

  const repo = (ctx: CamtContext) => new PgCamtRepository(db, ctx);
  const importer = (ctx: CamtContext, lookup?: OpenItemLookup) =>
    new CamtImportService(
      repo(ctx),
      lookup ?? createOpenItemLookup(db, ctx.kundeId),
      invoicePaymentPort(ctx),
    );
  const rest = (ctx: CamtContext) => new CamtRestService(repo(ctx), invoicePaymentPort(ctx));

  /** Versendete Rechnung über `cents`; das Versenden hat die Forderung gebucht (Referenz = Rechnungsnummer). */
  async function invoice(cents: number, tenant = A, issueDate = "2026-10-01") {
    const customer = `K${++customers}`;
    const draft = await invoices.createDraft(
      tenant,
      invoiceInput({
        customerId: customer,
        issueDate,
        lines: [{ description: "Beitrag", quantityMilli: 1000, unitCents: cents, vatRateBp: 0 }],
      }),
    );
    const sent = await invoices.send(tenant, draft.invoice.id, tenant === A ? userA : userB);
    expect(sent.invoice.totals.totalCents).toBe(cents);
    const number = sent.invoice.number!;
    return { id: sent.invoice.id, customer, qrr: sent.invoice.reference!.value!, number };
  }
  const state = async (id: string) => {
    const v = await invoices.get(A, id);
    return {
      status: v.invoice.status,
      paid: v.paidCents,
      open: v.openCents,
      n: v.invoice.payments.length,
    };
  };
  const itemOf = async (customer: string, number: string) =>
    (
      await accounting.listOpenItems(
        accA,
        { personId: customer, onlyOpen: false },
        { offset: 0, limit: 50 },
      )
    ).find((i) => i.reference === number)!;
  const credits = (customer: string) => accounting.openCredits(accA, { personId: customer });
  const camtRows = async (status?: string) =>
    (
      await owner.query(
        `SELECT status, rest_grund FROM camt_zahlung WHERE kunde_id = $1 ${status ? "AND status = $2" : ""}`,
        status ? [A, status] : [A],
      )
    ).rows;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject("adminUrl"), inject("templateDb"));
    owner = new pg.Client({ connectionString: testDb.adminUrl });
    await owner.connect();
    await owner.query(
      `INSERT INTO kunde (id, name) VALUES ('${A}', 'Kunde A'), ('${B}', 'Kunde B')`,
    );
    await owner.query(
      `INSERT INTO benutzer (id, kunde_id, email, name, passwort_hash) VALUES
        ('${userA}', '${A}', 'a@example.test', 'A', 'x'), ('${userB}', '${B}', 'b@example.test', 'B', 'x')`,
    );
    db = new Datenbank(withCredentials(testDb.adminUrl, "stammbuch_app", inject("appPassword")), {
      max: 10,
    });
    // Wie in der Produktivverdrahtung: Versenden bucht die Forderung in der Buchhaltung (#55).
    invoices = new InvoiceService(createPgDeps(db));
    accounting = new AccountingService(createPostgresStore(db));
    await invoices.saveSettings(A, settingsInput());
    await invoices.saveSettings(B, settingsInput());
  });

  afterAll(async () => {
    await db.close();
    await owner.end();
    await testDb.drop();
  });

  it("automatische Zuordnung bucht Rechnung und Buchhaltung; Wiederholung bucht nichts doppelt", async () => {
    const inv = await invoice(10000);
    const file = camt([{ qrr: inv.qrr, amount: "100.00" }]);
    const r = await importer(ctxA).importFile(file);
    expect(r.import.counts).toMatchObject({ matched: 1, rest: 0 });
    expect(await state(inv.id)).toEqual({ status: "paid", paid: 10000, open: 0, n: 1 });
    // Die Zahlung ist der Forderung in der Buchhaltung zugeordnet, es bleibt kein Guthaben.
    expect(await itemOf(inv.customer, inv.number)).toMatchObject({
      allocated: 10000,
      status: "paid",
    });
    expect(await credits(inv.customer)).toEqual([]);
    expect((await accounting.reconcileDebtors(accA)).difference).toBe(0);

    // Dieselbe Datei: abgelehnt. Andere Datei mit derselben Buchung: Duplikat, keine zweite Zahlung.
    await expect(importer(ctxA).importFile(file)).rejects.toMatchObject({ code: "DUPLICATE_FILE" });
    const overlap = await importer(ctxA).importFile(
      camt([{ qrr: inv.qrr, amount: "100.00", ref: await camtRefOf(inv.qrr) }]),
    );
    expect(overlap.import.counts).toMatchObject({ matched: 0, rest: 0, duplicates: 1 });
    expect(await state(inv.id)).toMatchObject({ paid: 10000, n: 1 });
  });

  /** Bankreferenz der gespeicherten Buchung zu einer Referenz, um dieselbe Buchung in anderer Datei zu wiederholen. */
  async function camtRefOf(qrr: string, reversal = false) {
    const row = await owner.query(
      "SELECT transaktion->>'bankReference' AS ref FROM camt_zahlung WHERE transaktion->'reference'->>'value' = $1 AND storno = $2",
      [qrr, reversal],
    );
    return row.rows[0].ref as string;
  }

  it("parallele Importe überlappender Dateien buchen die Zahlung genau einmal", async () => {
    const inv = await invoice(7500);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        importer(ctxA).importFile(camt([{ qrr: inv.qrr, amount: "75.00", ref: "REF-PARALLEL" }])),
      ),
    );
    expect(results.every((x) => x.status === "fulfilled")).toBe(true);
    expect(await state(inv.id)).toEqual({ status: "paid", paid: 7500, open: 0, n: 1 });
    expect(await credits(inv.customer)).toEqual([]);
    expect(await itemOf(inv.customer, inv.number)).toMatchObject({ allocated: 7500 });
  });

  it("Teilzahlung: bleibt Restposten, manuelle Zuordnung bucht, Rest bleibt offen, zweite Zahlung schliesst", async () => {
    const inv = await invoice(10000);
    const r = await importer(ctxA).importFile(camt([{ qrr: inv.qrr, amount: "40.00" }]));
    expect(r.rest[0]).toMatchObject({ restReason: "AMOUNT_MISMATCH", openItemId: inv.id });
    expect(await state(inv.id)).toMatchObject({ n: 0 });

    await rest(ctxA).assign(r.rest[0]!.id, inv.id);
    expect(await state(inv.id)).toEqual({ status: "sent", paid: 4000, open: 6000, n: 1 });
    expect(await itemOf(inv.customer, inv.number)).toMatchObject({
      allocated: 4000,
      remaining: 6000,
    });
    expect(await credits(inv.customer)).toEqual([]);

    const r2 = await importer(ctxA).importFile(camt([{ qrr: inv.qrr, amount: "60.00" }]));
    // Jetzt stimmt der offene Betrag genau: automatisch gebucht.
    expect(r2.matched).toHaveLength(1);
    expect(await state(inv.id)).toEqual({ status: "paid", paid: 10000, open: 0, n: 2 });
    expect(await itemOf(inv.customer, inv.number)).toMatchObject({
      allocated: 10000,
      status: "paid",
    });
    expect((await accounting.reconcileDebtors(accA)).difference).toBe(0);
  });

  it("Überzahlung: Rechnung gilt als bezahlt, der Überschuss bleibt als Guthaben", async () => {
    const inv = await invoice(10000);
    const r = await importer(ctxA).importFile(camt([{ qrr: inv.qrr, amount: "120.00" }]));
    expect(r.rest[0]?.restReason).toBe("AMOUNT_MISMATCH");
    await rest(ctxA).assign(r.rest[0]!.id, inv.id);
    expect(await state(inv.id)).toMatchObject({ status: "paid", paid: 12000, n: 1 });
    expect(await itemOf(inv.customer, inv.number)).toMatchObject({
      allocated: 10000,
      remaining: 0,
    });
    expect(await credits(inv.customer)).toMatchObject([{ amount: 12000, available: 2000 }]);
    expect((await accounting.reconcileDebtors(accA)).difference).toBe(0);
  });

  it("gleichzeitige Zuordnung derselben Zahlung bucht genau einmal", async () => {
    const inv = await invoice(10000);
    const r = await importer(ctxA).importFile(camt([{ qrr: inv.qrr, amount: "30.00" }]));
    const id = r.rest[0]!.id;
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => rest(ctxA).assign(id, inv.id)),
    );
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(
      results.flatMap((x) =>
        x.status === "rejected" ? [(x.reason as { code: string }).code] : [],
      ),
    ).toEqual(Array(4).fill("PAYMENT_NOT_REST"));
    expect(await state(inv.id)).toEqual({ status: "sent", paid: 3000, open: 7000, n: 1 });
    expect(await credits(inv.customer)).toEqual([]);
  });

  it("abgelehnte Buchung (Periode gesperrt) rollt alles zurück: manuell wie automatisch", async () => {
    await accounting.closePeriod(accA, "2026-09");
    const inv = await invoice(10000);
    const credit0 = await credits(inv.customer);

    // Automatisch: Betrag passt, aber die Periode der Zahlung ist gesperrt -> Restposten, Rechnung unberührt.
    const auto = await importer(ctxA).importFile(
      camt([{ qrr: inv.qrr, amount: "100.00", date: "2026-09-15" }]),
    );
    expect(auto.import.counts).toMatchObject({ matched: 0, rest: 1 });
    expect(auto.rest[0]).toMatchObject({ status: "REST", restReason: "BOOKING_REJECTED" });
    expect(await state(inv.id)).toEqual({ status: "sent", paid: 0, open: 10000, n: 0 });
    expect(await credits(inv.customer)).toEqual(credit0);
    const stored = (await camtRows("REST")).filter((x) => x.rest_grund === "BOOKING_REJECTED");
    expect(stored).toHaveLength(1);

    // Manuell: dieselbe Ablehnung, die Zahlung bleibt Restposten, nichts wurde geschrieben.
    await expect(rest(ctxA).assign(auto.rest[0]!.id, inv.id)).rejects.toMatchObject({
      code: "BOOKING_REJECTED",
    });
    expect(await state(inv.id)).toMatchObject({ paid: 0, n: 0 });
    expect(await credits(inv.customer)).toEqual(credit0);
    expect((await repo(ctxA).listRestPayments({ limit: 100 })).items.map((p) => p.id)).toContain(
      auto.rest[0]!.id,
    );
    expect(
      (
        await owner.query(
          "SELECT 1 FROM audit_log WHERE aktion = 'camt.zahlung_zugeordnet' AND objekt_id = $1",
          [auto.rest[0]!.id],
        )
      ).rowCount,
    ).toBe(0);
  });

  it("andere Währung und fremde Rechnung werden abgelehnt", async () => {
    const inv = await invoice(10000);
    const eur = await importer(ctxA).importFile(
      camt([{ qrr: inv.qrr, amount: "100.00", ccy: "EUR" }]),
    );
    expect(eur.rest[0]?.restReason).toBe("AMOUNT_MISMATCH");
    await expect(rest(ctxA).assign(eur.rest[0]!.id, inv.id)).rejects.toMatchObject({
      code: "CURRENCY_MISMATCH",
    });

    // Rechnung von Kunde B: für Kunde A existiert sie nicht.
    const foreign = await invoice(10000, B);
    const chf = await importer(ctxA).importFile(camt([{ qrr: inv.qrr, amount: "10.00" }]));
    await expect(rest(ctxA).assign(chf.rest[0]!.id, foreign.id)).rejects.toMatchObject({
      code: "OPEN_ITEM_NOT_FOUND",
    });
    const viaB = (await invoices.get(B, foreign.id)).invoice.payments;
    expect(viaB).toHaveLength(0);
    expect(await state(inv.id)).toMatchObject({ n: 0 });
  });

  it("bezahlte Rechnung nimmt keine weitere Zahlung an", async () => {
    const inv = await invoice(5000);
    await importer(ctxA).importFile(camt([{ qrr: inv.qrr, amount: "50.00" }]));
    expect((await state(inv.id)).status).toBe("paid");
    const again = await importer(ctxA).importFile(camt([{ qrr: inv.qrr, amount: "50.00" }]));
    // Nicht mehr offen: keine Fundstelle, die Zahlung bleibt Restposten.
    expect(again.rest[0]?.restReason).toBe("NO_OPEN_ITEM");
    await expect(rest(ctxA).assign(again.rest[0]!.id, inv.id)).rejects.toMatchObject({
      code: "OPEN_ITEM_NOT_OPEN",
    });
    expect(await state(inv.id)).toMatchObject({ paid: 5000, n: 1 });
  });

  it("veralteter offener Betrag: nur der erwartete Betrag wird automatisch gebucht", async () => {
    const inv = await invoice(10000);
    const first = await importer(ctxA).importFile(camt([{ qrr: inv.qrr, amount: "40.00" }]));
    await rest(ctxA).assign(first.rest[0]!.id, inv.id); // offen sind jetzt 60.00
    // Veraltete Abfrage: behauptet 100.00 offen, die Datenbank weiss es besser.
    const stale: OpenItemLookup = {
      findByReferences: () =>
        Promise.resolve([{ id: inv.id, reference: inv.qrr, amountRappen: 10000, currency: "CHF" }]),
    };
    const r = await importer(ctxA, stale).importFile(camt([{ qrr: inv.qrr, amount: "100.00" }]));
    expect(r.import.counts).toMatchObject({ matched: 0, rest: 1 });
    expect(r.rest[0]?.restReason).toBe("AMOUNT_MISMATCH");
    expect(await state(inv.id)).toMatchObject({ paid: 4000, open: 6000, n: 1 });
  });

  it("Kunde B kann Zahlungen von Kunde A weder sehen noch zuordnen", async () => {
    const inv = await invoice(10000);
    const r = await importer(ctxA).importFile(camt([{ qrr: inv.qrr, amount: "20.00" }]));
    await expect(rest(ctxB).assign(r.rest[0]!.id, inv.id)).rejects.toMatchObject({
      code: "PAYMENT_NOT_FOUND",
    });
    expect(await state(inv.id)).toMatchObject({ n: 0 });
  });
  describe("Rückbuchung (Storno-Eintrag der Bank, #68)", () => {
    it("ordnet die Rückbuchung automatisch zu: Rechnung wieder offen, Posten wieder offen, Buchung gespiegelt", async () => {
      const inv = await invoice(10000);
      await importer(ctxA).importFile(camt([{ qrr: inv.qrr, amount: "100.00" }]));
      expect(await state(inv.id)).toEqual({ status: "paid", paid: 10000, open: 0, n: 1 });

      const file = camt([{ qrr: inv.qrr, amount: "100.00", reversal: true, date: "2026-11-03" }]);
      const r = await importer(ctxA).importFile(file);
      expect(r.import.counts).toMatchObject({ matched: 1, rest: 0 });
      expect(r.matched[0]).toMatchObject({ status: "MATCHED", openItemId: inv.id });
      expect(await state(inv.id)).toEqual({ status: "sent", paid: 0, open: 10000, n: 2 });
      expect(await itemOf(inv.customer, inv.number)).toMatchObject({
        allocated: 0,
        remaining: 10000,
        status: "open",
      });
      expect(await credits(inv.customer)).toEqual([]);
      expect((await accounting.reconcileDebtors(accA)).difference).toBe(0);
      expect((await accounting.verifyIntegrity(accA)).ok).toBe(true);
      const reversal = (await accounting.listEntries(accA, {}, { offset: 0, limit: 500 })).findLast(
        (e) => e.kind === "reversal" && e.lines.some((l) => l.personId === inv.customer),
      );
      expect(reversal).toMatchObject({ bookingDate: "2026-11-03", createdBy: userA });
      expect(reversal?.lines).toEqual([
        { accountCode: "1020", side: "credit", amount: 10000 },
        { accountCode: "1100", side: "debit", amount: 10000, personId: inv.customer },
      ]);

      // Idempotenz: dieselbe Datei und dieselbe Bankbuchung in einer anderen Datei buchen nichts doppelt.
      await expect(importer(ctxA).importFile(file)).rejects.toMatchObject({
        code: "DUPLICATE_FILE",
      });
      const again = await importer(ctxA).importFile(
        camt([
          {
            qrr: inv.qrr,
            amount: "100.00",
            reversal: true,
            date: "2026-11-03",
            ref: await camtRefOf(inv.qrr, true),
          },
        ]),
      );
      expect(again.import.counts).toMatchObject({ matched: 0, rest: 0, duplicates: 1 });
      expect(await state(inv.id)).toMatchObject({ n: 2, open: 10000 });
    });

    it("eine Rückbuchung ohne passende Zahlung bleibt Restposten und lässt sich nach der Zahlung zuordnen", async () => {
      const inv = await invoice(10000);
      const r = await importer(ctxA).importFile(
        camt([{ qrr: inv.qrr, amount: "40.00", reversal: true }]),
      );
      expect(r.rest[0]).toMatchObject({ status: "REST", restReason: "REVERSAL" });
      // Zuordnung ohne Zahlung: abgelehnt, nichts geschrieben.
      await expect(rest(ctxA).assign(r.rest[0]!.id, inv.id)).rejects.toMatchObject({
        code: "BOOKING_REJECTED",
      });
      expect(await state(inv.id)).toMatchObject({ n: 0, open: 10000 });

      const pay = await importer(ctxA).importFile(camt([{ qrr: inv.qrr, amount: "40.00" }]));
      await rest(ctxA).assign(pay.rest[0]!.id, inv.id);
      expect(await state(inv.id)).toMatchObject({ paid: 4000, n: 1 });
      await rest(ctxA).assign(r.rest[0]!.id, inv.id);
      expect(await state(inv.id)).toEqual({ status: "sent", paid: 0, open: 10000, n: 2 });
      expect(await itemOf(inv.customer, inv.number)).toMatchObject({
        allocated: 0,
        status: "open",
      });
      expect((await accounting.reconcileDebtors(accA)).difference).toBe(0);
    });

    it("gesperrte Periode lehnt die Rückbuchung ab: Restposten, nichts geschrieben; andere Periode geht", async () => {
      const accB = { tenantId: B, userId: userB };
      const inv = await invoice(10000, B, "2026-08-10");
      await importer(ctxB).importFile(
        camt([{ qrr: inv.qrr, amount: "100.00", date: "2026-08-12" }]),
      );
      await accounting.closePeriod(accB, "2026-08");

      const blocked = await importer(ctxB).importFile(
        camt([{ qrr: inv.qrr, amount: "100.00", reversal: true, date: "2026-08-20" }]),
      );
      expect(blocked.rest[0]).toMatchObject({ status: "REST", restReason: "BOOKING_REJECTED" });
      const afterBlocked = await invoices.get(B, inv.id);
      expect(afterBlocked).toMatchObject({ paidCents: 10000, openCents: 0 });
      expect(afterBlocked.invoice.payments).toHaveLength(1);
      expect(
        (
          await accounting.listOpenItems(
            accB,
            { personId: inv.customer, onlyOpen: false },
            { offset: 0, limit: 10 },
          )
        )[0],
      ).toMatchObject({ allocated: 10000, status: "paid" });

      const ok = await importer(ctxB).importFile(
        camt([{ qrr: inv.qrr, amount: "100.00", reversal: true, date: "2026-11-03" }]),
      );
      expect(ok.import.counts).toMatchObject({ matched: 1 });
      expect(await invoices.get(B, inv.id)).toMatchObject({ paidCents: 0, openCents: 10000 });
    });

    it("Mandantentrennung: Kunde B sieht die Zahlung von Kunde A nicht und bucht sie nicht zurück", async () => {
      const inv = await invoice(10000);
      await importer(ctxA).importFile(camt([{ qrr: inv.qrr, amount: "100.00" }]));
      // Kunde B bekommt einen Storno mit der Referenz von A: kein Ziel, Restposten.
      const r = await importer(ctxB).importFile(
        camt([{ qrr: inv.qrr, amount: "100.00", reversal: true }]),
      );
      expect(r.rest[0]).toMatchObject({ restReason: "REVERSAL" });
      await expect(rest(ctxB).assign(r.rest[0]!.id, inv.id)).rejects.toMatchObject({
        code: "OPEN_ITEM_NOT_FOUND",
      });
      expect(await state(inv.id)).toEqual({ status: "paid", paid: 10000, open: 0, n: 1 });
    });
  });
});
