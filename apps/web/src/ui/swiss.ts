import { t } from "../i18n";

/**
 * Prüfregeln für Schweizer Stammdaten, gleich wie in der API (`packages/shared/src/swiss.ts`).
 * Die Web-App lädt `zod` nicht; ein Test vergleicht beide Umsetzungen (swiss.test.ts).
 */

/** Telefonnummer -> E.164. Akzeptiert 079 123 45 67, +41 79 123 45 67, 0041 79 ..., +41 (0)79 ... */
export function normalizePhone(input: string): string | null {
  let s = input.trim().replace(/\(0\)/g, "");
  if (!/^[+\d\s().\-/]+$/.test(s)) return null;
  s = s.replace(/[\s().\-/]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  else if (s.startsWith("0")) s = "+41" + s.slice(1);
  if (!/^\+[1-9]\d{7,14}$/.test(s)) return null;
  if (s.startsWith("+41") && s.length !== 12) return null;
  return s;
}

/** «+41791234567» als «+41 79 123 45 67». Andere und ungültige Eingaben bleiben unverändert. */
export function formatPhone(value: string | null | undefined): string {
  if (!value) return "";
  const n = normalizePhone(value);
  const m = n && /^\+41(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(n);
  return m ? `+41 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : value;
}

function uidCheckDigitValid(digits: string): boolean {
  const weights = [5, 4, 3, 2, 7, 6, 5, 4];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(digits[i]), 0);
  const rest = sum % 11;
  const check = rest === 0 ? 0 : 11 - rest;
  return check !== 10 && check === Number(digits[8]);
}

const UID_PATTERN = /^CHE[-\s]?(\d{3})[.\s]?(\d{3})[.\s]?(\d{3})(?:\s*(MWST|TVA|IVA))?$/i;

/** Die 9 Ziffern der UID (mit Prüfziffer) oder `null`; `suffix` gilt für MWST/TVA/IVA. */
export function parseUid(input: string): { digits: string; suffix: boolean } | null {
  const m = UID_PATTERN.exec(input.trim());
  if (!m) return null;
  const digits = `${m[1]}${m[2]}${m[3]}`;
  return uidCheckDigitValid(digits) ? { digits, suffix: Boolean(m[4]) } : null;
}

/** UID ohne Zusatz (CHE-123.456.789) mit gültiger Prüfziffer. */
export const isUid = (v: string) => parseUid(v) !== null;
/** MwSt-Nummer: UID mit Zusatz MWST/TVA/IVA. */
export const isMwstNr = (v: string) => parseUid(v)?.suffix === true;

/** http- oder https-Adresse bis 200 Zeichen, wie `z.httpUrl()` der API. */
export function isHttpUrl(v: string): boolean {
  if (v.length > 200) return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export type DateParse = { iso: string } | { error: "format" | "invalid" };

/**
 * «TT.MM.JJJJ» nach ISO. Tolerant bei «1.1.2027» und, mit `shortYear`, bei «1.1.27» (= 2027).
 * `format`: so lässt sich nichts lesen. `invalid`: das Format stimmt, den Tag gibt es nicht.
 */
export function parseDateInput(text: string, opts: { shortYear?: boolean } = {}): DateParse {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(text.trim());
  if (!m || (m[3]!.length === 2 && !opts.shortYear)) return { error: "format" };
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (
    y < 1900 ||
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== mo - 1 ||
    probe.getUTCDate() !== d
  ) {
    return { error: "invalid" };
  }
  const two = (n: number) => String(n).padStart(2, "0");
  return { iso: `${y}-${two(mo)}-${two(d)}` };
}

/** Fehlertext zu einer Datumseingabe, `undefined` wenn gültig. Leer ist hier gültig (Pflicht prüft der Aufrufer). */
export function dateError(text: string, opts: { shortYear?: boolean } = {}): string | undefined {
  if (!text.trim()) return undefined;
  const r = parseDateInput(text, opts);
  if ("iso" in r) return undefined;
  return r.error === "invalid" ? t("ui.date.invalid") : t("ui.date.format");
}
