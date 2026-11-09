import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  balanceSheetReport,
  debtorsReport,
  incomeStatementReport,
  openItemsReport,
  trialBalanceReport,
  vatReport,
} from "../reports/reports.js";
import { InMemoryPeriodStore, PeriodService } from "../reports/periods.js";
import { createPostgresStore } from "./postgres-store.js";
import { createPostgresLedger } from "./ledger-read.js";
import { KUNDE_A, KUNDE_B, closeAll, createDatabase } from "./postgres.test-support.js";
import { AccountingService } from "./service.js";

afterAll(closeAll);

// Erfundene Daten (SR-41). Quartal 1/2026, MwSt 8.10 %:
//   R-1 (p1) 1000.00 + 81.00, am 10.02. bezahlt, am 11.02. zugeordnet
//   R-2 (p2) 200.00 ohne MwSt, offen
//   R-3 (p1) 500.00 + 40.50, offen
//   G-1 (p1) Gutschrift 100.00 + 8.10 (nicht zugeordnet)
//   Aufwand 200.00 + 16.20 Vorsteuer, per Bank bezahlt
const A = { tenantId: KUNDE_A, userId: "u-a" };
const B = { tenantId: KUNDE_B, userId: "u-b" };
let seq = 0;
const key = () => `key-${(seq++).toString().padStart(8, "0")}`;

async function setup() {
  const { db } = await createDatabase();
  let now = new Date("2026-01-01T10:00:00Z");
  const svc = new AccountingService(createPostgresStore(db), () => now);
  const at = (d: string) => {
    now = new Date(`${d}T10:00:00Z`);
  };
  const ledger = createPostgresLedger(db);

  const receivable = (
    ctx: typeof A,
    kind: "invoice" | "credit_note",
    personId: string,
    reference: string,
    bookingDate: string,
    counter: [string, number][],
  ) =>
    svc.postReceivable(ctx, {
      idempotencyKey: key(),
      kind,
      personId,
      reference,
      bookingDate,
      ...(kind === "invoice" ? { dueDate: "2026-12-31" } : {}),
      counterLines: counter.map(([accountCode, amount]) => ({ accountCode, amount })),
    });

  await svc.postManualEntry(A, {
    idempotencyKey: key(),
    bookingDate: "2026-01-01",
    description: "Eröffnung",
    lines: [
      { accountCode: "1020", side: "debit", amount: 1_000_000 },
      { accountCode: "2800", side: "credit", amount: 1_000_000 },
    ],
  });
  const r1 = await receivable(A, "invoice", "p1", "R-1", "2026-01-15", [
    ["3400", 100_000],
    ["2200", 8_100],
  ]);
  const r2 = await receivable(A, "invoice", "p2", "R-2", "2026-01-20", [["3000", 20_000]]);
  at("2026-02-10");
  const pay = await svc.bookPayment(A, {
    idempotencyKey: key(),
    personId: "p1",
    bankAccountCode: "1020",
    valueDate: "2026-02-10",
    amount: 108_100,
    reference: "Z-1",
  });
  at("2026-02-11");
  await svc.allocate(A, {
    idempotencyKey: key(),
    creditId: pay.result.credit.id,
    allocations: [{ openItemId: r1.result.openItem!.id, amount: 108_100 }],
  });
  await receivable(A, "invoice", "p1", "R-3", "2026-02-20", [
    ["3400", 50_000],
    ["2200", 4_050],
  ]);
  await svc.postManualEntry(A, {
    idempotencyKey: key(),
    bookingDate: "2026-02-25",
    description: "Aufwand",
    lines: [
      { accountCode: "6940", side: "debit", amount: 20_000 },
      { accountCode: "1170", side: "debit", amount: 1_620 },
      { accountCode: "1020", side: "credit", amount: 21_620 },
    ],
  });
  await receivable(A, "credit_note", "p1", "G-1", "2026-03-05", [
    ["3800", 10_000],
    ["2200", 810],
  ]);

  // Anderer Mandant: darf in keiner Auswertung von A auftauchen.
  await receivable(B, "invoice", "p9", "B-1", "2026-01-10", [
    ["3400", 777_700],
    ["2200", 63_000],
  ]);
  return { db, svc, at, ledger, r1, r2 };
}

