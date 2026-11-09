import { createContext, useContext, type ReactNode } from "react";
import type {
  BillingSettings,
  DunningLevel,
  Invoice,
  InvoiceLine,
  InvoiceRow,
  Recipient,
  Reminder,
} from "./model";

/** Die Schnittstelle bietet die Funktion (noch) nicht an: es fehlt die Route im Server. */
export class UnavailableError extends Error {
  constructor(feature: string) {
    super(`Nicht angebunden: ${feature}`);
    this.name = "UnavailableError";
  }
}

export interface DraftInput {
  recipient: Recipient;
  issueDate: string;
  dueDate: string;
  subject: string;
  notes: string;
  lines: InvoiceLine[];
}

export interface HistoryEntry {
  id: string;
  /** ISO-Zeitpunkt. */
  at: string;
  /** Nur das Datum anzeigen (abgeleiteter Eintrag ohne genauen Zeitpunkt). */
  dateOnly?: boolean;
  kind: "created" | "sent" | "payment" | "refund" | "reminder" | "credit" | "cancel" | "due";
  /** Werte für den Text des Eintrags. */
  params: Record<string, string | number>;
  /** Wer es ausgelöst hat, falls die API es nennt. */
  actor?: string;
}

export interface InvoiceDetail {
  invoice: Invoice;
  reminders: Reminder[];
  /** Rechnungs-E-Mail aus Personen oder Firmenregister, falls bekannt. */
  email: string | null;
  history: HistoryEntry[];
  /** Erreichte Mahnstufe. */
  level: number;
  levelTitle: string | null;
  /** Vom Server gemeldete fällige Stufe, wenn heute gemahnt werden kann. */
  dueLevel: DunningLevel | undefined;
}

export interface SendOptions {
  mode: "email" | "pdf";
  to: string;
  subject: string;
  message: string;
}

export interface SendResult {
  invoice: Invoice;
  /** `false`, wenn nur gebucht wurde und die E-Mail nicht verschickt werden konnte. */
  delivered: boolean;
}

export interface CancelInput {
  reason: string;
  remark: string;
}

/** Erneutes Versenden einer gebuchten Rechnung per E-Mail (PDF im Anhang). */
export interface ResendOptions {
  to: string;
  subject: string;
  message: string;
}

export interface BookingLine {
  accountCode: string;
  accountName: string;
  side: "debit" | "credit";
  amountCents: number;
}

/** Buchung der Buchhaltung zu einer Rechnung (Forderung, Zahlung, Rückbuchung, Gutschrift). */
export interface Booking {
  id: string;
  /** Belegnummer der Buchhaltung. */
  number: number;
  bookingDate: string;
  kind: "manual" | "invoice" | "credit_note" | "payment" | "reversal";
  description: string;
  lines: BookingLine[];
}

export interface CreditInput {
  scope: "full" | "partial";
  /** Teilbetrag in Rappen, bei `full` ignoriert. */
  amountCents: number;
  reason: string;
}

export interface DunningStage {
  /** 0 = keine Mahnung bisher. */
  level: number;
  title: string | null;
  count: number;
  totalCents: number;
}

export interface DunningOverview {
  today: string;
  rows: InvoiceRow[];
  /** Fällige Stufen je Rechnungs-ID (Stichtag heute). */
  due: Record<string, DunningLevel>;
  levels: DunningLevel[];
}

export interface CollectiveGroup {
  id: string;
  name: string;
  persons: number;
  /** `null` = Gruppe ohne Beitrag. */
  feeCents: number | null;
}

export interface CollectiveConfig {
  year: number;
  issueDate: string;
  termDays: number;
  text: string;
  delivery: "email-or-print" | "email" | "print";
  skipLeft: boolean;
  skipNoFee: boolean;
  groupIds: string[];
}

export interface CollectiveSetup {
  groups: CollectiveGroup[];
  /** Vorgaben für ein neues Konfigurieren. */
  defaults: Pick<CollectiveConfig, "year" | "issueDate" | "termDays" | "text">;
  totalPersons: number;
}

export interface CollectivePreviewRow {
  /** Vorgesehene Nummer. */
  number: string;
  recipient: string;
  groupName: string;
  feeCents: number;
  delivery: "email" | "print";
  check: "ready" | "no-email";
}

