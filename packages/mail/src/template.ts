import { MailError } from "./net-guard.js";

/** Immer verfügbare Platzhalter. Empfängerwerte kommen aus den Empfängerdaten, nie aus der Vorlage. */
export const BUILTIN_PLACEHOLDERS = [
  "anrede",
  "name",
  "vorname",
  "nachname",
  "email",
  "antwortlink",
] as const;

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/gi;

export function placeholdersIn(template: string): string[] {
  return [
    ...new Set([...template.matchAll(PLACEHOLDER)].map((m) => (m[1] as string).toLowerCase())),
  ];
}

/** Wirft VALIDATION bei Platzhaltern ausserhalb der Allowlist (kein freies Template-Language-Feature). */
export function assertKnownPlaceholders(template: string, allowed: readonly string[]) {
  if (placeholdersIn(template).some((p) => !allowed.includes(p))) throw new MailError("VALIDATION");
}

export type RenderMode = "html" | "text" | "header";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;",
}; // prettier-ignore

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c] as string);
}

/** Entfernt Zeilenumbrüche und Steuerzeichen (Header-Injection, SR-20). */
export function headerSafe(value: string, max = 998): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, " ")
      .trim()
      .slice(0, max)
  );
}

/**
 * Setzt Platzhalter in einem Durchgang ein. Eingesetzte Werte werden nie erneut auf
 * Platzhalter geprüft und je nach Ziel maskiert (HTML-Escape, Header ohne Zeilenumbruch).
 * Unbekannte oder fehlende Werte ergeben einen leeren Text, nie den Platzhalter-Namen
 * oder einen Fehlerstack. Kein `eval`, keine Ausdrücke, kein Zugriff auf Objekt-Prototypen.
 */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, string | undefined>>,
  mode: RenderMode,
): string {
  return template.replace(PLACEHOLDER, (_m, rawName: string) => {
    const name = rawName.toLowerCase();
    const value = Object.hasOwn(values, name) ? (values[name] ?? "") : "";
    if (mode === "html") return escapeHtml(value);
    if (mode === "header") return headerSafe(value);
    return value;
  });
}
