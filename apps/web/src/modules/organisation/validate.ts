import { t } from "../../i18n";
import { fiscalRange } from "./httpSettingsService";
import type { Features, OrgData, OrgErrors } from "./model";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** IBAN-Prüfsumme nach ISO 7064 (mod 97), wie in der API. */
function ibanChecksumOk(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const ch of digits) rest = (rest * 10 + Number(ch)) % 97;
  return rest === 1;
}

/** QR-IBAN: Schweizer oder liechtensteinische IBAN, Institut (Stellen 5 bis 9) von 30000 bis 31999. */
export function isQrIban(value: string): boolean {
  const iban = value.replace(/\s+/g, "").toUpperCase();
  if (!/^(CH|LI)\d{2}\d{5}[0-9A-Z]{12}$/.test(iban) || !ibanChecksumOk(iban)) return false;
  const iid = Number(iban.slice(4, 9));
  return iid >= 30000 && iid <= 31999;
}

const DATE = /^(\d{2})\.(\d{2})\.$/;

/** Prüft die Angaben vor dem Speichern. Die API prüft dieselben Regeln noch einmal (SR-72). */
export function validateOrg(form: OrgData, features: Features): OrgErrors {
  const errors: OrgErrors = {};
  const required = (key: keyof OrgData) => {
    if (typeof form[key] === "string" && !form[key].trim())
      errors[key] = t("settings.error.required");
  };
  for (const key of [
    "name",
    "street",
    "zip",
    "city",
    "email",
    "vatNumber",
    "senderName",
    "replyTo",
    "bankName",
    "qrIban",
  ] as const) {
    required(key);
  }
  if (features.legalForm) required("legalForm");
  if (features.accountHolder) required("accountHolder");
  if (features.creditAccount) required("creditAccount");
  if (features.paymentDays) required("paymentDays");

  if (!errors.zip && !/^\d{4}$/.test(form.zip.trim())) errors.zip = t("settings.error.zip");
  for (const key of ["email", "replyTo"] as const) {
    if (!errors[key] && !EMAIL.test(form[key].trim())) errors[key] = t("auth.forgot.emailFormat");
  }
  if (form.uid.trim() && !/^CHE-\d{3}\.\d{3}\.\d{3}$/.test(form.uid.trim())) {
    errors.uid = t("settings.error.uid");
  }
  if (!errors.qrIban && !isQrIban(form.qrIban)) errors.qrIban = t("settings.error.qrIban");
  if (features.paymentDays && !errors.paymentDays) {
    const days = Number(form.paymentDays);
    if (!/^\d{1,3}$/.test(form.paymentDays.trim()) || days > 365) {
      errors.paymentDays = t("settings.error.days");
    }
  }

  const start = DATE.exec(form.fiscalStart.trim());
  const end = DATE.exec(form.fiscalEnd.trim());
  const month = start ? Number(start[2]) : 0;
  if (!start || month < 1 || month > 12) errors.fiscalStart = t("settings.error.date");
  else if (start[1] !== "01") errors.fiscalStart = t("settings.error.fiscalStart");
  if (!end) errors.fiscalEnd = t("settings.error.date");
  else if (!errors.fiscalStart) {
    const expected = fiscalRange(month).end;
    // Ein Geschäftsjahr, das Ende Februar endet, darf den 28. oder 29. nennen.
    const ok =
      form.fiscalEnd.trim() === expected ||
      (expected === "28.02." && form.fiscalEnd.trim() === "29.02.");
    if (!ok) errors.fiscalEnd = t("settings.error.fiscalEnd", { end: expected });
  }
  return errors;
}

/** Aktuelles Geschäftsjahr: «2026», bei abweichendem Beginn «2026/27». */
export function currentFiscalYear(fiscalStart: string, now: number): string {
  const start = DATE.exec(fiscalStart.trim());
  const month = start ? Number(start[2]) : 0;
  if (month < 1 || month > 12) return "";
  const d = new Date(now);
  const startYear = d.getMonth() + 1 < month ? d.getFullYear() - 1 : d.getFullYear();
  return month === 1 ? String(startYear) : `${startYear}/${String(startYear + 1).slice(2)}`;
}

export const LOGO_MIMES = ["image/png", "image/jpeg"] as const;
export const LOGO_MAX_BYTES = 512 * 1024;
const LOGO_MIN_PX = 16;
const LOGO_MAX_PX = 2000;

/**
 * Prüft Typ, Grösse und Abmessungen vor dem Hochladen. Verbindlich ist die Prüfung der API
 * (Signatur und Struktur der Datei, SR-23); SVG wird nie angenommen, weil es Skripte enthalten kann.
 */
export async function checkLogo(file: File): Promise<"type" | "size" | "dimensions" | null> {
  if (!(LOGO_MIMES as readonly string[]).includes(file.type)) return "type";
  if (file.size > LOGO_MAX_BYTES) return "size";
  if (typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    bitmap.close();
    const outside = (n: number) => n < LOGO_MIN_PX || n > LOGO_MAX_PX;
    return outside(width) || outside(height) ? "dimensions" : null;
  } catch {
    return "type";
  }
}
