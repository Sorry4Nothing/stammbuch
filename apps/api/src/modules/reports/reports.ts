import type { Account, AccountType, JournalLine, LedgerReadPort } from "./ledger-port.js";
import { applyRateBp, daysBetween, sumCents } from "./money.js";
import type { Cents } from "./money.js";

/** Ein Buchungssatz verweist auf ein unbekanntes Konto: Daten kaputt, Auswertung verweigert (SR-54). */
export class LedgerInconsistencyError extends Error {}

const num = (a: string, b: string) => a.localeCompare(b, "de", { numeric: true });
const byNumber = (a: { number: string }, b: { number: string }) => num(a.number, b.number);

/** Soll und Haben je Konto. */
function totals(lines: Iterable<JournalLine>, accounts: Map<string, Account>) {
  const m = new Map<string, { debit: Cents; credit: Cents }>();
  for (const l of lines) {
    if (!accounts.has(l.accountId)) throw new LedgerInconsistencyError("Unbekanntes Konto.");
    const e = m.get(l.accountId) ?? { debit: 0, credit: 0 };
    if (l.side === "debit") e.debit += l.amountCents;
    else e.credit += l.amountCents;
    m.set(l.accountId, e);
  }
  return m;
}

const accountMap = (accounts: Account[]) => new Map(accounts.map((a) => [a.id, a]));
/** Saldo, Soll positiv. */
const net = (e?: { debit: Cents; credit: Cents }) => (e ? e.debit - e.credit : 0);

// ---------------------------------------------------------------- Offene Posten

export const BUCKETS = ["notDue", "d1_30", "d31_60", "d61_90", "d90plus"] as const;
export type Bucket = (typeof BUCKETS)[number];

export function bucketOf(daysOverdue: number): Bucket {
  if (daysOverdue <= 0) return "notDue";
  if (daysOverdue <= 30) return "d1_30";
  if (daysOverdue <= 60) return "d31_60";
  if (daysOverdue <= 90) return "d61_90";
  return "d90plus";
}

export interface OpenItemRow {
  itemId: string;
  debtorId: string;
  /** Höchste Mahnstufe der Rechnung zum Stichtag; fehlt, wenn die Quelle sie nicht kennt. */
  dunningLevel?: number;
  debtorNumber: string;
  debtorName: string;
  reference: string;
  issueDate: string;
  dueDate: string;
  amountCents: Cents;
  paidCents: Cents;
  openCents: Cents;
  daysOverdue: number;
  bucket: Bucket;
}

export interface OpenItemsReport {
  asOf: string;
  rows: OpenItemRow[];
  totals: { count: number; openCents: Cents; byBucket: Record<Bucket, Cents> };
}

export interface OpenItemsQuery {
  asOf: string;
  debtorId?: string | undefined;
  overdueOnly?: boolean | undefined;
}

/** Offener Betrag je Posten zum Stichtag: Zuordnungen nach dem Stichtag zählen nicht. */
async function openItemRows(ledger: LedgerReadPort, tenantId: string, asOf: string) {
  const [items, debtors] = await Promise.all([
    ledger.listOpenItems(tenantId, asOf),
    ledger.listDebtors(tenantId),
  ]);
  const dm = new Map(debtors.map((d) => [d.id, d]));
  const rows: (OpenItemRow & { accountId?: string })[] = [];
  for (const i of items) {
    if (i.issueDate > asOf) continue;
    const paid = sumCents(i.settlements.filter((s) => s.date <= asOf).map((s) => s.amountCents));
    const open = i.amountCents - paid;
    if (open === 0) continue;
    const daysOverdue = Math.max(0, daysBetween(i.dueDate, asOf));
    const d = dm.get(i.debtorId);
    rows.push({
      itemId: i.id,
      debtorId: i.debtorId,
      ...(i.dunningLevel !== undefined ? { dunningLevel: i.dunningLevel } : {}),
      ...(i.accountId !== undefined ? { accountId: i.accountId } : {}),
      debtorNumber: d?.number ?? i.debtorId,
      debtorName: d?.name ?? "Unbekannt",
      reference: i.reference,
      issueDate: i.issueDate,
      dueDate: i.dueDate,
      amountCents: i.amountCents,
      paidCents: paid,
      openCents: open,
      daysOverdue,
      bucket: bucketOf(daysOverdue),
    });
  }
  rows.sort(
    (a, b) =>
      num(a.debtorNumber, b.debtorNumber) ||
      a.dueDate.localeCompare(b.dueDate) ||
      num(a.reference, b.reference),
  );
  return rows;
}

