/** Alle Beträge sind ganze Rappen, alle Daten ISO (JJJJ-MM-TT), wie in der API. */
export type Rappen = number;

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

/** Konto mit den Summen aus der Saldenliste. */
export interface AccountRow {
  code: string;
  name: string;
  type: AccountType;
  active: boolean;
  debit: Rappen;
  credit: Rappen;
  balance: Rappen;
}

export type EntryKind = "manual" | "invoice" | "credit_note" | "payment" | "reversal";

export interface EntryLine {
  accountCode: string;
  side: "debit" | "credit";
  amount: Rappen;
  personId?: string;
}

export interface Entry {
  id: string;
  /** Lückenlose Belegnummer je Mandant. */
  number: number;
  bookingDate: string;
  kind: EntryKind;
  description: string;
  lines: EntryLine[];
  reversalOf: string | null;
  createdBy: string;
}

export interface EntryQuery {
  from?: string;
  to?: string;
  accountCode?: string;
  limit: number;
  offset: number;
}

export interface EntryPage {
  items: Entry[];
  /** Die API liefert keine Gesamtzahl: nur, ob eine weitere Seite folgt. */
  hasMore: boolean;
}

export interface ReverseInput {
  idempotencyKey: string;
  bookingDate: string;
  reason: string;
}

/** Versendete, noch nicht vollständig bezahlte Rechnung (Rechnungsmodul). */
export interface OpenInvoice {
  id: string;
  number: string | null;
  debtorName: string;
  dueDate: string;
  openRappen: Rappen;
}

export interface ReminderInfo {
  level: number;
  title: string;
}

export interface InvoiceInfo {
  number: string | null;
  debtorName: string;
  openRappen: Rappen;
}

export type RestReason =
  | "REVERSAL"
  | "NO_REFERENCE"
  | "INVALID_REFERENCE"
  | "NO_OPEN_ITEM"
  | "AMBIGUOUS_OPEN_ITEM"
  | "AMOUNT_MISMATCH"
  | "OPEN_ITEM_ALREADY_PAID"
  | "BOOKING_REJECTED";

/** Zahlung aus einer CAMT-Datei, wie die API sie liefert (`/camt`). */
export interface CamtPayment {
  id: string;
  status: "MATCHED" | "REST" | "MANUAL";
  openItemId?: string;
  restReason?: RestReason;
  bookingDate: string;
  amountRappen: Rappen;
  currency: string;
  direction: "CREDIT" | "DEBIT";
  reversal: boolean;
  reference?: string;
  debtorName?: string;
  debtorIban?: string;
  remittanceInfo?: string;
}

export interface RestPage {
  items: CamtPayment[];
  hasMore: boolean;
}

export interface ImportResult {
  importId: string;
  kind: "camt.053" | "camt.054";
  fileName: string;
  /** Kurzform der SHA-256-Prüfsumme der Datei, im Browser berechnet. */
  checksum: string;
  importedAt: number;
  importedBy: string;
  counts: { total: number; matched: number; rest: number; duplicates: number; ignored: number };
  matched: CamtPayment[];
  rest: CamtPayment[];
}

export interface LedgerLine {
  entryNumber: number;
  bookingDate: string;
  description: string;
  side: "debit" | "credit";
  amount: Rappen;
  balanceAfter: Rappen;
}

export interface LedgerOpenItem {
  id: string;
  reference: string;
  dueDate: string;
  remaining: Rappen;
}

export interface PersonLedger {
  personId: string;
  balance: Rappen;
  debit: Rappen;
  credit: Rappen;
  openItems: LedgerOpenItem[];
  lines: LedgerLine[];
}

export interface PersonInfo {
  name: string;
  email: string | null;
  group: string | null;
}

/** Fehler der API. Nur Status und Code, der Text stammt vom Server und ist fest formuliert (SR-51). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    message = `Anfrage fehlgeschlagen (${status})`,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Die API bietet die Funktion nicht an; die Oberfläche ist trotzdem fertig (siehe PR, «Fehlende API»). */
export class NotAvailableError extends Error {
  constructor(readonly feature: string) {
    super(`Nicht verfügbar: ${feature}`);
    this.name = "NotAvailableError";
  }
}

export interface BuchhaltungService {
  listAccounts(): Promise<AccountRow[]>;
  createAccount(input: { code: string; name: string; type: AccountType }): Promise<void>;
  renameAccount(code: string, name: string): Promise<void>;

  listEntries(query: EntryQuery): Promise<EntryPage>;
  reverseEntry(id: string, input: ReverseInput): Promise<void>;

  listOpenInvoices(): Promise<OpenInvoice[]>;
  listReminders(invoiceId: string): Promise<ReminderInfo[]>;
  issueReminder(invoiceId: string): Promise<void>;
  getInvoice(invoiceId: string): Promise<InvoiceInfo | null>;

  listRest(): Promise<RestPage>;
  assignRest(paymentId: string, openItemId: string): Promise<void>;
  postponePayment(paymentId: string): Promise<void>;
  importFile(file: File, checksum: string): Promise<ImportResult>;

  personLedger(personId: string): Promise<PersonLedger>;
  getPerson(personId: string): Promise<PersonInfo | null>;

  exportXlsx(what: "accounts" | "entries" | "open-items"): Promise<void>;
  downloadStatement(personId: string): Promise<void>;
}
