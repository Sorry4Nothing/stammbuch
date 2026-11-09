import type { AccountType, Entry, EntryKind, EntryLine, Rappen } from "./types";

/** «CHF 1'250.00», negativ «CHF −1'150.00» (ui/format). */
export { formatChf as chf } from "../../ui/format";

/** «1'426» */
export { formatInt as count } from "../../ui/format";

/** ISO-Datum nach «02.11.2026». */
export function chDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Heutiges Datum (lokale Zeit) als ISO. */
export function isoDay(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** «TT.MM.JJJJ» nach ISO; `null`, wenn kein echtes Datum. */
export function parseChDate(text: string): string | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** Ganze Tage von `from` bis `to` (ISO); negativ, wenn `to` früher liegt. */
export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** «B-2026-1861» */
export const belegNr = (e: Pick<Entry, "number" | "bookingDate">): string =>
  `B-${e.bookingDate.slice(0, 4)}-${String(e.number).padStart(4, "0")}`;

/** QR-Referenz in Gruppen: «00 00000 00000 00000 03830 00001». */
export function qrReference(ref: string | undefined): string {
  if (!ref) return "–";
  const compact = ref.replace(/\s+/g, "");
  return compact.replace(/^(\d{2})(\d{5})(\d{5})(\d{5})(\d{5})(\d{5})$/, "$1 $2 $3 $4 $5 $6");
}

/** Gruppen von vier Zeichen: «a41c 9e07 5b2d 83f0». */
export const groups4 = (hex: string): string => hex.replace(/(.{4})(?!$)/g, "$1 ");

export interface PairedRow {
  debit: string;
  credit: string;
  amount: Rappen;
}

/**
 * Die Buchung besteht aus Soll- und Haben-Zeilen; die Ansicht zeigt je Zeile ein Kontenpaar
 * (Sammelbuchung: eine Seite wird auf die Gegenseite aufgeteilt).
 */
export function pairLines(lines: readonly EntryLine[]): PairedRow[] {
  const side = (s: EntryLine["side"]) =>
    lines.filter((l) => l.side === s).map((l) => ({ code: l.accountCode, left: l.amount }));
  const debit = side("debit");
  const credit = side("credit");
  const rows: PairedRow[] = [];
  let i = 0;
  let j = 0;
  while (debit[i] && credit[j]) {
    const d = debit[i]!;
    const c = credit[j]!;
    const amount = Math.min(d.left, c.left);
    rows.push({ debit: d.code, credit: c.code, amount });
    d.left -= amount;
    c.left -= amount;
    if (d.left === 0) i++;
    if (c.left === 0) j++;
  }
  return rows;
}

export const accountTypes: readonly AccountType[] = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
];

/** Schweizer Steuersätze in Basispunkten (8.1 %, 2.6 %, 3.8 %). Kein Satz = ohne Steuer. */
export const taxRates: readonly number[] = [810, 260, 380];

/** «810» wird zu «8.1 %». */
export const taxRateLabel = (bp: number | undefined): string =>
  bp === undefined ? "–" : `${(bp / 100).toString()} %`;

/** Wo die API einen Satz zulässt: Erlös- und Aufwandkonten, Steuerkonten (22xx, 117x). */
export function taxRateAllowed(type: AccountType, code: string): boolean {
  if (type === "revenue" || type === "expense") return true;
  if (type === "liability") return /^22\d{2,4}$/.test(code);
  if (type === "asset") return /^117\d{1,3}$/.test(code);
  return false;
}

export const entryKinds: readonly EntryKind[] = [
  "invoice",
  "payment",
  "reversal",
  "credit_note",
  "manual",
];