describe("Ledger-Adapter auf den Buchhaltungs-Tabellen", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    s = await setup();
  });

  it("liefert Konten und Buchungszeilen des Mandanten, geordnet und in Rappen", async () => {
    const accounts = await s.ledger.listAccounts(KUNDE_A);
    expect(accounts.find((a) => a.number === "1100")?.debtorControl).toBe(true);
    expect(accounts.filter((a) => a.debtorControl)).toHaveLength(1);

    const lines = await s.ledger.listJournalLines(KUNDE_A, { to: "2026-03-31" });
    expect(lines).toHaveLength(18);
    expect(lines.map((l) => l.date)).toEqual([...lines.map((l) => l.date)].sort());
    expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length);
    expect(lines.every((l) => Number.isSafeInteger(l.amountCents) && l.amountCents > 0)).toBe(true);

    const feb = await s.ledger.listJournalLines(KUNDE_A, { from: "2026-02-01", to: "2026-02-28" });
    expect(feb.every((l) => l.date >= "2026-02-01" && l.date <= "2026-02-28")).toBe(true);
    expect(feb).toHaveLength(8);
  });

  it("trennt Mandanten: B sieht nichts von A und umgekehrt", async () => {
    const [aLines, bLines] = await Promise.all([
      s.ledger.listJournalLines(KUNDE_A, { to: "2026-12-31" }),
      s.ledger.listJournalLines(KUNDE_B, { to: "2026-12-31" }),
    ]);
    expect(bLines).toHaveLength(3);
    expect(new Set(aLines.map((l) => l.bookingId))).not.toContain(bLines[0]?.bookingId);

    expect((await s.ledger.listDebtors(KUNDE_B)).map((d) => d.id)).toEqual(["p9"]);
    expect((await s.ledger.listDebtors(KUNDE_A)).map((d) => d.id)).toEqual(["p1", "p2"]);
    // Ohne Mitglied oder Firma gibt es weder Nummer noch Namen; die Personen-ID taucht nicht auf.
    expect((await s.ledger.listDebtors(KUNDE_A))[0]).toMatchObject({
      number: "",
      name: "Unbekannt",
    });
    expect((await s.ledger.listOpenItems(KUNDE_B, "2026-12-31")).map((i) => i.reference)).toEqual([
      "B-1",
    ]);
    expect(
      (
        await vatReport(s.ledger, KUNDE_B, {
          from: "2026-01-01",
          to: "2026-12-31",
          method: "effective",
        })
      ).totals.outputTaxCents,
    ).toBe(63_000);
    // Unbekannter Mandant: leer, kein Fehler.
    const none = "33333333-3333-4333-8333-333333333333";
    expect(await s.ledger.listAccounts(none)).toEqual([]);
    expect(await s.ledger.listJournalLines(none, { to: "2026-12-31" })).toEqual([]);
  });

  it("Saldenliste, Bilanz und Erfolgsrechnung stimmen mit den Buchungen überein", async () => {
    const tb = await trialBalanceReport(s.ledger, KUNDE_A, {
      from: "2026-01-01",
      to: "2026-03-31",
    });
    expect(tb.totals.balanced).toBe(true);
    const bs = await balanceSheetReport(s.ledger, KUNDE_A, { asOf: "2026-03-31" });
    expect(bs.totals.balanced).toBe(true);
    expect(bs.totals.assetsCents).toBe(1_151_340);
    expect(bs.totals.differenceCents).toBe(0);
    const is = await incomeStatementReport(s.ledger, KUNDE_A, {
      from: "2026-01-01",
      to: "2026-03-31",
    });
    expect(is.totals.resultCents).toBe(140_000);
  });

  it("Debitoren: Nebenbuch entspricht dem Sammelkonto an jedem Stichtag", async () => {
    for (const asOf of [
      "2026-01-14",
      "2026-01-31",
      "2026-02-10",
      "2026-02-11",
      "2026-02-28",
      "2026-03-31",
    ]) {
      const d = await debtorsReport(s.ledger, KUNDE_A, { asOf });
      expect(d.totals.differenceCents, asOf).toBe(0);
    }
    const q1 = await debtorsReport(s.ledger, KUNDE_A, { asOf: "2026-03-31" });
    expect(q1.totals.controlAccountCents).toBe(54_050 + 20_000 - 10_810);
    expect(q1.rows.map((r) => [r.debtorId, r.openCents])).toEqual([
      ["p1", 54_050 - 10_810],
      ["p2", 20_000],
    ]);
    // Zahlung am 10.02., Zuordnung erst am 11.02.: dazwischen offene Rechnung und Guthaben gleichen sich aus.
    const mid = await openItemsReport(s.ledger, KUNDE_A, { asOf: "2026-02-10" });
    expect(mid.rows.map((r) => [r.reference, r.openCents])).toEqual([
      ["Z-1", -108_100],
      ["R-1", 108_100],
      ["R-2", 20_000],
    ]);
    const end = await openItemsReport(s.ledger, KUNDE_A, { asOf: "2026-03-31", debtorId: "p1" });
    expect(end.rows.map((r) => [r.reference, r.openCents])).toEqual([
      ["G-1", -10_810],
      ["R-3", 54_050],
    ]);
  });

  it("stornierte Belege fallen erst ab dem Stornodatum weg", async () => {
    const { db } = await createDatabase();
    let now = new Date("2026-03-01T10:00:00Z");
    const svc = new AccountingService(createPostgresStore(db), () => now);
    const { result } = await svc.postReceivable(A, {
      idempotencyKey: key(),
      kind: "invoice",
      personId: "p1",
      reference: "R-X",
      bookingDate: "2026-03-01",
      dueDate: "2026-03-31",
      counterLines: [{ accountCode: "3000", amount: 5_000 }],
    });
    now = new Date("2026-04-01T10:00:00Z");
    await svc.reverseEntry(A, result.entry.id, {
      idempotencyKey: key(),
      bookingDate: "2026-04-01",
      reason: "Irrtum",
    });
    const ledger = createPostgresLedger(db);
    expect((await openItemsReport(ledger, KUNDE_A, { asOf: "2026-03-31" })).rows).toHaveLength(1);
    expect((await openItemsReport(ledger, KUNDE_A, { asOf: "2026-04-01" })).rows).toHaveLength(0);
    for (const asOf of ["2026-03-31", "2026-04-01"]) {
      expect((await debtorsReport(ledger, KUNDE_A, { asOf })).totals.differenceCents, asOf).toBe(0);
    }
  });

  it("MwSt-Abrechnung aus den Buchungen: Umsatz, Vorsteuer, Gutschrift, Satz 0 %", async () => {
    const vat = await vatReport(s.ledger, KUNDE_A, {
      from: "2026-01-01",
      to: "2026-03-31",
      method: "effective",
    });
    expect(vat.rows.map((r) => [r.kind, r.rateBp, r.netCents, r.taxCents])).toEqual([
      ["output", 810, 140_000, 11_340],
      ["output", 0, 20_000, 0],
      ["input", 810, 20_000, 1_620],
    ]);
    expect(vat.totals.outputTaxCents).toBe(8_100 + 4_050 - 810);
    expect(vat.totals.inputTaxCents).toBe(1_620);
    expect(vat.totals.payableCents).toBe(8_100 + 4_050 - 810 - 1_620);
    expect(vat.rows.every((r) => r.differenceCents === 0)).toBe(true);
  });
});

