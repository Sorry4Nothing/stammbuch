import { parseDateInput } from "../../ui/swiss";
/**
 * Zeitrechnung des Kalenders. Alle Zeiten gelten in Europe/Zurich, unabhängig von der Zone des Geräts.
 * Tage sind Zeichenketten `JJJJ-MM-TT`, Wandzeiten `JJJJ-MM-TTTHH:mm` (so liefert und erwartet sie die API).
 */

export const ZONE = "Europe/Zurich";
/** Spiegel von RETENTION_MS der API: Event und Rückmeldungen werden 24 Stunden nach dem Ende gelöscht. */
export const RETENTION_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

const wall = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export interface Wall {
  /** `JJJJ-MM-TT` */
  day: string;
  /** `HH:mm` */
  time: string;
  /** `HH:mm:ss` */
  clock: string;
}

/** Wandzeit in Zürich zu einem Zeitpunkt (Millisekunden seit 1970). */
export function wallOf(ms: number): Wall {
  const p = Object.fromEntries(wall.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const time = `${p["hour"]}:${p["minute"]}`;
  return { day: `${p["year"]}-${p["month"]}-${p["day"]}`, time, clock: `${time}:${p["second"]}` };
}

/** `JJJJ-MM-TTTHH:mm` zu einem Zeitpunkt. */
export const localOf = (ms: number): string => {
  const w = wallOf(ms);
  return `${w.day}T${w.time}`;
};

export const dayOf = (local: string): string => local.slice(0, 10);
export const timeOf = (local: string): string => local.slice(11, 16);

// ---------- Tage ----------

function utc(day: string): number {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export const addDays = (day: string, n: number): string => fromUtc(utc(day) + n * DAY_MS);

/** Monat verschieben; der Tag wird auf den letzten Tag des Zielmonats begrenzt. */
export function addMonths(day: string, n: number): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return fromUtc(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last)));
}

/** Montag = 0 … Sonntag = 6 */
export const weekdayIndex = (day: string): number => (new Date(utc(day)).getUTCDay() + 6) % 7;

export const startOfWeek = (day: string): string => addDays(day, -weekdayIndex(day));
export const startOfMonth = (day: string): string => `${day.slice(0, 7)}-01`;
export const monthKey = (day: string): string => day.slice(0, 7);

export const daysBetween = (a: string, b: string): number => Math.round((utc(b) - utc(a)) / DAY_MS);

/** ISO-Kalenderwoche (Donnerstag der Woche bestimmt das Jahr). */
export function isoWeek(day: string): number {
  const thursday = addDays(startOfWeek(day), 3);
  const yearStart = `${thursday.slice(0, 4)}-01-01`;
  return Math.floor(daysBetween(yearStart, thursday) / 7) + 1;
}

/** Anzahl ISO-Wochen des Jahres (52 oder 53). */
export function isoWeeksInYear(year: number): number {
  return isoWeek(`${year}-12-28`);
}

/** Tage des Monatsrasters, Wochen von Montag bis Sonntag, so viele Wochen wie nötig. */
export function monthGrid(day: string): string[][] {
  const first = startOfMonth(day);
  const start = startOfWeek(first);
  const last = addDays(addMonths(first, 1), -1);
  const weeks = Math.floor(daysBetween(start, last) / 7) + 1;
  return Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)),
  );
}

export const weekDays = (day: string): string[] =>
  Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(day), i));

// ---------- Anzeige ----------

export const WEEKDAYS = [
  "Montag",
  "Dienstag",
  "Mittwoch",
  "Donnerstag",
  "Freitag",
  "Samstag",
  "Sonntag",
] as const;
export const WEEKDAYS_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const;
export const MONTHS = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
] as const;

export const weekdayName = (day: string): string => WEEKDAYS[weekdayIndex(day)]!;

/** `14.11.2026` */
export function formatDay(day: string): string {
  const [y, m, d] = day.split("-");
  return `${d}.${m}.${y}`;
}

/** `14.11.` (ohne Jahr) mit Tag und Monat ohne führende Null: `1.11.` */
export function formatDayMonth(day: string): string {
  return `${Number(day.slice(8, 10))}.${Number(day.slice(5, 7))}.`;
}

/** `November 2026` */
export function formatMonth(day: string): string {
  return `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
}

/** `02.11.2026 14:28` */
export function formatStamp(ms: number): string {
  const w = wallOf(ms);
  return `${formatDay(w.day)} ${w.time}`;
}

/** Eingabe `TT.MM.JJJJ` (auch `1.1.27`) → `JJJJ-MM-TT`; `null`, wenn kein gültiges Datum. */
export function parseDay(input: string): string | null {
  const r = parseDateInput(input, { shortYear: true });
  return "iso" in r && r.iso <= "2200-12-31" ? r.iso : null;
}

/** Eingabe `HH:MM` → `HH:mm`; `null`, wenn keine gültige Uhrzeit. */
export function parseClock(input: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(input.trim());
  if (!m) return null;
  const [h, mi] = [Number(m[1]), Number(m[2])];
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

/** Minuten seit Mitternacht zu `HH:mm`. */
export const minutesOf = (time: string): number =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Zeitpunkt der automatischen Löschung eines Events. */
export const deletionAt = (endsAtIso: string): number => Date.parse(endsAtIso) + RETENTION_MS;

/**
 * Wandzeit `JJJJ-MM-TTTHH:mm` in Zürich als Zeitpunkt (Millisekunden). Bei der doppelten Stunde im Herbst
 * gilt die erste (Sommerzeit); eine Zeit, die es nicht gibt (Sprung im Frühling), rutscht auf die gültige.
 */
export function instantOf(local: string): number {
  const base = Date.parse(`${local}:00Z`);
  for (const hours of [2, 1]) {
    const ms = base - hours * 3_600_000;
    if (localOf(ms) === local) return ms;
  }
  return base - 3_600_000;
}
