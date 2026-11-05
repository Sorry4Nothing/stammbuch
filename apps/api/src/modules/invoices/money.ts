/** Beträge sind überall ganze Rappen (Integer). Nie Fliesskommazahlen für Geld (Projektplan 3.5). */
export type Cents = number;

export const MAX_UNIT_CENTS = 100_000_000; // 1 Mio. CHF je Einheit
export const MAX_QUANTITY_MILLI = 10_000_000; // 10'000 Einheiten (Menge in Tausendsteln)
/** Obergrenze des QR-Betrags (999'999'999.99) und damit jeder Rechnung. */
export const MAX_TOTAL_CENTS = 99_999_999_999;

/** Ganzzahldivision mit kaufmännischer Rundung (0.5 weg von null). */
export function roundDiv(numerator: number, denominator: number): number {
  const q = Math.abs(numerator) / denominator;
  const r = Math.floor(q + 0.5);
  // Exaktheit: Zähler < 2^53 ist durch die Obergrenzen oben garantiert.
  return numerator < 0 ? -r : r;
}

/** Zeilenbetrag: Menge in Tausendsteln mal Einzelpreis in Rappen, auf Rappen gerundet. */
export function lineNetCents(quantityMilli: number, unitCents: Cents): Cents {
  return roundDiv(quantityMilli * unitCents, 1000);
}

/** MwSt in Rappen für einen Nettobetrag; Satz in Basispunkten (810 = 8.1 %). */
export function vatCents(netCents: Cents, rateBp: number): Cents {
  return roundDiv(netCents * rateBp, 10_000);
}

/** Schweizer Rappenrundung auf 5 Rappen. */
export function roundTo5Rappen(cents: Cents): Cents {
  return roundDiv(cents, 5) * 5;
}

/** "1'949.75" (Schweizer Tausendertrenner), ohne Währung. */
export function formatAmount(cents: Cents): string {
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  const frac = String(abs % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}${whole}.${frac}`;
}

/** Betrag für den QR-Payload: Punkt, genau zwei Dezimalstellen, kein Tausendertrenner. */
export function qrAmount(cents: Cents): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** ISO-Datum plus Tage (UTC, ohne Zeitzonen-Effekte). */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 864e5,
  );
}

/** "2026-11-04" -> "04.11.2026" */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}
