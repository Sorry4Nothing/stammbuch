const pad = (n: number) => String(n).padStart(2, "0");

const valid = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** «02.11.2026», leer = «–». */
export function formatDate(iso: string | null | undefined): string {
  const d = valid(iso);
  return d ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}` : "–";
}

/** «14:41», leer = «–». */
export function formatTime(iso: string | null | undefined): string {
  const d = valid(iso);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "–";
}

/** «14:41:12», leer = «–». */
export function formatTimeSeconds(iso: string | null | undefined): string {
  const d = valid(iso);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : "–";
}

/** «02.11.2026 08:14», leer = «–». */
export function formatDateTime(iso: string | null | undefined): string {
  const d = valid(iso);
  return d ? `${formatDate(iso)} ${formatTime(iso)}` : "–";
}

/** «12 KB», «1.4 MB». */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Lokales Datum JJJJ-MM-TT für `<input type="date">`. */
export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Lokale Zeit HH:MM für `<input type="time">`. */
export function isoTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Aus Datum und Uhrzeit der Eingabefelder den ISO-Zeitpunkt, `null` bei ungültiger Eingabe. */
export function combineDateTime(day: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const d = new Date(`${day}T${time}:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const BLOCKS = new Set([
  "P",
  "DIV",
  "BR",
  "LI",
  "UL",
  "OL",
  "TR",
  "TABLE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "PRE",
  "HR",
]);

/**
 * Wandelt HTML in Klartext. Der Inhalt einer Mail wird nie als Markup angezeigt (SR-22): `DOMParser`
 * erzeugt ein inertes Dokument ohne Skripte und Bilder, daraus bleibt nur `textContent`.
 */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node.textContent ?? "").replace(/\s+/g, " ");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (["SCRIPT", "STYLE", "HEAD", "TEMPLATE"].includes(el.tagName)) return;
    const block = BLOCKS.has(el.tagName);
    if (block && !out.endsWith("\n")) out += "\n";
    el.childNodes.forEach(walk);
    if (block && !out.endsWith("\n")) out += "\n";
    if (["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE"].includes(el.tagName)) {
      if (!out.endsWith("\n\n")) out += "\n";
    }
  };
  walk(doc.body);
  return out
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const escapeHtml = (s: string) => s.replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Klartext als HTML: Absätze bei Leerzeilen, Zeilenumbruch bei einfachem Umbruch, alles maskiert. */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

const PLACEHOLDERS: Record<string, string> = {
  "[Anrede]": "{{anrede}}",
  "[Name]": "{{name}}",
  "[Antwortlink]": "{{antwortlink}}",
};

/** Die Platzhalter der Oberfläche («[Name]») in die der API («{{name}}») übersetzen. */
export function placeholdersToApi(text: string): string {
  return text.replace(/\[(Anrede|Name|Antwortlink)\]/g, (m) => PLACEHOLDERS[m] ?? m);
}

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

export const isEmail = (s: string) => s.length <= 254 && EMAIL.test(s);

/** «Anna Beispiel <anna@example.ch>» oder «anna@example.ch». `null`, wenn keine gültige Adresse. */
export function parseAddress(input: string): { name: string | null; email: string } | null {
  const text = input.trim();
  const m = /^(.*?)\s*<([^<>]+)>$/.exec(text);
  const email = (m ? m[2]! : text).trim();
  if (!isEmail(email)) return null;
  const name = m ? m[1]!.trim().replace(/^"|"$/g, "") : "";
  return { name: name || null, email };
}

/** Geschätzte Restzeit in Minuten aus dem bisherigen Tempo, `null`, wenn nicht berechenbar. */
export function etaMinutes(
  sent: number,
  queued: number,
  startedAt: string | null,
  now: number,
): number | null {
  const start = valid(startedAt);
  if (!start || sent <= 0 || queued <= 0) return null;
  const elapsed = now - start.getTime();
  if (elapsed <= 0) return null;
  return Math.max(1, Math.ceil(queued / (sent / elapsed) / 60_000));
}