export interface CollectivePreview {
  count: number;
  groupCount: number;
  totalCents: number;
  dueDate: string;
  viaEmail: number;
  printCount: number;
  /** Personen ohne vollständige Postadresse: sie bekommen keine Rechnung. */
  noAddress: number;
  rows: CollectivePreviewRow[];
}

/**
 * Schnittstelle des Rechnungsmoduls zum Server. Die Oberfläche kennt nur diesen Vertrag; die Umsetzung
 * gegen die API steht in `httpRechnungenService.ts`, eine In-Memory-Fassung in `memoryRechnungenService.ts`.
 * Fehler werden als Exception geworfen; fehlt dem Server eine Funktion, wirft die Umsetzung `UnavailableError`.
 */
export interface RechnungenService {
  /** Heutiges Datum (ISO, Schweizer Ortszeit). */
  today: () => string;
  /** Alle Rechnungen (ohne Gutschriften) mit abgeleitetem Status und Mahnstufe. */
  listInvoices: () => Promise<InvoiceRow[]>;
  getInvoice: (id: string) => Promise<InvoiceDetail>;
  getSettings: () => Promise<BillingSettings>;
  searchRecipients: (query: string, signal?: AbortSignal) => Promise<Recipient[]>;
  /** Legt den Entwurf an oder ändert ihn (`existing`). */
  saveDraft: (input: DraftInput, existing?: { id: string; version: number }) => Promise<Invoice>;
  /** Bucht den Entwurf (Nummer, Referenz, Debitorenbuchung) und versendet ihn. */
  sendInvoice: (id: string, options: SendOptions) => Promise<SendResult>;
  /** Schickt die gebuchte Rechnung erneut per E-Mail; wirft, wenn die Mail nicht in die Versandqueue kam. */
  resendInvoice: (id: string, options: ResendOptions) => Promise<void>;
  cancelInvoice: (id: string, input: CancelInput) => Promise<Invoice>;
  /** Buchungen der Buchhaltung zur Rechnung. */
  bookings: (invoiceId: string) => Promise<Booking[]>;
  /** Lädt die Rechnungsliste als Excel-Datei herunter; mit `ids` nur diese Rechnungen. */
  exportInvoices: (ids?: readonly string[]) => Promise<void>;
  /** Speichert die Mahnstufen und liefert die gespeicherten zurück. */
  saveDunningLevels: (levels: DunningLevel[]) => Promise<DunningLevel[]>;
  creditInvoice: (id: string, input: CreditInput) => Promise<Invoice>;
  dunningOverview: () => Promise<DunningOverview>;
  /** Erzeugt die fällige Mahnung der Rechnung. */
  issueReminder: (invoiceId: string) => Promise<Reminder>;
  /** Lädt das PDF der Rechnung (`level` fehlt) oder einer Mahnung herunter. */
  downloadPdf: (invoiceId: string, level?: number) => Promise<void>;
  collectiveSetup: () => Promise<CollectiveSetup>;
  collectivePreview: (config: CollectiveConfig) => Promise<CollectivePreview>;
  /** Beitrag je Gruppe in Rappen setzen, `null` entfernt ihn. */
  setGroupFee: (groupId: string, feeCents: number | null) => Promise<void>;
  runCollective: (
    config: CollectiveConfig,
    options: { testMailTo?: string },
  ) => Promise<{
    created: number;
    /** Gebuchte Rechnungen, deren Mail nicht in die Versandqueue kam. */ notMailed: number;
  }>;
}

const ServiceContext = createContext<RechnungenService | null>(null);

export function RechnungenServiceProvider({
  service,
  children,
}: {
  service: RechnungenService;
  children: ReactNode;
}) {
  return <ServiceContext.Provider value={service}>{children}</ServiceContext.Provider>;
}

let fallback: RechnungenService | undefined;

/** Der Dienst der Anwendung: ohne Provider die Anbindung an die API (einmal erzeugt). */
export function useRechnungen(): RechnungenService {
  const injected = useContext(ServiceContext);
  if (injected) return injected;
  if (!fallback) throw new Error("Kein Rechnungsdienst: RechnungenServiceProvider verwenden");
  return fallback;
}

/** Wird beim Laden des Moduls gesetzt (`index.ts`). */
export function setDefaultService(service: RechnungenService) {
  fallback = service;
}
