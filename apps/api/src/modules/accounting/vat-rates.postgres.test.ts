import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { PeriodService } from "../reports/periods.js";
import { createPostgresPeriodStore } from "../reports/periods-postgres.js";
import { vatCheck, vatReport } from "../reports/reports.js";
import { createPostgresLedger } from "./ledger-read.js";
import { createPostgresStore } from "./postgres-store.js";
import { KUNDE_A, KUNDE_B, closeAll, createDatabase } from "./postgres.test-support.js";
import { AccountingService } from "./service.js";

afterAll(closeAll);

// Erfundene Daten (SR-41). MwSt mit Steuersatz am Konto (#131): März 2026.
const A = { tenantId: KUNDE_A, userId: "u-a" };
let seq = 0;
const key = () => `key-${(seq++).toString().padStart(8, "0")}`;
const q = { from: "2026-03-01", to: "2026-03-31", method: "effective" as const };

async function setup() {
  const { db } = await createDatabase();
  let now = new Date("2026-03-01T10:00:00Z");
  const svc = new AccountingService(createPostgresStore(db), () => now);
  const ledger = createPostgresLedger(db);
  for (const [code, taxRateBp] of [
    ["3200", 810],
    ["3400", 260],
    ["2200", 810],
    ["2201", 260],
  ] as const) {
    await svc.updateAccount(A, code, { taxRateBp });
  }
  const invoice = (reference: string, date: string, counter: [string, number][]) =>
    svc.postReceivable(A, {
      idempotencyKey: key(),
      kind: "invoice",
      personId: "p1",
      reference,
      bookingDate: date,
      dueDate: "2026-12-31",
      counterLines: counter.map(([accountCode, amount]) => ({ accountCode, amount })),
    });
  const at = (d: string) => void (now = new Date(`${d}T10:00:00Z`));
  return { db, svc, ledger, invoice, at };
}