describe("Periodenabschluss gegen echte Buchungen", () => {
  it("prüft, bestätigt und merkt Buchungen nach der Prüfung", async () => {
    const { svc, ledger, at } = await setup();
    const periods = new PeriodService({ ledger, store: new InMemoryPeriodStore() });
    const q1 = await periods.create(KUNDE_A, {
      label: "Q1 2026",
      from: "2026-01-01",
      to: "2026-03-31",
    });

    const checked = await periods.runCheck(KUNDE_A, q1.id, "u-a");
    expect(checked.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(checked.state).toBe("checked");

    // Eine Buchung nach der Prüfung (die Buchhaltung sperrt nur abgeschlossene Monate) macht die Prüfung ungültig.
    at("2026-03-20");
    await svc.postReceivable(A, {
      idempotencyKey: key(),
      kind: "invoice",
      personId: "p2",
      reference: "R-9",
      bookingDate: "2026-03-20",
      dueDate: "2026-04-20",
      counterLines: [{ accountCode: "3000", amount: 1_000 }],
    });
    await expect(periods.confirm(KUNDE_A, q1.id, "u-a")).rejects.toMatchObject({
      code: "STALE_CHECK",
    });
    expect((await periods.list(KUNDE_A))[0]?.state).toBe("open");

    const again = await periods.runCheck(KUNDE_A, q1.id, "u-a");
    expect(again.state).toBe("checked");
    expect((await periods.confirm(KUNDE_A, q1.id, "u-a")).state).toBe("closed");

    // Perioden sind je Mandant getrennt: B kennt Q1 von A nicht und kann sie nicht prüfen.
    expect(await periods.list(KUNDE_B)).toEqual([]);
    await expect(periods.runCheck(KUNDE_B, q1.id, "u-b")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("Prüfung des anderen Mandanten sieht dessen Buchungen, nicht die von A", async () => {
    const { ledger } = await setup();
    const periods = new PeriodService({ ledger, store: new InMemoryPeriodStore() });
    const p = await periods.create(KUNDE_B, {
      label: "Q1 2026",
      from: "2026-01-01",
      to: "2026-03-31",
    });
    const checked = await periods.runCheck(KUNDE_B, p.id, "u-b");
    expect(checked.state).toBe("checked");
    const lines = await ledger.listJournalLines(KUNDE_B, { to: "2026-03-31" });
    expect(lines.reduce((sum, l) => sum + l.amountCents, 0)).toBe(2 * (777_700 + 63_000));
  });
});