export async function openItemsReport(
  ledger: LedgerReadPort,
  tenantId: string,
  q: OpenItemsQuery,
): Promise<OpenItemsReport> {
  const all = await openItemRows(ledger, tenantId, q.asOf);
  const rows: OpenItemRow[] = all
    .filter(
      (r) => (!q.debtorId || r.debtorId === q.debtorId) && (!q.overdueOnly || r.daysOverdue > 0),
    )
    .map(({ accountId: _account, ...row }) => row);
  const byBucket = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, Cents>;
  for (const r of rows) byBucket[r.bucket] += r.openCents;
  return {
    asOf: q.asOf,
    rows,
    totals: { count: rows.length, openCents: sumCents(rows.map((r) => r.openCents)), byBucket },
  };
}

// ---------------------------------------------------------------- Debitorenliste

export interface DebtorRow {
  debtorId: string;
  number: string;
  name: string;
  itemCount: number;
  openCents: Cents;
  overdueCents: Cents;
  /** Älteste Fälligkeit unter den Posten mit offenem Betrag. */
  oldestDueDate: string;
  /** Firma oder Person; fehlt, wenn die Quelle die Art nicht kennt. */
  type?: "company" | "person";
  /** Höchste Mahnstufe unter den offenen Posten (0 = nicht gemahnt); fehlt, wenn die Quelle sie nicht kennt. */
  dunningLevel?: number;
}

export interface DebtorAccountSummary {
  number: string;
  name: string;
  debtors: number;
  items: number;
  balanceCents: Cents;
}

export interface DebtorsReport {
  asOf: string;
  rows: DebtorRow[];
  /** Aufteilung nach Debitoren-Sammelkonto; fehlt, wenn es kein solches Konto gibt. */
  accounts?: DebtorAccountSummary[];
  totals: {
    openCents: Cents;
    overdueCents: Cents;
    /** Saldo der Debitoren-Sammelkonten laut Hauptbuch zum Stichtag. */
    controlAccountCents: Cents;
    /** Kontrollsumme: muss 0 sein, sonst weichen Nebenbuch und Hauptbuch ab. */
    differenceCents: Cents;
  };
}