describe("MwSt mit Steuersatz am Konto (#131)", () => {
  it("Zeilen halten den Satz fest; die Abrechnung weist Umsatz und Steuerkonto je Satz aus", async () => {
    const { db, ledger, invoice } = await setup();
    await invoice("R-1", "2026-03-05", [
      ["3200", 100_000],
      ["3400", 20_000],
      ["2200", 8_100],
      ["2201", 520],
    ]);
    const { rows } = await db.withKunde(KUNDE_A, (trx) =>
      sql<{ konto_nummer: string; steuersatz_bp: number | null }>`
        SELECT konto_nummer, steuersatz_bp FROM buchhaltung_buchungszeile
        WHERE kunde_id = ${KUNDE_A}`.execute(trx),
    );
    expect(Object.fromEntries(rows.map((r) => [r.konto_nummer, r.steuersatz_bp]))).toEqual({
      "1100": null,
      "3200": 810,
      "3400": 260,
      "2200": 810,
      "2201": 260,
    });

    const vat = await vatReport(ledger, KUNDE_A, q);
    expect(vat.rows.map((r) => [r.kind, r.rateBp, r.netCents, r.taxCents, r.account])).toEqual([
      ["output", 810, 100_000, 8_100, "2200"],
      ["output", 260, 20_000, 520, "2201"],
    ]);
    expect(vat.totals).toMatchObject({
      turnoverCents: 120_000,
      untaxedCents: 0,
      outputTaxCents: 8_620,
    });
    expect(await vatCheck(ledger, KUNDE_A, q)).toMatchObject({
      active: true,
      payableCents: 8_620,
      accountsCents: 8_620,
      differenceCents: 0,
    });
  });

  it("Gegenbuchung hebt Umsatz und Steuer auf, auch wenn das Konto den Satz inzwischen nicht mehr trägt", async () => {
    const { svc, ledger, invoice, at } = await setup();
    const { result } = await invoice("R-1", "2026-03-05", [
      ["3200", 100_000],
      ["2200", 8_100],
    ]);
    await svc.updateAccount(A, "3200", { taxRateBp: null });
    at("2026-03-10");
    await svc.reverseEntry(A, result.entry.id, {
      idempotencyKey: key(),
      bookingDate: "2026-03-10",
      reason: "Irrtum",
    });
    const vat = await vatReport(ledger, KUNDE_A, q);
    expect(vat.rows.map((r) => [r.rateBp, r.netCents, r.taxCents])).toEqual([[810, 0, 0]]);
    expect((await svc.verifyIntegrity(A)).ok).toBe(true);
  });

  it("Steuer auf 2200 ohne Satz am Konto folgt dem einzigen Erlössatz; Erlös ohne Satz bleibt Umsatz ohne Steuer", async () => {
    const { svc, ledger, invoice } = await setup();
    await svc.updateAccount(A, "2200", { taxRateBp: null });
    await invoice("R-1", "2026-03-05", [
      ["3200", 100_000],
      ["2200", 8_100],
    ]);
    await invoice("R-2", "2026-03-06", [["3000", 20_000]]);
    const vat = await vatReport(ledger, KUNDE_A, q);
    expect(vat.rows.map((r) => [r.rateBp, r.netCents, r.taxCents])).toEqual([
      [810, 100_000, 8_100],
      [0, 20_000, 0],
    ]);
  });

  it("Umsatzüberleitung: Beiträge, Mahngebühren und Gutschriften aus den Buchungen", async () => {
    const { svc, ledger, invoice, at } = await setup();
    await invoice("R-1", "2026-03-05", [["3000", 20_000]]);
    await invoice("R-2", "2026-03-05", [
      ["3400", 50_000],
      ["2201", 1_300],
    ]);
    at("2026-03-12");
    await svc.postManualEntry(A, {
      idempotencyKey: key(),
      bookingDate: "2026-03-12",
      description: "Mahngebühr",
      lines: [
        { accountCode: "1020", side: "debit", amount: 1_000 },
        { accountCode: "3600", side: "credit", amount: 1_000 },
      ],
    });
    await svc.postReceivable(A, {
      idempotencyKey: key(),
      kind: "credit_note",
      personId: "p1",
      reference: "G-1",
      bookingDate: "2026-03-13",
      counterLines: [{ accountCode: "3000", amount: 3_000 }],
    });
    const vat = await vatReport(ledger, KUNDE_A, q);
    expect(vat.totals.untaxedBreakdown).toEqual({
      contributionsCents: 20_000,
      dunningFeesCents: 1_000,
      creditNotesCents: -3_000,
      otherCents: 0,
    });
    expect(vat.totals.turnoverCents).toBe(20_000 + 50_000 + 1_000 - 3_000);
    expect(vat.totals.untaxedCents).toBe(18_000);
    expect(vat.rows.find((r) => r.rateBp === 260)).toMatchObject({
      netCents: 50_000,
      taxCents: 1_300,
      account: "2201",
    });
  });

  it("Mandant B sieht den Satz von A nicht", async () => {
    const { svc, ledger } = await setup();
    expect(
      (await svc.listAccounts({ tenantId: KUNDE_B, userId: "u-b" })).find((a) => a.code === "3200")
        ?.taxRateBp,
    ).toBeUndefined();
    expect(
      (await ledger.listAccounts(KUNDE_B)).find((a) => a.number === "3200")?.taxRateBp,
    ).toBeUndefined();
    expect((await ledger.listAccounts(KUNDE_A)).find((a) => a.number === "3200")?.taxRateBp).toBe(
      810,
    );
  });

  it("die Datenbank verweigert ungültige Sätze und Sätze auf Eigenkapital", async () => {
    const { db } = await setup();
    const update = (nummer: string, satz: number) =>
      db.withKunde(KUNDE_A, (trx) =>
        sql`UPDATE buchhaltung_konto SET steuersatz_bp = ${satz} WHERE kunde_id = ${KUNDE_A} AND nummer = ${nummer}`.execute(
          trx,
        ),
      );
    await expect(update("3200", 700)).rejects.toThrow();
    await expect(update("2800", 810)).rejects.toThrow();
    await expect(update("3200", 380)).resolves.toBeDefined();
  });

  it("Bestätigung der Abrechnung wird je Periode gespeichert, gilt nur für den bestätigten Stand und friert beim Abschluss ein", async () => {
    const { db, ledger, invoice } = await setup();
    const store = createPostgresPeriodStore(db);
    const periods = new PeriodService({
      ledger,
      store,
      now: () => new Date("2026-04-02T08:00:00Z"),
    });
    const march = await periods.create(KUNDE_A, {
      label: "März 2026",
      from: "2026-03-01",
      to: "2026-03-31",
    });
    await invoice("R-1", "2026-03-05", [
      ["3200", 100_000],
      ["2200", 8_100],
    ]);

    const first = await periods.runCheck(KUNDE_A, march.id, "u-a");
    expect(first.issues.map((i) => i.code)).toEqual(["VAT_NOT_CONFIRMED"]);

    const confirmed = await periods.setVatConfirmation(KUNDE_A, march.id, "u-a", true);
    expect(confirmed.issues).toEqual([]);
    expect((await store.get(KUNDE_A, march.id))?.vatConfirmation).toEqual({
      at: "2026-04-02T08:00:00.000Z",
      actor: "u-a",
      turnoverCents: 100_000,
      outputTaxCents: 8_100,
      inputTaxCents: 0,
    });
    // Anderer Mandant: Periode unbekannt.
    await expect(periods.setVatConfirmation(KUNDE_B, march.id, "u-b", true)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    // Neue MwSt-Buchung: die Bestätigung gilt nicht mehr.
    await invoice("R-2", "2026-03-20", [
      ["3200", 10_000],
      ["2200", 810],
    ]);
    const stale = await periods.runCheck(KUNDE_A, march.id, "u-a");
    expect(stale.issues.map((i) => i.code)).toEqual(["VAT_NOT_CONFIRMED"]);

    await periods.setVatConfirmation(KUNDE_A, march.id, "u-a", true);
    const closed = await periods.confirm(KUNDE_A, march.id, "u-a");
    expect(closed.state).toBe("closed");
    expect(closed.vatConfirmation?.outputTaxCents).toBe(8_910);
    await expect(periods.setVatConfirmation(KUNDE_A, march.id, "u-a", false)).rejects.toMatchObject(
      { code: "INVALID_STATE" },
    );
    await expect(
      db.withKunde(KUNDE_A, (trx) =>
        sql`UPDATE auswertung_periode SET mwst_bestaetigung = NULL, version = version + 1
            WHERE kunde_id = ${KUNDE_A}`.execute(trx),
      ),
    ).rejects.toThrow(/unveränderlich/);
  });
});
