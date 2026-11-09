/**
 * Gemeinsame Anzeigeformate. Beträge sind ganze Rappen (wie in der API).
 * Tausendertrenner ist das gerade Hochkomma («1'250.00»), wie schon in allen Modulen und Tests;
 * Minus ist überall das echte Minuszeichen U+2212. Ganzzahl-Rechnung statt Intl, damit die Ausgabe
 * nicht von der ICU-Version abhängt.
 */
const MINUS = "−";

/** «1'250» (Ganzzahl, negativ mit U+2212). */
export function formatInt(n: number): string {
  const v = Math.trunc(n);
  return `${v < 0 ? MINUS : ""}${String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, "'")}`;
}

/** «1'250.00», ohne Währung. */
export function formatAmount(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  const sign = cents < 0 && abs > 0 ? MINUS : "";
  return `${sign}${formatInt(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, "0")}`;
}

/** «CHF 1'250.00», negativ «CHF −1'150.00». */
export function formatChf(cents: number, currency = "CHF"): string {
  return `${currency} ${formatAmount(cents)}`;
}

/** «CH93 0076 2011 6238 5295 7»: Gruppen zu vier Zeichen. */
export function formatIban(iban: string): string {
  return iban
    .replace(/\s+/g, "")
    .replace(/(.{4})/g, "$1 ")
    .trim();
}

/** «791234567» zu «79 123 45 67». */
const group = (nine: string) =>
  `${nine.slice(0, 2)} ${nine.slice(2, 5)} ${nine.slice(5, 7)} ${nine.slice(7)}`;

/**
 * Schweizer Rufnummer: «+41 79 123 45 67» bzw. «079 123 45 67». Andere Formen bleiben unverändert,
 * damit nie etwas Falsches angezeigt wird.
 */
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return "";
  const compact = phone.replace(/[\s().\-/]/g, "");
  const intl = /^(?:\+|00)41(\d{9})$/.exec(compact);
  if (intl) return `+41 ${group(intl[1]!)}`;
  const national = /^0(\d{9})$/.exec(compact);
  if (national) return `0${group(national[1]!)}`;
  return phone;
}
