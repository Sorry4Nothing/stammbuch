/**
 * Datenmodell und reine Hilfsfunktionen des Rechnungsmoduls. Beträge sind überall ganze Rappen
 * (wie in der API), nie Fliesskommazahlen. Die Formen entsprechen den Antworten der Routen
 * unter `/invoices` (apps/api/src/modules/invoices).
 */

export interface Address {
  name: string;
  street?: string | undefined;
  buildingNumber?: string | undefined;
  postalCode: string;
  town: string;
  country: string;
}

export interface InvoiceLine {
  description: string;
  /** Menge in Tausendsteln (1500 = 1.5). */
  quantityMilli: number;
  unitCents: number;
  /** MwSt-Satz in Basispunkten (810 = 8.1 %). */
  vatRateBp: number;
  /** Ertragskonto der Position; fehlt es, gilt das Standardkonto des Mandanten. */
  accountCode?: string | null | undefined;
}

export interface VatBucket {
  rateBp: number;
  netCents: number;
  vatCents: number;
}

export interface Totals {
  netCents: number;
  vatBuckets: VatBucket[];
  vatCents: number;
  grossCents: number;
  roundingCents: number;
  totalCents: number;
}

export interface Payment {
  id: string;
  amountCents: number;
  paidOn: string;
  recordedAt: string;
}

export type ApiStatus = "draft" | "sent" | "paid" | "cancelled";

export interface Invoice {
  id: string;
  kind: "invoice" | "credit_note";
  status: ApiStatus;
  number: string | null;
  customerId: string | null;
  /** Mitgliedsnummer der Person beim Erfassen (Momentaufnahme, Format `M-1042`); fehlt bei Firmen und älteren Belegen. */
  memberNumber?: string | null;
  debtor: Address;
  currency: "CHF" | "EUR";
  issueDate: string;
  dueDate: string;
  vatMode: "none" | "exclusive";
  roundTo5: boolean;
  subject: string;
  notes: string;
  lines: InvoiceLine[];
  totals: Totals;
  reference: { type: "QRR" | "SCOR" | "NON"; value: string | null } | null;
  creditNoteOf: string | null;
  payments: Payment[];
  sentAt: string | null;
  createdAt: string;
  version: number;
  paidCents: number;
  creditedCents: number;
  openCents: number;
}

export interface DunningLevel {
  level: number;
  title: string;
  waitDays: number;
  graceDays: number;
  feeCents: number;
}

export interface Reminder {
  id: string;
  invoiceId: string;
  level: number;
  title: string;
  issuedOn: string;
  dueOn: string;
  feeCents: number;
  openCents: number;
  totalCents: number;
  createdAt: string;
}

export interface BillingSettings {
  creditor: Address;
  iban: string;
  vatNumber: string | null;
  contactLines: string[];
  paymentTermDays: number;
  defaultVatMode: "none" | "exclusive";
  defaultVatRateBp: number;
  roundTo5: boolean;
  /** Standard-Ertragskonto für Positionen ohne eigenes Konto (fehlt: 3400). */
  defaultRevenueAccount?: string | null | undefined;
  dunning: { levels: DunningLevel[] };
  features: { collectiveInvoicing: boolean };
}

/** Person oder Firma, an die eine Rechnung geht. */
export interface Recipient {
  id: string;
  /** Anzeigename, z. B. «Beispiel Treuhand AG». */
  name: string;
  address: Address;
  email: string | null;
}

// --- Anzeige-Status -------------------------------------------------------------------------

export type DisplayStatus = "draft" | "open" | "reminded" | "paid" | "cancelled" | "credited";

/** Eine Zeile der Rechnungsliste: Beleg samt abgeleitetem Status und erreichter Mahnstufe. */
export interface InvoiceRow {
  invoice: Invoice;
  status: DisplayStatus;
  /** Erreichte Mahnstufe, 0 = keine. */
  level: number;
  levelTitle: string | null;
  /** Tage über Fälligkeit, nur bei offenen Rechnungen nach Ablauf. */
  overdueDays: number | null;
}