export async function debtorsReport(
  ledger: LedgerReadPort,
  tenantId: string,
  q: { asOf: string },
): Promise<DebtorsReport> {
  const [items, accounts, lines, debtors] = await Promise.all([
    openItemRows(ledger, tenantId, q.asOf),
    ledger.listAccounts(tenantId),
    ledger.listJournalLines(tenantId, { to: q.asOf }),
    ledger.listDebtors(tenantId),
  ]);
  const types = new Map(debtors.map((d) => [d.id, d.type]));
  const controls = accounts.filter((a) => a.debtorControl).sort(byNumber);
  const map = new Map<string, DebtorRow>();
  // Je Sammelkonto: Posten, Saldo und die Debitoren, die darauf offene Posten haben.
  const perAccount = new Map<string, { items: number; cents: Cents; debtors: Set<string> }>();
  for (const i of items) {
    const r = map.get(i.debtorId) ?? {
      debtorId: i.debtorId,
      number: i.debtorNumber,
      name: i.debtorName,
      itemCount: 0,
      openCents: 0,
      overdueCents: 0,
      oldestDueDate: i.dueDate,
    };
    const type = types.get(i.debtorId);
    if (type) r.type = type;
    r.itemCount += 1;
    r.openCents += i.openCents;
    if (i.daysOverdue > 0) r.overdueCents += i.openCents;
    if (i.dueDate < r.oldestDueDate) r.oldestDueDate = i.dueDate;
    if (i.dunningLevel !== undefined)
      r.dunningLevel = Math.max(r.dunningLevel ?? 0, i.dunningLevel);
    map.set(i.debtorId, r);

    const accountId = i.accountId ?? controls[0]?.id;
    if (accountId !== undefined) {
      const a = perAccount.get(accountId) ?? { items: 0, cents: 0, debtors: new Set<string>() };
      a.items += 1;
      a.cents += i.openCents;
      a.debtors.add(i.debtorId);
      perAccount.set(accountId, a);
    }
  }
  const rows = [...map.values()].sort(byNumber);
  const summaries = controls.map((a): DebtorAccountSummary => {
    const s = perAccount.get(a.id);
    return {
      number: a.number,
      name: a.name,
      debtors: s?.debtors.size ?? 0,
      items: s?.items ?? 0,
      balanceCents: s?.cents ?? 0,
    };
  });
  const bal = totals(lines, accountMap(accounts));
  const control = sumCents(accounts.filter((a) => a.debtorControl).map((a) => net(bal.get(a.id))));
  const open = sumCents(rows.map((r) => r.openCents));
  return {
    asOf: q.asOf,
    rows,
    ...(summaries.length > 0 ? { accounts: summaries } : {}),
    totals: {
      openCents: open,
      overdueCents: sumCents(rows.map((r) => r.overdueCents)),
      controlAccountCents: control,
      differenceCents: control - open,
    },
  };
}

// ---------------------------------------------------------------- Saldenliste

export interface TrialBalanceRow {
  accountId: string;
  number: string;
  name: string;
  type: AccountType;
  /** Saldo vor der Periode, Soll positiv. */
  openingCents: Cents;
  debitCents: Cents;
  creditCents: Cents;
  /** Saldo am Periodenende, Soll positiv. */
  closingCents: Cents;
}

export interface TrialBalanceReport {
  from: string;
  to: string;
  rows: TrialBalanceRow[];
  totals: {
    debitCents: Cents;
    creditCents: Cents;
    openingCents: Cents;
    closingCents: Cents;
    /** Soll = Haben und die Summe aller Salden ist 0. */
    balanced: boolean;
  };
}

export async function trialBalanceReport(
  ledger: LedgerReadPort,
  tenantId: string,
  q: { from: string; to: string },
): Promise<TrialBalanceReport> {
  const [accounts, lines] = await Promise.all([
    ledger.listAccounts(tenantId),
    ledger.listJournalLines(tenantId, { to: q.to }),
  ]);
  const am = accountMap(accounts);
  const before = totals(
    lines.filter((l) => l.date < q.from),
    am,
  );
  const within = totals(
    lines.filter((l) => l.date >= q.from),
    am,
  );
  const rows = [...accounts].sort(byNumber).map((a): TrialBalanceRow => {
    const opening = net(before.get(a.id));
    const w = within.get(a.id) ?? { debit: 0, credit: 0 };
    return {
      accountId: a.id,
      number: a.number,
      name: a.name,
      type: a.type,
      openingCents: opening,
      debitCents: w.debit,
      creditCents: w.credit,
      closingCents: opening + w.debit - w.credit,
    };
  });
  const debit = sumCents(rows.map((r) => r.debitCents));
  const credit = sumCents(rows.map((r) => r.creditCents));
  const opening = sumCents(rows.map((r) => r.openingCents));
  const closing = sumCents(rows.map((r) => r.closingCents));
  return {
    from: q.from,
    to: q.to,
    rows,
    totals: {
      debitCents: debit,
      creditCents: credit,
      openingCents: opening,
      closingCents: closing,
      balanced: debit === credit && opening === 0 && closing === 0,
    },
  };
}

// ---------------------------------------------------------------- Erfolgsrechnung / Bilanz

export interface StatementRow {
  accountId: string;
  number: string;
  name: string;
  type: AccountType;
  /** In natürlicher Richtung: Aktiven und Aufwand positiv bei Soll, alles andere positiv bei Haben. */
  amountCents: Cents;
}

