const ZONE = "Europe/Zurich";

const fmt = new Intl.DateTimeFormat("de-CH", {
  timeZone: ZONE,
  weekday: "long",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function parts(iso: string | Date) {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value])) as Record<
    "weekday" | "day" | "month" | "year" | "hour" | "minute",
    string
  >;
}

const day = (p: ReturnType<typeof parts>) => `${p.day}.${p.month}.${p.year}`;
const clock = (p: ReturnType<typeof parts>) => `${p.hour}:${p.minute}`;

/** «06.11.2026 · 23:59» (Zeit in der Schweiz). */
export function formatStamp(iso: string | Date): string {
  const p = parts(iso);
  return `${day(p)} · ${clock(p)}`;
}

/** «Samstag, 14.11.2026 · 17:00–20:00»; über mehrere Tage mit beiden Daten. */
export function formatRange(startIso: string, endIso: string): string {
  const a = parts(startIso);
  const b = parts(endIso);
  const first = `${a.weekday}, ${day(a)} · ${clock(a)}`;
  return day(a) === day(b)
    ? `${first}–${clock(b)}`
    : `${first} – ${b.weekday}, ${day(b)} · ${clock(b)}`;
}
