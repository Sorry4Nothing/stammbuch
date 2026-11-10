import type { Address, Invoice, InvoiceKind, InvoiceStatus, Payment } from "./domain.js";
import type { DunningConfig, Reminder } from "./dunning.js";

/**
 * Persistenz nur über diese Schnittstellen. Jede Methode ist auf den Mandanten begrenzt
 * (SR-11): eine ID aus einem fremden Mandanten verhält sich wie "nicht vorhanden".
 * Die Postgres-Umsetzung (pg-repository.ts) führt `update` und `insert` der Mahnungen atomar aus; die
 * Unveränderlichkeit gebuchter Belege sichern zusätzlich Trigger. Abläufe über mehrere Aufrufe (Versenden mit
 * Nummernvergabe, Gutschrift mit Statusänderung) bündelt `ServiceDeps.transaction`.
 */
export interface InvoiceRepository {
  insert(invoice: Invoice): Promise<void>;
  /** Ersetzt den Beleg, wenn `expectedVersion` noch der gespeicherten entspricht (sonst Konflikt). */
  update(invoice: Invoice, expectedVersion: number): Promise<void>;
  /** Löscht nur Entwürfe ohne Nummer. Gebuchtes wird nie gelöscht. */
  deleteDraft(tenantId: string, id: string): Promise<boolean>;
  get(tenantId: string, id: string): Promise<Invoice | null>;
  list(tenantId: string, q: InvoiceQuery): Promise<{ items: Invoice[]; total: number }>;
  /** Versendete Gutschriften zu einer Rechnung. */
  creditNotesOf(tenantId: string, invoiceId: string): Promise<Invoice[]>;
  /** Nächste lückenlose Nummer je Mandant, Belegart und Jahr (atomar). */
  nextSeq(tenantId: string, kind: InvoiceKind, year: number): Promise<number>;
  /** Zuletzt vergebene Nummer (0 = noch keine), ohne eine zu vergeben: Grundlage der Vorschau. */
  lastSeq(tenantId: string, kind: InvoiceKind, year: number): Promise<number>;
  findByRunAndPayer(tenantId: string, runId: string, payerKey: string): Promise<Invoice | null>;
}

export interface InvoiceQuery {
  status?: InvoiceStatus | undefined;
  kind?: InvoiceKind | undefined;
  q?: string | undefined;
  limit: number;
  offset: number;
}

export interface ReminderRepository {
  /** Pro Rechnung und Stufe nur einmal; sonst Konflikt. */
  insert(reminder: Reminder): Promise<void>;
  listByInvoice(tenantId: string, invoiceId: string): Promise<Reminder[]>;
}

export interface BillingSettings {
  tenantId: string;
  /** Rechnungssteller (Verein/Firma). */
  creditor: Address;
  iban: string;
  /** Mehrwertsteuerpflichtig (Kopie aus der Organisation). `false`: Belege tragen nie MwSt, der Server erzwingt es. */
  vatLiable: boolean;
  vatNumber: string | null;
  contactLines: string[];
  numberPrefix: string;
  creditNotePrefix: string;
  /** Ziffern, vorangestellt in der Zahlungsreferenz (z. B. Kundennummer bei der Bank). */
  referencePrefix: string;
  paymentTermDays: number;
  defaultVatMode: "none" | "exclusive";
  defaultVatRateBp: number;
  roundTo5: boolean;
  /** Standard-Erlöskonto für Positionen ohne eigenes Konto; null = 3400 (Erlös aus Dienstleistungen). */
  defaultRevenueAccount: string | null;
  dunning: DunningConfig;
  features: { collectiveInvoicing: boolean };
}

export interface SettingsRepository {
  get(tenantId: string): Promise<BillingSettings | null>;
  save(settings: BillingSettings): Promise<void>;
}

/**
 * Anbindung der Buchhaltung (Issue #8). Läuft in derselben Transaktion wie die Rechnung: schlägt die Buchung
 * fehl, wird die Rechnung nicht versendet. Eine Umsetzung, die nicht in dieselbe Transaktion passt, braucht
 * ein Outbox-Muster (Ereignis in der Transaktion speichern, später zustellen).
 */
export interface AccountingPort {
  /**
   * Rechnung oder Gutschrift wurde versendet (gebucht, mit Nummer): Forderung bzw. Gegenbuchung. Bei einer Gutschrift
   * ist `original` die korrigierte Rechnung. Wirft, wenn nicht gebucht werden kann; dann wird nicht versendet.
   */
  invoiceBooked(invoice: Invoice, original?: Invoice): Promise<void>;
  /**
   * Zahlung oder Rückbuchung wurde erfasst. Bei einer Rückbuchung (negativer Betrag) ist `returned` die frühere Zahlung,
   * die sie aufhebt: die Buchhaltung bucht deren Buchung spiegelbildlich und öffnet den Posten wieder.
   */
  paymentRecorded(invoice: Invoice, payment: Payment, returned?: Payment): Promise<void>;
  /** Prüft, dass alle Konten im Kontenplan des Mandanten als aktive Erlöskonten bestehen; wirft sonst `BillingError` (422). */
  assertRevenueAccounts(codes: readonly string[]): Promise<void>;
  /**
   * Buchungen zu Idempotenzschlüsseln (`invoice-booked:<Beleg-ID>`, `invoice-payment:<Zahlungs-ID>` usw.), aufsteigend nach
   * Belegnummer; nur lesend. Fehlt die Methode (Umsetzung ohne Buchhaltung), gibt es keine Buchungen zu zeigen.
   */
  entriesByKeys?(keys: readonly string[]): Promise<BookingEntry[]>;
}

/** Buchung der Buchhaltung zu einem Beleg, mit Kontenbezeichnung für die Anzeige. */
export interface BookingEntry {
  id: string;
  /** Lückenlose Belegnummer der Buchhaltung. */
  number: number;
  bookingDate: string;
  kind: "manual" | "invoice" | "credit_note" | "payment" | "reversal";
  description: string;
  /** Gegenbuchung: die stornierte Buchung. */
  reversalOf: string | null;
  createdAt: string;
  lines: {
    accountCode: string;
    accountName: string;
    side: "debit" | "credit";
    amountCents: number;
  }[];
}
