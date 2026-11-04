/** Alle Beträge sind ganze Rappen (SR/Plan: nie Fliesskomma). Daten sind ISO-Strings `YYYY-MM-DD`. */
export type Cents = number;

export const sumCents = (xs: Iterable<Cents>): Cents => {
  let s = 0;
  for (const x of xs) s += x;
  return s;
};

/** `1234567` -> `"12345.67"`, `-5` -> `"-0.05"`. Rein ganzzahlig, kein Fliesskomma. */
export function formatCents(cents: Cents): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError("Betrag ist keine ganze Rappenzahl.");
  const abs = Math.abs(cents);
  const frac = String(abs % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${frac}`;
}

/** Betrag x Satz (in Basispunkten, 810 = 8.10 %), kaufmännisch auf ganze Rappen gerundet (0.5 weg von 0). */
export function applyRateBp(cents: Cents, rateBp: number): Cents {
  const n = BigInt(cents) * BigInt(rateBp);
  const abs = n < 0n ? -n : n;
  const r = Number((abs + 5000n) / 10000n);
  return n < 0n ? -r : r;
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Ganze Tage von `from` bis `to` (positiv, wenn `to` später liegt). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
