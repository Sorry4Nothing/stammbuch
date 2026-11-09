import type { Customer, CustomerStatus } from "./model";

const ZONE = "Europe/Zurich";
const MS_PER_DAY = 86_400_000;

const dateTime = new Intl.DateTimeFormat("de-CH", {
  timeZone: ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const parts = (fmt: Intl.DateTimeFormat, d: Date) =>
  Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));

/** «2026-12-31» wird «31.12.2026». Leere oder fehlende Werte ergeben «–». */
export function formatDate(iso: string | null | undefined): string {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "–";
}

/** Zeitstempel in Zürcher Zeit: «02.11.2026 09:30». */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  const p = parts(dateTime, d);
  return `${p["day"]}.${p["month"]}.${p["year"]} ${p["hour"]}:${p["minute"]}`;
}

/** «31.12.2026» wird «2026-12-31». Ungültige Tage (30.02.) und falsche Formate ergeben `null`. */
export function parseDate(text: string): string | null {
  const m = text.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Heutiges Datum in Zürcher Zeit, JJJJ-MM-TT. */
export function today(now: number): string {
  return dayFmt.format(new Date(now));
}

/** Tage von heute bis zum Enddatum (negativ, wenn es vorbei ist). */
export function daysUntil(iso: string, now: number): number {
  const a = Date.parse(`${today(now)}T00:00:00Z`);
  const b = Date.parse(`${iso}T00:00:00Z`);
  return Math.round((b - a) / MS_PER_DAY);
}

/** Anzeige-Zustand: ein aktiver Kunde mit vergangenem Lizenzende gilt als abgelaufen. */
export type DisplayStatus = CustomerStatus | "expired";

export function displayStatus(c: Pick<Customer, "status" | "licenceUntil">, now: number) {
  return c.status === "active" && daysUntil(c.licenceUntil, now) < 0
    ? ("expired" as const)
    : c.status;
}

/** Vorschlag für die Kunden-ID aus dem Namen, wie ihn die API vergibt (Umlaute umschreiben, Rest zu «-»). */
export function refPreview(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 63)
    .replace(/^-+|-+$/g, "");
}
