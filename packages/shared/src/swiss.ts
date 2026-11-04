import { z } from "zod";

/**
 * Validierung und Normalisierung schweizerischer Stammdaten. Die Schemas normalisieren in der
 * Eingabe (Telefon -> E.164, UID -> CHE-123.456.789), damit Speicherung und Duplikaterkennung
 * auf einer Form arbeiten.
 */

/** Steuerzeichen sind nie gültig; `=` und `@` am Anfang öffnen Formeln in Tabellenkalkulationen. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const FORMULA_START = /^[=@]/;

/** Freitext-Feld: getrimmt, nicht leer, ohne Steuerzeichen, ohne Formel-Anfang (CSV-Injection). */
export function text(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !CONTROL_CHARS.test(v), "Steuerzeichen nicht erlaubt")
    .refine((v) => !FORMULA_START.test(v), "Ungültiger Anfang");
}

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email())
  .refine((v) => !CONTROL_CHARS.test(v));

/** CH: 1000-9658, LI: 9485-9498. Andere Länder: 2-10 Zeichen, nur Buchstaben, Ziffern, Leerzeichen, Bindestrich. */
export function isValidPostalCode(land: string, plz: string): boolean {
  if (land === "CH") return /^[1-9]\d{3}$/.test(plz) && Number(plz) <= 9658;
  if (land === "LI") return /^94(8[5-9]|9\d)$/.test(plz);
  return /^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/.test(plz);
}

/**
 * Telefonnummer -> E.164. Akzeptiert 079 123 45 67, +41 79 123 45 67, 0041 79 ..., +41 (0)79 ...
 * Ausländische Nummern nur mit "+" und 8-15 Ziffern.
 */
export function normalizePhone(input: string): string | null {
  let s = input.trim().replace(/\(0\)/g, "");
  if (!/^[+\d\s().\-/]+$/.test(s)) return null;
  s = s.replace(/[\s().\-/]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  else if (s.startsWith("0")) s = "+41" + s.slice(1);
  if (!/^\+[1-9]\d{7,14}$/.test(s)) return null;
  // Schweiz: nationale Nummer hat genau 9 Ziffern.
  if (s.startsWith("+41") && s.length !== 12) return null;
  return s;
}

export const phoneSchema = z
  .string()
  .max(40)
  .transform((v, ctx) => {
    const n = normalizePhone(v);
    if (!n) ctx.addIssue({ code: "custom", message: "Ungültige Telefonnummer" });
    return n ?? z.NEVER;
  });

/** Prüfziffer der UID (Modulo 11, Gewichte 5 4 3 2 7 6 5 4) */
function uidCheckDigitValid(digits: string): boolean {
  const weights = [5, 4, 3, 2, 7, 6, 5, 4];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(digits[i]), 0);
  const rest = sum % 11;
  const check = rest === 0 ? 0 : 11 - rest;
  return check !== 10 && check === Number(digits[8]);
}

const UID_PATTERN = /^CHE[-\s]?(\d{3})[.\s]?(\d{3})[.\s]?(\d{3})(?:\s*(MWST|TVA|IVA))?$/i;

/** Liefert die 9 Ziffern der UID oder null. `suffix` ist true, wenn MWST/TVA/IVA angehängt ist. */
export function parseUid(input: string): { digits: string; suffix: boolean } | null {
  const m = UID_PATTERN.exec(input.trim());
  if (!m) return null;
  const digits = `${m[1]}${m[2]}${m[3]}`;
  return uidCheckDigitValid(digits) ? { digits, suffix: Boolean(m[4]) } : null;
}

export function formatUid(digits: string): string {
  return `CHE-${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
}

export const uidSchema = z
  .string()
  .max(30)
  .transform((v, ctx) => {
    const p = parseUid(v);
    if (!p) ctx.addIssue({ code: "custom", message: "Ungültige UID" });
    return p ? formatUid(p.digits) : z.NEVER;
  });

/** MwSt-Nummer = UID mit Zusatz MWST/TVA/IVA. Normalisiert auf "CHE-123.456.788 MWST". */
export const mwstNrSchema = z
  .string()
  .max(40)
  .transform((v, ctx) => {
    const p = parseUid(v);
    if (!p?.suffix) ctx.addIssue({ code: "custom", message: "Ungültige MwSt-Nummer" });
    return p?.suffix ? `${formatUid(p.digits)} MWST` : z.NEVER;
  });

export const landSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/)
  .default("CH");

export const addressSchema = z
  .object({
    strasse: text(100),
    hausnr: text(15).optional(),
    zusatz: text(100).optional(),
    plz: z.string().trim().min(2).max(10),
    ort: text(60),
    land: landSchema,
  })
  .refine((a) => isValidPostalCode(a.land, a.plz), { message: "Ungültige PLZ", path: ["plz"] });
export type Address = z.infer<typeof addressSchema>;
