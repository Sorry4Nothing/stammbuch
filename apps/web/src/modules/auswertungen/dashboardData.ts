import type { StatementRow } from "./types";

/** Dasselbe Datum ein Jahr früher; der 29. Februar fällt auf den 28. */
export function shiftYear(iso: string, years: number): string {
  const y = +iso.slice(0, 4) + years;
  const md = iso.slice(5, 10);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return `${y}-${md === "02-29" && !leap ? "02-28" : md}`;
}

/** Veränderung in Prozent gegenüber `prev`; ohne Vergleichswert (0) gibt es keine sinnvolle Prozentzahl. */
export function percentChange(cur: number, prev: number): number | undefined {
  return prev === 0 ? undefined : ((cur - prev) / Math.abs(prev)) * 100;
}

/** «+12.3 %» bzw. «−4.0 %» (Betrag mit echtem Minuszeichen). */
export function formatPercent(pct: number, signed = true): string {
  const sign = pct < 0 ? "−" : signed && pct > 0 ? "+" : "";
  return `${sign}${Math.abs(pct).toFixed(1)} %`;
}

export interface CompositionSlice {
  key: string;
  label: string;
  value: number;
}

/**
 * Ertrag nach Konto für den Ring: die grössten `top` Konten, der Rest als «Übrige». Konten mit negativem
 * Ertrag (Erlösminderungen) lassen sich nicht als Anteil zeichnen; ihre Summe kommt getrennt zurück.
 */
export function composition(
  revenue: readonly StatementRow[],
  other: string,
  top = 5,
): { slices: CompositionSlice[]; excludedCents: number } {
  const positive = revenue
    .filter((r) => r.amountCents > 0)
    .sort((a, b) => b.amountCents - a.amountCents);
  const slices = positive
    .slice(0, top)
    .map((r) => ({ key: r.number, label: `${r.number} ${r.name}`, value: r.amountCents }));
  const rest = positive.slice(top).reduce((s, r) => s + r.amountCents, 0);
  if (rest > 0) slices.push({ key: "other", label: other, value: rest });
  return {
    slices,
    excludedCents: revenue.filter((r) => r.amountCents < 0).reduce((s, r) => s + r.amountCents, 0),
  };
}
