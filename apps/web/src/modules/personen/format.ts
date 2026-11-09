import { parseDateInput } from "../../ui/swiss";

const two = (n: number) => String(n).padStart(2, "0");

/** «14.03.1985» aus einem ISO-Datum oder -Zeitpunkt. Leer oder ungültig: «–». */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "–";
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (date) return `${date[3]}.${date[2]}.${date[1]}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** «02.11.2026 · 09:12» */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  return `${formatDate(iso)} · ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Ganze Zahl mit Hochkomma als Tausendertrenner: 1'284 (ui/format). */
export { formatInt, formatChf } from "../../ui/format";

/** «TT.MM.JJJJ» (auch «1.1.27») als ISO-Datum. `null`, wenn das Format nicht stimmt oder das Datum nicht existiert. */
export function parseDate(input: string): string | null {
  const r = parseDateInput(input, { shortYear: true });
  return "iso" in r ? r.iso : null;
}

/** Heutiges Datum als ISO-Datum (lokale Zeit). */
export function todayIso(now = new Date()): string {
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/** Einfache Prüfung auf «name@domain.tld». Die endgültige Prüfung macht der Server. */
export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());

/** «A, B und C» */
export function joinList(items: readonly string[], and: string): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${and} ${items[items.length - 1]}`;
}
