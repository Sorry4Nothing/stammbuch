import {
  type Cents,
  MAX_QUANTITY_MILLI,
  MAX_TOTAL_CENTS,
  MAX_UNIT_CENTS,
  lineNetCents,
  roundTo5Rappen,
  vatCents,
} from "./money.js";
import type { QrAddress, ReferenceType } from "./qrbill.js";

/** Fachlicher Fehler mit HTTP-Status; Text ist für den Client bestimmt und enthält keine Interna. */
export class BillingError extends Error {
  constructor(
    readonly statusCode: 400 | 401 | 403 | 404 | 409 | 422,
    message: string,
  ) {
    super(message);
  }
}

/** Erlöskonten der bisherigen Regel (Standardkontenplan): Mitgliederbeiträge der Sammelrechnung bzw. Dienstleistungen. */
export const MEMBERSHIP_REVENUE_ACCOUNT = "3000";
export const DEFAULT_REVENUE_ACCOUNT = "3400";

export type Address = QrAddress;
export type Currency = "CHF" | "EUR";
export type InvoiceKind = "invoice" | "credit_note";
/** Entwurf -> versendet (gebucht) -> bezahlt | storniert. Alles ab "sent" ist unveränderlich. */
export type InvoiceStatus = "draft" | "sent" | "paid" | "cancelled";
export type VatMode = "none" | "exclusive";

export interface InvoiceLine {
  description: string;
  /** Menge in Tausendsteln (1500 = 1.5 Einheiten). */
  quantityMilli: number;
  /** Einzelpreis netto in Rappen. Bei gutschrift-Zeilen negativ. */
  unitCents: Cents;
  /** MwSt-Satz in Basispunkten (810 = 8.1 %). Bei vatMode "none" immer 0. */
  vatRateBp: number;
  /**
   * Erlöskonto der Position (Kontenplan des Mandanten). Fehlt es, gilt beim Versenden das Standardkonto des Mandanten;
   * der Wert wird dann in die Position übernommen und bleibt mit dem Beleg unveränderlich. Nur bei Belegen, die vor
   * #67 versendet wurden, bleibt es leer (dort gilt die frühere Regel: Sammelrechnung 3000, sonst 3400).
   */
  accountCode?: string | null;
}

export interface VatBucket {
  rateBp: number;
  netCents: Cents;
  vatCents: Cents;
}

export interface Totals {
  netCents: Cents;
  vatBuckets: VatBucket[];
  vatCents: Cents;
  grossCents: Cents;
  /** Rappenrundung (nur wenn aktiv), kann negativ sein. */
  roundingCents: Cents;
  totalCents: Cents;
}

export interface Payment {
  id: string;
  /** Negativ = Rückbuchung (Gegenbuchung); Zahlungen werden nie gelöscht. */
  amountCents: Cents;
  paidOn: string;
  recordedAt: string;
  recordedBy: string;
}

export interface Invoice {
  id: string;
  tenantId: string;
  kind: InvoiceKind;
  status: InvoiceStatus;
  /** Erst beim Versenden vergeben, lückenlos je Mandant, Art und Jahr. */
  number: string | null;
  seq: number | null;
  customerId: string | null;
  debtor: Address;
  currency: Currency;
  issueDate: string;
  dueDate: string;
  vatMode: VatMode;
  roundTo5: boolean;
  subject: string;
  notes: string;
  lines: InvoiceLine[];
  totals: Totals;
  reference: { type: ReferenceType; value: string | null } | null;
  /** Gutschrift: die korrigierte Rechnung. */
  creditNoteOf: string | null;
  /** Sammelrechnung: Lauf und Zahler (Idempotenz). */
  collectiveRunId: string | null;
  payerKey: string | null;
  payments: Payment[];
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Optimistic Locking. */
  version: number;
}

/** Felder, die nach dem Versenden nie mehr geändert werden dürfen. */
export function frozenView(i: Invoice) {
  return {
    id: i.id,
    tenantId: i.tenantId,
    kind: i.kind,
    number: i.number,
    seq: i.seq,
    customerId: i.customerId,
    debtor: i.debtor,
    currency: i.currency,
    issueDate: i.issueDate,
    dueDate: i.dueDate,
    vatMode: i.vatMode,
    roundTo5: i.roundTo5,
    subject: i.subject,
    notes: i.notes,
    lines: i.lines,
    totals: i.totals,
    reference: i.reference,
    creditNoteOf: i.creditNoteOf,
    collectiveRunId: i.collectiveRunId,
    payerKey: i.payerKey,
    sentAt: i.sentAt,
  };
}