/** Anzeige-Status. «Offen» umfasst auch überfällige und gemahnte Rechnungen (Filter «Offen»). */
export function displayStatus(inv: Invoice, level: number): DisplayStatus {
  if (inv.status === "draft") return "draft";
  if (inv.status === "cancelled") return "cancelled";
  if (inv.status === "paid") return "paid";
  if (inv.creditedCents > 0 && inv.openCents <= 0) return "credited";
  return level > 0 ? "reminded" : "open";
}

export function isOpen(row: InvoiceRow): boolean {
  return row.status === "open" || row.status === "reminded";
}

export function isOverdue(row: InvoiceRow): boolean {
  return isOpen(row) && row.overdueDays !== null;
}

export function toRow(inv: Invoice, reminders: readonly Reminder[], today: string): InvoiceRow {
  const last = reminders.reduce<Reminder | null>((m, r) => (m && m.level >= r.level ? m : r), null);
  const level = last?.level ?? 0;
  const status = displayStatus(inv, level);
  const days = daysBetween(inv.dueDate, today);
  return {
    invoice: inv,
    status,
    level,
    levelTitle: last?.title ?? null,
    overdueDays: (status === "open" || status === "reminded") && days > 0 ? days : null,
  };
}

// --- Formate --------------------------------------------------------------------------------

