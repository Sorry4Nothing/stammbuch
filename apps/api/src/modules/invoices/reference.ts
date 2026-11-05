import { mod97 } from "./iban.js";

/**
 * Modulo-10 rekursiv (SIX, "Modulo 10, rekursiv"): Übertragstabelle, Prüfziffer = 10 - Übertrag.
 * Liefert die Prüfziffer zu einer reinen Ziffernfolge.
 */
const MOD10_TABLE = [0, 9, 4, 6, 8, 2, 7, 1, 3, 5];

export function mod10Check(digits: string): string {
  if (!/^\d+$/.test(digits)) throw new Error("Nur Ziffern erlaubt.");
  let carry = 0;
  for (const ch of digits) carry = MOD10_TABLE[(carry + Number(ch)) % 10] as number;
  return String((10 - carry) % 10);
}

/** QR-Referenz: 27 Ziffern, letzte Stelle ist die Prüfziffer. */
export function isValidQrr(ref: string): boolean {
  return /^\d{27}$/.test(ref) && mod10Check(ref.slice(0, 26)) === ref[26];
}

/** Baut eine QR-Referenz aus bis zu 26 Ziffern (links mit Nullen aufgefüllt). */
export function makeQrr(base: string): string {
  if (!/^\d{1,26}$/.test(base)) throw new Error("QR-Referenzbasis: 1 bis 26 Ziffern.");
  const body = base.padStart(26, "0");
  return body + mod10Check(body);
}

/** "21 00000 00003 13947 14300 09017" */
export function formatQrr(ref: string): string {
  return `${ref.slice(0, 2)} ${ref.slice(2).replace(/(\d{5})(?=\d)/g, "$1 ")}`;
}

/** Creditor Reference nach ISO 11649: "RF" + 2 Prüfziffern + 1 bis 21 alphanumerische Zeichen. */
export function isValidScor(ref: string): boolean {
  return /^RF\d{2}[A-Z0-9]{1,21}$/.test(ref) && mod97(`${ref.slice(4)}${ref.slice(0, 4)}`) === 1;
}

export function makeScor(base: string): string {
  const b = base.toUpperCase();
  if (!/^[A-Z0-9]{1,21}$/.test(b)) throw new Error("SCOR-Basis: 1 bis 21 Zeichen A-Z, 0-9.");
  const check = String(98 - mod97(`${b}RF00`)).padStart(2, "0");
  return `RF${check}${b}`;
}

/** "RF18 5390 0754 7034" */
export function formatScor(ref: string): string {
  return ref.replace(/(.{4})(?=.)/g, "$1 ");
}