export function computeTotals(
  lines: InvoiceLine[],
  vatMode: VatMode,
  roundTo5: boolean,
  isCreditNote = false,
): Totals {
  if (lines.length === 0) throw new BillingError(422, "Mindestens eine Position nötig.");
  const buckets = new Map<number, VatBucket>();
  let net = 0;
  for (const l of lines) {
    if (
      !Number.isInteger(l.quantityMilli) ||
      !Number.isInteger(l.unitCents) ||
      !Number.isInteger(l.vatRateBp) ||
      l.quantityMilli <= 0 ||
      l.quantityMilli > MAX_QUANTITY_MILLI ||
      Math.abs(l.unitCents) > MAX_UNIT_CENTS ||
      l.vatRateBp < 0 ||
      l.vatRateBp > 2500
    )
      throw new BillingError(422, "Position ausserhalb der zulässigen Werte.");
    if (vatMode === "none" && l.vatRateBp !== 0)
      throw new BillingError(422, "Ohne MwSt muss der Satz 0 sein.");
    if (isCreditNote ? l.unitCents > 0 : l.unitCents < 0)
      throw new BillingError(422, "Vorzeichen der Position passt nicht zum Belegtyp.");
    const ln = lineNetCents(l.quantityMilli, l.unitCents);
    net += ln;
    const b = buckets.get(l.vatRateBp) ?? { rateBp: l.vatRateBp, netCents: 0, vatCents: 0 };
    b.netCents += ln;
    buckets.set(l.vatRateBp, b);
  }
  // MwSt je Satz auf der Summe der Nettobeträge (nicht je Zeile), wie in der MwSt-Abrechnung üblich.
  const vatBuckets = [...buckets.values()]
    .sort((a, b) => a.rateBp - b.rateBp)
    .map((b) => ({ ...b, vatCents: vatCents(b.netCents, b.rateBp) }));
  const vat = vatBuckets.reduce((s, b) => s + b.vatCents, 0);
  const gross = net + vat;
  const total = roundTo5 ? roundTo5Rappen(gross) : gross;
  if (Math.abs(total) > MAX_TOTAL_CENTS) throw new BillingError(422, "Rechnungsbetrag zu gross.");
  return {
    netCents: net,
    vatBuckets,
    vatCents: vat,
    grossCents: gross,
    roundingCents: total - gross,
    totalCents: total,
  };
}

/**
 * Zahlungen, die noch nicht zurückgebucht sind. Eine Rückbuchung (negativer Betrag) hebt genau eine frühere Zahlung
 * gleichen Betrags auf, die zuletzt erfasste zuerst. Zahlungen werden nie gelöscht, die Auswertung ist daher
 * eine reine Funktion der Zahlungsliste.
 */
export function unreturnedPayments(payments: readonly Payment[]): Payment[] {
  const open: Payment[] = [];
  for (const p of payments) {
    if (p.amountCents > 0) {
      open.push(p);
      continue;
    }
    const idx = open.findLastIndex((o) => o.amountCents === -p.amountCents);
    if (idx >= 0) open.splice(idx, 1);
  }
  return open;
}

/** Summe der Zahlungen. */
export function paidCents(i: Pick<Invoice, "payments">): Cents {
  return i.payments.reduce((s, p) => s + p.amountCents, 0);
}

/**
 * Status aus dem Buchungsstand: Entwurf bleibt Entwurf. Sonst "storniert", wenn die Gutschriften
 * den ganzen Betrag aufheben und nichts bezahlt wurde; "bezahlt", wenn nichts mehr offen ist.
 */
export function deriveStatus(i: Invoice, creditedCents: Cents): InvoiceStatus {
  if (i.status === "draft") return "draft";
  if (i.kind === "credit_note") return "sent";
  const total = i.totals.totalCents;
  const paid = paidCents(i);
  if (creditedCents >= total && paid === 0) return "cancelled";
  return total - paid - creditedCents <= 0 ? "paid" : "sent";
}

/** Offener Betrag der Rechnung (Gutschriften als positive Summe in `creditedCents`). */
export function openCents(i: Invoice, creditedCents: Cents): Cents {
  return i.totals.totalCents - paidCents(i) - creditedCents;
}
