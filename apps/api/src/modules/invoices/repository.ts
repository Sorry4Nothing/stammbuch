import type { Address, Invoice, InvoiceKind, InvoiceStatus } from "./domain.js";
import type { DunningConfig, Reminder } from "./dunning.js";

/**
 * Persistenz nur über diese Schnittstellen. Jede Methode ist auf den Mandanten begrenzt
 * (SR-11): eine ID aus einem fremden Mandanten verhält sich wie "nicht vorhanden".
 * Die Postgres-Umsetzung (Issue #3) muss `update`, `nextSeq` und `insert` der Mahnungen atomar in
 * einer Transaktion ausführen und die Unveränderlichkeit gebuchter Belege zusätzlich per Trigger sichern.
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
  findByRunAndPayer(tenantId: string, runId: string, payerKey: string): Promise<Invoice | null>;
}

export interface InvoiceQuery {
  status?: InvoiceStatus | undefined;
  kind?: InvoiceKind | undefined;
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
  dunning: DunningConfig;
  features: { collectiveInvoicing: boolean };
}

export interface SettingsRepository {
  get(tenantId: string): Promise<BillingSettings | null>;
  save(settings: BillingSettings): Promise<void>;
}
