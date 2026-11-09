/**
 * Schnittstelle der Auswertungen zur Buchhaltung. Beträge sind ganze Rappen, Daten ISO (`2026-11-02`).
 * `httpService.ts` bedient sie aus den Routen unter `/reports`; was eine Quelle nicht liefert, ist
 * optional und fehlt dann in der Oberfläche.
 */

export type Bucket = "notDue" | "d1_30" | "d31_60" | "d61_90" | "d90plus";
export const BUCKETS: readonly Bucket[] = ["notDue", "d1_30", "d31_60", "d61_90", "d90plus"];

export interface ReportSettings {
  /** MwSt-Nummer der Organisation, leer wenn noch nicht erfasst. */
  vatNumber: string;
  /** Monat (1 bis 12), in dem das Geschäftsjahr beginnt. */
  fiscalYearStartMonth: number;
}

// ---- Offene Posten -------------------------------------------------------------------------

export interface OpenItemRow {
  id: string;
  reference: string;
  debtorNumber: string;
  debtorName: string;
  issueDate: string;
  dueDate: string;
  daysOverdue: number;
  bucket: Bucket;
  openCents: number;
}

export interface OpenItemsReport {
  asOf: string;
  /** Alle offenen Posten zum Stichtag; Filter, Sortierung und Seiten bildet die Oberfläche. */
  rows: OpenItemRow[];
}

// ---- Debitorenliste ------------------------------------------------------------------------

export interface DebtorRow {
  id: string;
  number: string;
  name: string;
  /** Fehlt, wenn die Quelle die Art der Person nicht liefert. */
  type?: "company" | "person";
  items: number;
  oldestDueDate: string;
  /** Tage seit der ältesten Fälligkeit, 0 = nichts überfällig. */
  overdueDays: number;
  balanceCents: number;
  /** 0 = keine, 1 = Erinnerung, 2 = 1. Mahnung, … Fehlt, wenn die Quelle die Mahnstufe nicht liefert. */
  dunningLevel?: number;
}

export interface DebtorAccountSummary {
  number: string;
  name: string;
  debtors: number;
  items: number;
  balanceCents: number;
}

export interface DebtorsReport {
  asOf: string;
  rows: DebtorRow[];
  /** Aufteilung nach Debitorenkonto. Fehlt, wenn die Quelle nur die Summe kennt. */
  accounts?: DebtorAccountSummary[];
}

// ---- Saldenliste ---------------------------------------------------------------------------

export type AccountClass = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface TrialBalanceRow {
  number: string;
  name: string;
  type: AccountClass;
  debitCents: number;
  creditCents: number;
  /** Saldo am Ende des Zeitraums, Soll positiv. */
  balanceCents: number;
}

export interface TrialBalanceReport {
  from: string;
  to: string;
  rows: TrialBalanceRow[];
}

// ---- Erfolgsrechnung und Bilanz ------------------------------------------------------------

export interface StatementRow {
  number: string;
  name: string;
  /** In natürlicher Richtung des Kontos (Ertrag positiv bei Haben). */
  amountCents: number;
}

export interface StatementsReport {
  from: string;
  to: string;
  income: {
    revenue: StatementRow[];
    expenses: StatementRow[];
    revenueCents: number;
    expenseCents: number;
    resultCents: number;
  };
  balance: {
    assets: StatementRow[];
    /** Fremd- und Eigenkapital, ohne das laufende Ergebnis. */
    liabilities: StatementRow[];
    assetsCents: number;
    /** Passiven samt Ergebnis. */
    liabilitiesCents: number;
    resultCents: number;
  };
}

// ---- MwSt-Abrechnung -----------------------------------------------------------------------

export interface VatRate {
  rateBp: number;
  turnoverCents: number;
  taxCents: number;
  /** Konto der geschuldeten Steuer. Fehlt, wenn die Quelle es nicht nennt. */
  account?: string;
}

export interface VatReport {
  from: string;
  to: string;
  method: "effective" | "saldo";
  saldoRateBp?: number;
  turnover: {
    totalCents: number;
    /** Abzüge und Zuschläge zwischen Gesamtumsatz und steuerbarem Umsatz (mit Vorzeichen). Fehlt, wenn die Quelle sie nicht liefert. */
    adjustments?: {
      kind: "contributions" | "dunningFees" | "creditNotes" | "untaxed";
      cents: number;
    }[];
    taxableCents: number;
  };
  rates: VatRate[];
  payableCents: number;
  /** `true`, solange das Geschäftsjahr nicht abgeschlossen ist. */
  preview: boolean;
}

// ---- Periodenabschluss ---------------------------------------------------------------------

export interface PeriodInfo {
  id: string;
  /** Anzeigename, z. B. «Oktober 2026». */
  label: string;
  from: string;
  to: string;
  state: "open" | "checked" | "closed";
  closedAt?: string;
  /** Name der abschliessenden Person. Fehlt, wenn der Name nicht bekannt ist. */
  closedBy?: string;
  /** Anzahl Buchungen. Fehlt, wenn die Quelle sie nicht zählt. */
  bookings?: number;
  /** Warnungen, die beim Abschluss bestätigt wurden. */
  warnings: number;
}

export interface PeriodCheck {
  id: string;
  /** Prüfpunkt, z. B. «Saldenliste ist ausgeglichen». */
  title: string;
  result: string;
  status: "ok" | "warning" | "error";
  /** Kurzname bei Warnung, z. B. «Restposten»; erscheint im Bestätigungsdialog. */
  warningName?: string;
  action?: { kind: "leftovers" | "drafts"; label: string };
}

export interface Leftover {
  id: string;
  valueDate: string;
  payer: string;
  amountCents: number;
  reason: string;
}

export interface PeriodReview {
  period: PeriodInfo;
  checks: PeriodCheck[];
  /** Restposten des Zahlungsimports. Fehlt, wenn die Quelle sie nicht liefert. */
  leftovers?: Leftover[];
  /** Zähler der Periode. Fehlt, wenn die Quelle sie nicht liefert. */
  stats?: { bookings: number; invoices: number; payments: number; reversals: number };
}

// ---- Export --------------------------------------------------------------------------------

export type ExportName =
  "open-items" | "debtors" | "trial-balance" | "income-statement" | "balance-sheet" | "vat";

export interface ExportFile {
  filename: string;
  blob: Blob;
}

export interface ReportsService {
  settings(): Promise<ReportSettings>;
  openItems(asOf: string): Promise<OpenItemsReport>;
  debtors(asOf: string): Promise<DebtorsReport>;
  trialBalance(from: string, to: string): Promise<TrialBalanceReport>;
  statements(from: string, to: string): Promise<StatementsReport>;
  vat(from: string, to: string): Promise<VatReport>;
  periods(): Promise<PeriodInfo[]>;
  /** Prüft die Periode (sofern noch nicht geprüft) und liefert die Prüfpunkte. */
  reviewPeriod(id: string): Promise<PeriodReview>;
  /** Nimmt die Prüfung zurück (Abschluss abgebrochen). */
  cancelReview(id: string): Promise<void>;
  /** Schliesst die geprüfte Periode ab. */
  closePeriod(id: string): Promise<PeriodInfo>;
  /** Lädt die Auswertung als Datei. */
  exportReport(
    name: ExportName,
    query: Record<string, string>,
    format: "xlsx" | "csv" | "pdf",
  ): Promise<ExportFile>;
  /** Lädt den Abschlussbericht einer Periode als PDF. */
  exportPeriodReport(id: string): Promise<ExportFile>;
}