async function statement(
  ledger: LedgerReadPort,
  tenantId: string,
  range: { from?: string; to: string },
  types: AccountType[],
): Promise<StatementRow[]> {
  const [accounts, lines] = await Promise.all([
    ledger.listAccounts(tenantId),
    ledger.listJournalLines(tenantId, range),
  ]);
  const bal = totals(lines, accountMap(accounts));
  return accounts
    .filter((a) => types.includes(a.type))
    .sort(byNumber)
    .map((a) => {
      const n = net(bal.get(a.id));
      const debitNatural = a.type === "asset" || a.type === "expense";
      return {
        accountId: a.id,
        number: a.number,
        name: a.name,
        type: a.type,
        amountCents: debitNatural ? n : -n,
      };
    });
}

const sumType = (rows: StatementRow[], t: AccountType) =>
  sumCents(rows.filter((r) => r.type === t).map((r) => r.amountCents));

export interface IncomeStatementReport {
  from: string;
  to: string;
  rows: StatementRow[];
  totals: { revenueCents: Cents; expenseCents: Cents; resultCents: Cents };
}

export async function incomeStatementReport(
  ledger: LedgerReadPort,
  tenantId: string,
  q: { from: string; to: string },
): Promise<IncomeStatementReport> {
  const rows = await statement(ledger, tenantId, q, ["revenue", "expense"]);
  const revenue = sumType(rows, "revenue");
  const expense = sumType(rows, "expense");
  return {
    from: q.from,
    to: q.to,
    rows,
    totals: { revenueCents: revenue, expenseCents: expense, resultCents: revenue - expense },
  };
}

export interface BalanceSheetReport {
  asOf: string;
  rows: StatementRow[];
  totals: {
    assetsCents: Cents;
    liabilitiesCents: Cents;
    equityCents: Cents;
    /** Kumuliertes Ergebnis der Erfolgskonten bis zum Stichtag (noch nicht ins Eigenkapital übertragen). */
    resultCents: Cents;
    liabilitiesAndEquityCents: Cents;
    /** Aktiven minus (Fremdkapital + Eigenkapital + Ergebnis): Kontrollsumme, muss 0 sein. */
    differenceCents: Cents;
    balanced: boolean;
  };
}

export async function balanceSheetReport(
  ledger: LedgerReadPort,
  tenantId: string,
  q: { asOf: string },
): Promise<BalanceSheetReport> {
  const all = await statement(ledger, tenantId, { to: q.asOf }, [
    "asset",
    "liability",
    "equity",
    "revenue",
    "expense",
  ]);
  const assets = sumType(all, "asset");
  const liabilities = sumType(all, "liability");
  const equity = sumType(all, "equity");
  const result = sumType(all, "revenue") - sumType(all, "expense");
  const lae = liabilities + equity + result;
  return {
    asOf: q.asOf,
    rows: all.filter((r) => r.type !== "revenue" && r.type !== "expense"),
    totals: {
      assetsCents: assets,
      liabilitiesCents: liabilities,
      equityCents: equity,
      resultCents: result,
      liabilitiesAndEquityCents: lae,
      differenceCents: assets - lae,
      balanced: assets === lae,
    },
  };
}

// ---------------------------------------------------------------- MwSt-Abrechnung

export type VatMethod = "effective" | "saldo";

export interface VatRow {
  kind: "output" | "input";
  rateBp: number;
  netCents: Cents;
  /** Gebuchte Steuer. */
  taxCents: Cents;
  /** Netto x Satz, gerundet: zeigt Rundungsabweichungen der Einzelbuchungen. */
  computedTaxCents: Cents;
  differenceCents: Cents;
  /** Konto der Steuer (Kontonummer); fehlt, wenn die Quelle es nicht nennt. */
  account?: string;
}

