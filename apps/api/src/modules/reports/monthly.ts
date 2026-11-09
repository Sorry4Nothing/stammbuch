import type { LedgerReadPort } from "./ledger-port.js";
import { sumCents } from "./money.js";
import type { Cents } from "./money.js";
import { LedgerInconsistencyError } from "./reports.js";

/** Ergebnis je Kalendermonat für das Dashboard der Auswertungen. */

export interface MonthlyRow {
  /** Monat als `YYYY-MM`. */
  month: string;
  revenueCents: Cents;
  expenseCents: Cents;
  resultCents: Cents;
  /** Rechnungen (positiv) und Gutschriften (negativ) mit Rechnungsdatum im Monat. */
  invoicedCents: Cents;
  /** Zahlungen, Gutschriften und Skonti, die im Monat auf offene Posten zugeordnet wurden. */
  settledCents: Cents;
}

export interface MonthlyReport {
  from: string;
  to: string;
  rows: MonthlyRow[];
  totals: {
    revenueCents: Cents;
    expenseCents: Cents;
    resultCents: Cents;
    invoicedCents: Cents;
    settledCents: Cents;
  };
}

/** Obergrenze des Zeitraums in Monaten: schützt vor unnötig grossen Antworten. */
export const MONTHLY_MAX_MONTHS = 36;

/** Anzahl Kalendermonate von `from` bis `to` (beide eingeschlossen). */
export const monthSpan = (from: string, to: string): number =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
  Number(to.slice(5, 7)) -
  Number(from.slice(5, 7)) +
  1;

/** Ertrag, Aufwand, Ergebnis sowie Fakturiert und Beglichen je Kalendermonat; Monate ohne Buchung stehen mit 0 drin. */
export async function monthlyReport(
  ledger: LedgerReadPort,
  tenantId: string,
  q: { from: string; to: string },
): Promise<MonthlyReport> {
  const [accounts, lines, items] = await Promise.all([
    ledger.listAccounts(tenantId),
    ledger.listJournalLines(tenantId, q),
    ledger.listOpenItems(tenantId, q.to),
  ]);
  const types = new Map(accounts.map((a) => [a.id, a.type]));
  const byMonth = new Map<string, MonthlyRow>();
  let y = Number(q.from.slice(0, 4));
  let m = Number(q.from.slice(5, 7));
  for (let n = monthSpan(q.from, q.to); n > 0; n--) {
    const month = `${y}-${String(m).padStart(2, "0")}`;
    byMonth.set(month, {
      month,
      revenueCents: 0,
      expenseCents: 0,
      resultCents: 0,
      invoicedCents: 0,
      settledCents: 0,
    });
    if (++m > 12) [y, m] = [y + 1, 1];
  }
  for (const l of lines) {
    const type = types.get(l.accountId);
    if (!type) throw new LedgerInconsistencyError("Unbekanntes Konto.");
    const row = byMonth.get(l.date.slice(0, 7));
    if (!row || (type !== "revenue" && type !== "expense")) continue;
    const debit = l.side === "debit" ? l.amountCents : -l.amountCents;
    if (type === "revenue") row.revenueCents -= debit;
    else row.expenseCents += debit;
  }
  for (const i of items) {
    if (i.issueDate >= q.from) {
      const issued = byMonth.get(i.issueDate.slice(0, 7));
      if (issued) issued.invoicedCents += i.amountCents;
    }
    for (const s of i.settlements) {
      if (s.date < q.from || s.date > q.to) continue;
      const row = byMonth.get(s.date.slice(0, 7));
      if (row) row.settledCents += s.amountCents;
    }
  }
  const rows = [...byMonth.values()].map((r) => ({
    ...r,
    resultCents: r.revenueCents - r.expenseCents,
  }));
  const sum = (pick: (r: MonthlyRow) => Cents) => sumCents(rows.map(pick));
  return {
    from: q.from,
    to: q.to,
    rows,
    totals: {
      revenueCents: sum((r) => r.revenueCents),
      expenseCents: sum((r) => r.expenseCents),
      resultCents: sum((r) => r.resultCents),
      invoicedCents: sum((r) => r.invoicedCents),
      settledCents: sum((r) => r.settledCents),
    },
  };
}

export const monthlyTable = (r: MonthlyReport) => ({
  title: `Ergebnis je Monat ${r.from} bis ${r.to}`,
  columns: [
    { label: "Monat", type: "text" as const },
    { label: "Ertrag", type: "money" as const },
    { label: "Aufwand", type: "money" as const },
    { label: "Ergebnis", type: "money" as const },
    { label: "Fakturiert", type: "money" as const },
    { label: "Beglichen", type: "money" as const },
  ],
  rows: [
    ...r.rows.map((x) => [
      x.month,
      x.revenueCents,
      x.expenseCents,
      x.resultCents,
      x.invoicedCents,
      x.settledCents,
    ]),
    [
      "Total",
      r.totals.revenueCents,
      r.totals.expenseCents,
      r.totals.resultCents,
      r.totals.invoicedCents,
      r.totals.settledCents,
    ],
  ],
});
