import { createHash } from "node:crypto";

/** Alle Beträge sind ganze Rappen (Integer). Nie Fliesskomma, nie CHF-Dezimal. */
export type Rappen = number;
/** CHF 10 Mrd. Obergrenze, damit Summen sicher im Integer-Bereich von `number` bleiben. */
export const MAX_AMOUNT: Rappen = 1_000_000_000_000;
export const MAX_LINES = 100;

export type Side = "debit" | "credit";
export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";
export type EntryKind = "manual" | "invoice" | "credit_note" | "payment" | "reversal";

/** Sammelkonto Debitoren: nur über Rechnungen/Zahlungen bebuchbar, immer mit Person. */
export const DEBTOR_CONTROL_ACCOUNT = "1100";
export const GENESIS_HASH = "0".repeat(64);

export interface Account {
  code: string;
  name: string;
  type: AccountType;
  active: boolean;
}

export interface EntryLine {
  accountCode: string;
  side: Side;
  amount: Rappen;
  /** Nur auf dem Debitoren-Sammelkonto, dort Pflicht (Debitorenkonto einer Person). */
  personId?: string;
}

export interface JournalEntry {
  id: string;
  /** Lückenlos aufsteigend je Mandant (Belegnummer). */
  number: number;
  /** ISO-Datum YYYY-MM-DD. */
  bookingDate: string;
  kind: EntryKind;
  description: string;
  lines: readonly EntryLine[];
  reversalOf: string | null;
  createdAt: string;
  createdBy: string;
  /** Frühestes Datum, ab dem eine Löschung erlaubt wäre (Art. 958f OR: 10 Jahre ab Geschäftsjahresende). */
  retentionUntil: string;
  prevHash: string;
  hash: string;
}

export type DomainCode =
  "NOT_FOUND" | "CONFLICT" | "PERIOD_CLOSED" | "UNBALANCED" | "RULE_VIOLATION";
const statusOf: Record<DomainCode, number> = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  PERIOD_CLOSED: 409,
  UNBALANCED: 422,
  RULE_VIOLATION: 422,
};

/** Erwarteter Fachfehler. Der Text ist fest formuliert und enthält keine internen Details (SR-51). */
export class DomainError extends Error {
  readonly status: number;
  constructor(
    readonly code: DomainCode,
    message: string,
  ) {
    super(message);
    this.status = statusOf[code];
  }
}

export function normalSide(type: AccountType): Side {
  return type === "asset" || type === "expense" ? "debit" : "credit";
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Buchungsperiode = Monat, `YYYY-MM`. */
export const periodOf = (date: string): string => date.slice(0, 7);

export function retentionUntil(bookingDate: string): string {
  return `${Number(bookingDate.slice(0, 4)) + 10}-12-31`;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Soll muss gleich Haben sein; mindestens zwei Zeilen, jeder Betrag positiv und ganzzahlig. */
export function assertBalanced(lines: readonly EntryLine[]): void {
  if (lines.length < 2 || lines.length > MAX_LINES) {
    throw new DomainError("UNBALANCED", "Eine Buchung braucht 2 bis 100 Zeilen.");
  }
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amount) || l.amount <= 0 || l.amount > MAX_AMOUNT) {
      throw new DomainError("UNBALANCED", "Ungültiger Betrag.");
    }
    if (l.side === "debit") debit += l.amount;
    else credit += l.amount;
  }
  if (debit !== credit) throw new DomainError("UNBALANCED", "Soll und Haben sind nicht gleich.");
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Hash über den Inhalt und den Vorgänger: nachträgliche Änderung bricht die Kette (GeBüV). */
export function entryHash(tenantId: string, e: Omit<JournalEntry, "hash" | "id">): string {
  return sha256(
    stableStringify([
      tenantId,
      e.prevHash,
      e.number,
      e.bookingDate,
      e.kind,
      e.description,
      e.lines.map((l) => [l.accountCode, l.side, l.amount, l.personId ?? null]),
      e.reversalOf,
      e.createdAt,
      e.createdBy,
      e.retentionUntil,
    ]),
  );
}

/**
 * Kontenrahmen-Vorlage für Vereine/KMU nach Schweizer Kontenrahmen (KMU, Käfer). Vorlage,
 * pro Mandant erweiterbar; vor Produktivbetrieb mit Treuhänder prüfen.
 */
export const DEFAULT_CHART: readonly Account[] = (
  [
    ["1000", "Kasse", "asset"],
    ["1020", "Bank", "asset"],
    ["1100", "Forderungen aus Lieferungen und Leistungen (Debitoren)", "asset"],
    ["1109", "Delkredere", "asset"],
    ["1170", "Vorsteuer auf Material- und Dienstleistungsaufwand", "asset"],
    ["1300", "Aktive Rechnungsabgrenzung", "asset"],
    ["2000", "Verbindlichkeiten aus Lieferungen und Leistungen (Kreditoren)", "liability"],
    ["2200", "Geschuldete Mehrwertsteuer (Umsatzsteuer)", "liability"],
    ["2201", "Abrechnungskonto Mehrwertsteuer", "liability"],
    ["2300", "Passive Rechnungsabgrenzung (im Voraus bezahlte Beiträge)", "liability"],
    ["2800", "Vereinsvermögen / Eigenkapital", "equity"],
    ["2979", "Jahresgewinn oder Jahresverlust", "equity"],
    ["3000", "Mitgliederbeiträge", "revenue"],
    ["3200", "Erlös aus Anlässen und Veranstaltungen", "revenue"],
    ["3400", "Erlös aus Dienstleistungen", "revenue"],
    ["3600", "Übrige Erlöse (z. B. Mahngebühren)", "revenue"],
    ["3800", "Erlösminderungen", "expense"],
    ["3805", "Verluste aus Forderungen (Debitorenverluste)", "expense"],
    ["6940", "Bankspesen", "expense"],
    ["6950", "Finanzertrag", "revenue"],
  ] as const
).map(([code, name, type]) => ({ code, name, type, active: true }));