export interface VatReport {
  from: string;
  to: string;
  method: VatMethod;
  /** Nur bei `saldo`. */
  saldoRateBp?: number;
  rows: VatRow[];
  totals: {
    /** Alle Entgelte (netto), auch befreite. */
    turnoverCents: Cents;
    /**
     * Teil des Gesamtumsatzes ohne Steuersatz (Satz 0 %, mit Vorzeichen). Gesamtumsatz minus dieser Betrag ist der
     * Umsatz zu Sätzen über 0 %. Eine Aufteilung nach Beiträgen, Mahngebühren und Gutschriften gibt es nicht: sie
     * hängt von der steuerlichen Einordnung der Erlöskonten ab.
     */
    untaxedCents: Cents;
    /** Brutto-Umsatz mit Steuersatz > 0; bei `saldo` die Basis der Saldosteuer. */
    taxableGrossCents: Cents;
    outputTaxCents: Cents;
    inputTaxCents: Cents;
    /** Zu zahlen (positiv) oder Guthaben (negativ). */
    payableCents: Cents;
  };
}

export interface VatQuery {
  from: string;
  to: string;
  method: VatMethod;
  saldoRateBp?: number | undefined;
}

export async function vatReport(
  ledger: LedgerReadPort,
  tenantId: string,
  q: VatQuery,
): Promise<VatReport> {
  if (q.method === "saldo" && q.saldoRateBp === undefined) {
    throw new RangeError("Saldosteuersatz fehlt.");
  }
  const all = await ledger.listVatTransactions(tenantId, { from: q.from, to: q.to });
  const tx = all.filter((t) => t.date >= q.from && t.date <= q.to);
  const output = tx.filter((t) => t.kind === "output");
  // Beim Saldosteuersatz gibt es keinen Vorsteuerabzug: Eingangsbelege bleiben unberücksichtigt.
  const used = q.method === "saldo" ? output : tx;

  const groups = new Map<string, VatRow>();
  for (const t of used) {
    const key = `${t.kind}:${t.rateBp}`;
    const r = groups.get(key) ?? {
      kind: t.kind,
      rateBp: t.rateBp,
      netCents: 0,
      taxCents: 0,
      computedTaxCents: 0,
      differenceCents: 0,
    };
    r.netCents += t.netCents;
    r.taxCents += t.taxCents;
    if (r.account === undefined && t.account !== undefined) r.account = t.account;
    groups.set(key, r);
  }
  const rows = [...groups.values()].sort(
    (a, b) => (a.kind === b.kind ? 0 : a.kind === "output" ? -1 : 1) || b.rateBp - a.rateBp,
  );
  for (const r of rows) {
    r.computedTaxCents = applyRateBp(r.netCents, r.rateBp);
    r.differenceCents = r.taxCents - r.computedTaxCents;
  }

  const turnover = sumCents(output.map((t) => t.netCents));
  const untaxed = sumCents(output.filter((t) => t.rateBp === 0).map((t) => t.netCents));
  const taxableGross = sumCents(
    output.filter((t) => t.rateBp > 0).map((t) => t.netCents + t.taxCents),
  );
  const base = { from: q.from, to: q.to, method: q.method, rows };
  if (q.method === "saldo" && q.saldoRateBp !== undefined) {
    // Auf die ganze Periode gerechnet, nicht je Buchung.
    const tax = applyRateBp(taxableGross, q.saldoRateBp);
    return {
      ...base,
      saldoRateBp: q.saldoRateBp,
      totals: {
        turnoverCents: turnover,
        untaxedCents: untaxed,
        taxableGrossCents: taxableGross,
        outputTaxCents: tax,
        inputTaxCents: 0,
        payableCents: tax,
      },
    };
  }
  const outTax = sumCents(rows.filter((r) => r.kind === "output").map((r) => r.taxCents));
  const inTax = sumCents(rows.filter((r) => r.kind === "input").map((r) => r.taxCents));
  return {
    ...base,
    totals: {
      turnoverCents: turnover,
      untaxedCents: untaxed,
      taxableGrossCents: taxableGross,
      outputTaxCents: outTax,
      inputTaxCents: inTax,
      payableCents: outTax - inTax,
    },
  };
}
