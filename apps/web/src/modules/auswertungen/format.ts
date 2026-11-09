/** Beträge sind ganze Rappen (wie in der API); die Anzeige folgt «CHF 1'250.00». */
const MINUS = "−";

/** «1'250.00», negative Beträge mit echtem Minuszeichen. */
export function formatAmount(cents: number): string {
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  const rest = String(abs % 100).padStart(2, "0");
  return `${cents < 0 ? MINUS : ""}${whole}.${rest}`;
}

/** «CHF 1'250.00» */
export function formatChf(cents: number): string {
  return `CHF ${formatAmount(cents)}`;
}

/** «2026-11-02» wird zu «02.11.2026». */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** «2026-11-02T13:52:00Z» wird zu «02.11.2026 14:52» (Ortszeit). */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Ortszeit-Datum (ISO) zu einem Zeitstempel. */
export function isoDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const DAY = 86_400_000;
const utc = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));

/** Ganze Tage von `from` bis `to` (negativ, wenn `to` früher liegt). */
export function daysBetween(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / DAY);
}

const utcIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Tag vor dem angegebenen Datum. */
export function previousDay(iso: string): string {
  return utcIso(utc(iso) - DAY);
}

/** Tag nach dem angegebenen Datum. */
export function nextDay(iso: string): string {
  return utcIso(utc(iso) + DAY);
}

const monthFmt = new Intl.DateTimeFormat("de-CH", { month: "long", timeZone: "UTC" });

/** «Oktober» für ein ISO-Datum. */
export function monthName(iso: string): string {
  return monthFmt.format(new Date(utc(iso)));
}

/** Geschäftsjahr, in dem `today` liegt: Beginn und Kennzahl (Jahr des Beginns). */
export function fiscalYearOf(today: string, startMonth: number): { year: number; from: string } {
  const y = +today.slice(0, 4);
  const m = +today.slice(5, 7);
  const year = m >= startMonth ? y : y - 1;
  return { year, from: `${year}-${pad(startMonth)}-01` };
}
