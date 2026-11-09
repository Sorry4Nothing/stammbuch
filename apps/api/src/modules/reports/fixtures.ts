import type { LedgerData } from "./ledger-port.js";

/**
 * Tabellen-Fixture für Tests (erfundene Daten, SR-41). Beträge in Rappen.
 * Quartal 1/2026, MwSt 8.10 %:
 *   R-1 (D1) 1000.00 + 81.00, am 10.02. bezahlt
 *   R-2 (D2) 200.00 ohne MwSt, offen
 *   R-3 (D1) 500.00 + 40.50, offen; G-1 (D1) Gutschrift 100.00 + 8.10
 *   Aufwand 200.00 + 16.20 Vorsteuer, bezahlt per Bank
 * Erwartete Kontrollwerte: Debitoren 632.40, Bilanzsumme 11'513.40, Ergebnis 1'400.00.
 */
type L = [
  id: string,
  booking: string,
  date: string,
  account: string,
  side: "debit" | "credit",
  cents: number,
];

const lines = (rows: L[]): LedgerData["lines"] =>
  rows.map(([id, bookingId, date, accountId, side, amountCents]) => ({
    id,
    bookingId,
    date,
    accountId,
    side,
    amountCents,
    text: `Buchung ${bookingId}`,
  }));

export const fixture: LedgerData = {
  accounts: [
    { id: "a1020", number: "1020", name: "Bank", type: "asset" },
    { id: "a1100", number: "1100", name: "Debitoren", type: "asset", debtorControl: true },
    { id: "a1170", number: "1170", name: "Vorsteuer", type: "asset" },
    { id: "a2200", number: "2200", name: "Geschuldete MwSt", type: "liability" },
    { id: "a2800", number: "2800", name: "Vereinskapital", type: "equity" },
    { id: "a3000", number: "3000", name: "Mitgliederbeiträge", type: "revenue" },
    { id: "a3200", number: "3200", name: "Dienstleistungen", type: "revenue" },
    { id: "a4000", number: "4000", name: "Sachaufwand", type: "expense" },
  ],
  debtors: [
    { id: "d1", number: "10001", name: "Muster AG" },
    { id: "d2", number: "10002", name: "Beispiel Verein" },
  ],
  lines: lines([
    ["l01", "B1", "2026-01-01", "a1020", "debit", 1_000_000],
    ["l02", "B1", "2026-01-01", "a2800", "credit", 1_000_000],
    ["l03", "B2", "2026-01-15", "a1100", "debit", 108_100],
    ["l04", "B2", "2026-01-15", "a3200", "credit", 100_000],
    ["l05", "B2", "2026-01-15", "a2200", "credit", 8_100],
    ["l06", "B3", "2026-01-20", "a1100", "debit", 20_000],
    ["l07", "B3", "2026-01-20", "a3000", "credit", 20_000],
    ["l08", "B4", "2026-02-10", "a1020", "debit", 108_100],
    ["l09", "B4", "2026-02-10", "a1100", "credit", 108_100],
    ["l10", "B5", "2026-02-20", "a1100", "debit", 54_050],
    ["l11", "B5", "2026-02-20", "a3200", "credit", 50_000],
    ["l12", "B5", "2026-02-20", "a2200", "credit", 4_050],
    ["l13", "B6", "2026-02-25", "a4000", "debit", 20_000],
    ["l14", "B6", "2026-02-25", "a1170", "debit", 1_620],
    ["l15", "B6", "2026-02-25", "a1020", "credit", 21_620],
    ["l16", "B7", "2026-03-05", "a3200", "debit", 10_000],
    ["l17", "B7", "2026-03-05", "a2200", "debit", 810],
    ["l18", "B7", "2026-03-05", "a1100", "credit", 10_810],
  ]),
  openItems: [
    {
      id: "p1",
      debtorId: "d1",
      reference: "R-1",
      issueDate: "2026-01-15",
      dueDate: "2026-02-14",
      amountCents: 108_100,
      settlements: [{ date: "2026-02-10", amountCents: 108_100 }],
    },
    {
      id: "p2",
      debtorId: "d2",
      reference: "R-2",
      issueDate: "2026-01-20",
      dueDate: "2026-02-19",
      amountCents: 20_000,
      settlements: [],
    },
    {
      id: "p3",
      debtorId: "d1",
      reference: "R-3",
      issueDate: "2026-02-20",
      dueDate: "2026-03-22",
      amountCents: 54_050,
      settlements: [],
    },
    {
      id: "p4",
      debtorId: "d1",
      reference: "G-1",
      issueDate: "2026-03-05",
      dueDate: "2026-03-05",
      amountCents: -10_810,
      settlements: [],
    },
  ],
  vat: [
    {
      bookingId: "B2",
      date: "2026-01-15",
      kind: "output",
      rateBp: 810,
      netCents: 100_000,
      taxCents: 8_100,
    },
    {
      bookingId: "B3",
      date: "2026-01-20",
      kind: "output",
      rateBp: 0,
      netCents: 20_000,
      taxCents: 0,
      origin: "contributions",
    },
    {
      bookingId: "B5",
      date: "2026-02-20",
      kind: "output",
      rateBp: 810,
      netCents: 50_000,
      taxCents: 4_050,
    },
    {
      bookingId: "B6",
      date: "2026-02-25",
      kind: "input",
      rateBp: 810,
      netCents: 20_000,
      taxCents: 1_620,
    },
    {
      bookingId: "B7",
      date: "2026-03-05",
      kind: "output",
      rateBp: 810,
      netCents: -10_000,
      taxCents: -810,
    },
  ],
};
