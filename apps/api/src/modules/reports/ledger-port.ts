import type { Cents } from "./money.js";

/**
 * Lesender Zugang der Auswertungen zur Buchhaltung (#8). Das Modul `accounting` implementiert
 * diese Schnittstelle; die Auswertungen kennen weder Tabellen noch dessen Typen.
 * Jede Methode ist auf einen Mandanten beschränkt (Mandantentrennung, Plan Abschnitt 7).
 * Nur festgeschriebene Buchungen werden geliefert, nie Entwürfe.
 */

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface Account {
  id: string;
  /** Kontonummer, z. B. "1100". */
  number: string;
  name: string;
  type: AccountType;
  /** Debitoren-Sammelkonto: sein Saldo muss der Summe der offenen Posten entsprechen. */
  debtorControl?: boolean;
}

/** Eine Seite einer Buchung. Betrag immer positiv; die Seite sagt Soll oder Haben. */
export interface JournalLine {
  id: string;
  bookingId: string;
  /** Buchungsdatum (ISO). */
  date: string;
  accountId: string;
  side: "debit" | "credit";
  amountCents: Cents;
  text: string;
}

export interface Debtor {
  id: string;
  number: string;
  name: string;
}

export interface Settlement {
  date: string;
  /** Zahlung, Gutschrift oder Skonto, die den Posten verringert. */
  amountCents: Cents;
}

/** Offener Posten = Rechnung (positiv) oder Gutschrift (negativ) samt Zuordnungen. */
export interface OpenItem {
  id: string;
  debtorId: string;
  /** Rechnungsnummer. */
  reference: string;
  issueDate: string;
  dueDate: string;
  amountCents: Cents;
  settlements: Settlement[];
}

/** MwSt-relevanter Umsatz oder Vorsteuer einer Buchung. Gutschriften tragen negative Beträge. */
export interface VatTransaction {
  bookingId: string;
  date: string;
  kind: "output" | "input";
  /** Steuersatz in Basispunkten (810 = 8.10 %). 0 = befreit/nicht steuerbar. */
  rateBp: number;
  netCents: Cents;
  taxCents: Cents;
}

export interface LedgerReadPort {
  listAccounts(tenantId: string): Promise<Account[]>;
  /** Alle Zeilen mit `date <= to` (und `>= from`, falls gesetzt), nach Datum und id sortiert. */
  listJournalLines(tenantId: string, range: { from?: string; to: string }): Promise<JournalLine[]>;
  listDebtors(tenantId: string): Promise<Debtor[]>;
  /** Posten mit `issueDate <= asOf`. Zuordnungen nach `asOf` filtert die Auswertung selbst. */
  listOpenItems(tenantId: string, asOf: string): Promise<OpenItem[]>;
  listVatTransactions(
    tenantId: string,
    range: { from: string; to: string },
  ): Promise<VatTransaction[]>;
}

export interface LedgerData {
  accounts: Account[];
  lines: JournalLine[];
  debtors: Debtor[];
  openItems: OpenItem[];
  vat: VatTransaction[];
}

/** In-Memory-Umsetzung für Tests und Entwicklung; hält Daten je Mandant. */
export class InMemoryLedger implements LedgerReadPort {
  private readonly data = new Map<string, LedgerData>();

  seed(tenantId: string, data: Partial<LedgerData>): this {
    this.data.set(tenantId, {
      accounts: [],
      lines: [],
      debtors: [],
      openItems: [],
      vat: [],
      ...data,
    });
    return this;
  }

  private of(tenantId: string): LedgerData {
    return (
      this.data.get(tenantId) ?? { accounts: [], lines: [], debtors: [], openItems: [], vat: [] }
    );
  }

  listAccounts = async (t: string) => this.of(t).accounts;
  listDebtors = async (t: string) => this.of(t).debtors;
  listOpenItems = async (t: string, asOf: string) =>
    this.of(t).openItems.filter((i) => i.issueDate <= asOf);
  listJournalLines = async (t: string, r: { from?: string; to: string }) =>
    this.of(t)
      .lines.filter((l) => l.date <= r.to && (r.from === undefined || l.date >= r.from))
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  listVatTransactions = async (t: string, r: { from: string; to: string }) =>
    this.of(t).vat.filter((v) => v.date >= r.from && v.date <= r.to);
}
