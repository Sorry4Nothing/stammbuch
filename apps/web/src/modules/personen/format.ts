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

/** Ganze Zahl mit Hochkomma als Tausendertrenner: 1'284. */
export function formatInt(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
}

/** Betrag in Rappen: «CHF 1'250.00». */
export function formatChf(rappen: number): string {
  const sign = rappen < 0 ? "-" : "";
  const abs = Math.abs(rappen);
  const francs = Math.floor(abs / 100);
  return `CHF ${sign}${formatInt(francs)}.${two(abs % 100)}`;
}

/** «TT.MM.JJJJ» als ISO-Datum. `null`, wenn das Format nicht stimmt oder das Datum nicht existiert. */
export function parseDate(input: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(input.trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return `${m[3]}-${m[2]}-${m[1]}`;
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