/** «1'250.00», ohne Währung. */
export function amount(cents: number): string {
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return `${cents < 0 ? "-" : ""}${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** «CHF 1'250.00» */
export function chf(cents: number, currency = "CHF"): string {
  return `${currency} ${amount(cents)}`;
}

/** «2026-11-02» wird «02.11.2026». */
export function date(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

const zurich = new Intl.DateTimeFormat("de-CH", {
  timeZone: "Europe/Zurich",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** «02.11.2026 14:05» in Schweizer Ortszeit. */
export function dateTime(iso: string): string {
  const p = Object.fromEntries(zurich.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}

export function todayIso(now: number = Date.now()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(now);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 864e5,
  );
}

/** «TT.MM.JJJJ» zu ISO-Datum, `null` bei ungültiger Eingabe. */
export function parseDate(text: string): string | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const [, d, mo, y] = m;
  const iso = `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

/** «250.00», «1'250» oder «250,5» zu Rappen, `null` bei ungültiger Eingabe. */
export function parseAmount(text: string): number | null {
  const m = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(text.trim().replace(/['’\s]/g, ""));
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** «8» oder «1.5» zu Tausendsteln, `null` bei ungültiger Eingabe. */
export function parseQuantity(text: string): number | null {
  const m = /^(\d{1,5})(?:[.,](\d{1,3}))?$/.exec(text.trim());
  if (!m) return null;
  const milli = Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0"));
  return milli > 0 ? milli : null;
}

export function quantity(milli: number): string {
  const whole = Math.floor(milli / 1000);
  const frac = String(milli % 1000)
    .padStart(3, "0")
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/** «8.1 %», ohne Satz «–». */
export function vat(rateBp: number): string {
  if (rateBp === 0) return "–";
  return `${rateBp / 100} %`;
}

/** Bruchteil als Satz-Text im Summenblock: «8.1 %» auch bei 0. */
export function vatRate(rateBp: number): string {
  return `${rateBp / 100} %`;
}

export function lineNet(l: Pick<InvoiceLine, "quantityMilli" | "unitCents">): number {
  return roundDiv(l.quantityMilli * l.unitCents, 1000);
}

function roundDiv(n: number, d: number): number {
  const r = Math.floor(Math.abs(n) / d + 0.5);
  return n < 0 ? -r : r;
}

/** Summen wie der Server (`computeTotals`): MwSt je Satz auf der Summe der Nettobeträge. */
export function computeTotals(
  lines: readonly InvoiceLine[],
  vatMode: "none" | "exclusive",
  roundTo5: boolean,
): Totals {
  const buckets = new Map<number, VatBucket>();
  let net = 0;
  for (const l of lines) {
    const n = lineNet(l);
    net += n;
    const rate = vatMode === "none" ? 0 : l.vatRateBp;
    const b = buckets.get(rate) ?? { rateBp: rate, netCents: 0, vatCents: 0 };
    b.netCents += n;
    buckets.set(rate, b);
  }
  const vatBuckets = [...buckets.values()]
    .sort((a, b) => a.rateBp - b.rateBp)
    .map((b) => ({ ...b, vatCents: roundDiv(b.netCents * b.rateBp, 10_000) }));
  const vatSum = vatBuckets.reduce((s, b) => s + b.vatCents, 0);
  const gross = net + vatSum;
  const total = roundTo5 ? roundDiv(gross, 5) * 5 : gross;
  return {
    netCents: net,
    vatBuckets,
    vatCents: vatSum,
    grossCents: gross,
    roundingCents: total - gross,
    totalCents: total,
  };
}

/** «CH00 0000 0000 0000 0000 0» */
export function formatIban(iban: string): string {
  return iban
    .replace(/\s+/g, "")
    .replace(/(.{4})/g, "$1 ")
    .trim();
}

/** QR-Referenz «00 00000 00000 00000 04310 00007», SCOR in Vierergruppen. */
export function formatReference(ref: { type: string; value: string | null } | null): string {
  if (!ref?.value) return "";
  if (ref.type === "QRR")
    return ref.value.replace(/^(\d{2})(\d{5})(\d{5})(\d{5})(\d{5})(\d{5})$/, "$1 $2 $3 $4 $5 $6");
  return ref.value.replace(/(.{4})/g, "$1 ").trim();
}

/** Adresszeilen für Papier und Rechnungsadresse: Name, Strasse, PLZ Ort. */
export function addressLines(a: Address): string[] {
  const street = [a.street, a.buildingNumber].filter(Boolean).join(" ");
  return [a.name, street, `${a.postalCode} ${a.town}`].filter((x) => x.length > 0);
}

/**
 * Payload der QR-Rechnung (SIX, Version 0200, strukturierte Adressen). Nur zur Anzeige des Codes im
 * Papier; Gültigkeit und PDF bleiben beim Server (`qrbill.ts`).
 */
export function qrPayload(args: {
  iban: string;
  creditor: Address;
  debtor: Address;
  amountCents: number;
  currency: string;
  reference: { type: string; value: string | null } | null;
  message: string;
}): string {
  const addr = (a: Address) => [
    "S",
    a.name,
    a.street ?? "",
    a.buildingNumber ?? "",
    a.postalCode,
    a.town,
    a.country,
  ];
  const ref = args.reference?.value ? args.reference : { type: "NON", value: "" };
  return [
    "SPC",
    "0200",
    "1",
    args.iban.replace(/\s+/g, ""),
    ...addr(args.creditor),
    ...["", "", "", "", "", "", ""],
    `${Math.floor(args.amountCents / 100)}.${String(args.amountCents % 100).padStart(2, "0")}`,
    args.currency,
    ...addr(args.debtor),
    ref.type,
    ref.value ?? "",
    args.message,
    "EPD",
  ].join("\n");
}

// --- Mahnstufen -----------------------------------------------------------------------------

/** «2 · 1. Mahnung», ohne Stufe «Keine». */
export function levelLabel(level: number, title: string | null, none: string): string {
  return level > 0 && title ? `${level} · ${title}` : none;
}

/** Tag nach Fälligkeit, ab dem eine Stufe fällig wird (Stufe 1: Wartezeit, danach Frist der Vorstufe plus Wartezeit). */
export function levelStartDay(levels: readonly DunningLevel[], level: number): number {
  let day = 0;
  for (const l of levels) {
    if (l.level > level) break;
    const previous = levels[l.level - 2];
    day += (previous?.graceDays ?? 0) + l.waitDays;
  }
  return day;
}

export type DunningNext =
  | { kind: "due"; level: DunningLevel }
  | { kind: "later"; level: DunningLevel; day: number }
  | { kind: "last" };

/** Nächster Schritt einer überfälligen Rechnung. `dueLevel` kommt vom Server (Stichtag, Wartezeiten). */
export function nextStep(
  row: InvoiceRow,
  levels: readonly DunningLevel[],
  dueLevel: DunningLevel | undefined,
): DunningNext {
  if (dueLevel) return { kind: "due", level: dueLevel };
  const next = levels[row.level];
  if (!next) return { kind: "last" };
  return { kind: "later", level: next, day: levelStartDay(levels, next.level) };
}
