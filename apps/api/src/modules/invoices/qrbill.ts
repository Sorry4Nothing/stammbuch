import { isQrIban, isSwissOrLiIban, normalizeIban } from "./iban.js";
import { type Cents, qrAmount } from "./money.js";
import { isValidQrr, isValidScor } from "./reference.js";

/**
 * Payload der Schweizer QR-Rechnung nach "Swiss Implementation Guidelines QR-bill" (SIX), Version 2.x.
 * Nur strukturierte Adressen (Typ "S"); der kombinierte Typ "K" ist ab Version 2.3 abgeschafft.
 */
export class QrBillError extends Error {}

export interface QrAddress {
  name: string;
  street?: string | undefined;
  buildingNumber?: string | undefined;
  postalCode: string;
  town: string;
  country: string;
}

export type ReferenceType = "QRR" | "SCOR" | "NON";

export interface QrBillData {
  iban: string;
  creditor: QrAddress;
  /** null = offener Betrag (Betragsfeld bleibt leer, Zahler trägt ihn ein). */
  amountCents: Cents | null;
  currency: "CHF" | "EUR";
  debtor?: QrAddress | null | undefined;
  referenceType: ReferenceType;
  reference?: string | undefined;
  message?: string | undefined;
  billInfo?: string | undefined;
  altProcedures?: string[] | undefined;
}

/** Zeichensatz der Spezifikation (Latin): druckbares ASCII plus Buchstaben À-ÿ ohne × und ÷. */
const LATIN = /^[\x20-\x7EÀ-ÖØ-öø-ÿ]*$/;

const SPECIAL: Record<string, string> = {
  Ł: "L",
  ł: "l",
  Đ: "D",
  đ: "d",
  Œ: "OE",
  œ: "oe",
  Ø: "O",
  ø: "o",
};

/** Best-Effort-Umsetzung beliebigen Texts in den QR-Zeichensatz (Akzente entfernen, Rest "?"). */
export function toQrLatin(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC").replace(/[\r\n\t]+/g, " ")) {
    if (LATIN.test(ch)) out += ch;
    else {
      const base = SPECIAL[ch] ?? ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
      out += LATIN.test(base) && base.length > 0 ? base : "?";
    }
  }
  return out.trim();
}

function field(label: string, value: string | undefined, max: number, required: boolean): string {
  const v = value ?? "";
  if (required && v.length === 0) throw new QrBillError(`${label} fehlt.`);
  if (v.length > max) throw new QrBillError(`${label} ist länger als ${max} Zeichen.`);
  if (!LATIN.test(v))
    throw new QrBillError(`${label} enthält Zeichen ausserhalb des QR-Zeichensatzes.`);
  if (v !== v.trim())
    throw new QrBillError(`${label} hat führende oder abschliessende Leerzeichen.`);
  return v;
}

function addressLines(label: string, a: QrAddress): string[] {
  if (!/^[A-Z]{2}$/.test(a.country))
    throw new QrBillError(`${label}: Land muss ein ISO-Code sein.`);
  return [
    "S",
    field(`${label} Name`, a.name, 70, true),
    field(`${label} Strasse`, a.street, 70, false),
    field(`${label} Hausnummer`, a.buildingNumber, 16, false),
    field(`${label} PLZ`, a.postalCode, 16, true),
    field(`${label} Ort`, a.town, 35, true),
    a.country,
  ];
}

const EMPTY_ADDRESS = ["", "", "", "", "", "", ""];

export function buildQrPayload(d: QrBillData): string {
  if (!isSwissOrLiIban(d.iban)) throw new QrBillError("IBAN ist keine gültige CH/LI-IBAN.");
  const iban = normalizeIban(d.iban);
  const qrIban = isQrIban(iban);

  let reference = "";
  switch (d.referenceType) {
    case "QRR":
      if (!qrIban) throw new QrBillError("QR-Referenz verlangt eine QR-IBAN.");
      if (!d.reference || !isValidQrr(d.reference)) throw new QrBillError("QR-Referenz ungültig.");
      reference = d.reference;
      break;
    case "SCOR":
      if (qrIban) throw new QrBillError("Eine QR-IBAN verlangt eine QR-Referenz.");
      if (!d.reference || !isValidScor(d.reference))
        throw new QrBillError("SCOR-Referenz ungültig.");
      reference = d.reference;
      break;
    case "NON":
      if (qrIban) throw new QrBillError("Eine QR-IBAN verlangt eine QR-Referenz.");
      if (d.reference) throw new QrBillError("Referenztyp NON erlaubt keine Referenz.");
      break;
  }

  if (
    d.amountCents !== null &&
    (!Number.isInteger(d.amountCents) || d.amountCents <= 0 || d.amountCents > 99_999_999_999)
  )
    throw new QrBillError("Betrag ausserhalb 0.01 bis 999'999'999.99.");
  if (d.currency !== "CHF" && d.currency !== "EUR")
    throw new QrBillError("Währung nur CHF oder EUR.");

  const message = field("Mitteilung", d.message, 140, false);
  const billInfo = field("Rechnungsinformation", d.billInfo, 140, false);
  if (message.length + billInfo.length > 140)
    throw new QrBillError("Mitteilung und Rechnungsinformation zusammen über 140 Zeichen.");
  const alt = d.altProcedures ?? [];
  if (alt.length > 2) throw new QrBillError("Höchstens zwei alternative Verfahren.");

  const lines = [
    "SPC",
    "0200",
    "1",
    iban,
    ...addressLines("Zahlungsempfänger", d.creditor),
    ...EMPTY_ADDRESS, // Endgültiger Zahlungsempfänger: für künftige Verwendung, bleibt leer
    d.amountCents === null ? "" : qrAmount(d.amountCents),
    d.currency,
    ...(d.debtor ? addressLines("Zahlungspflichtiger", d.debtor) : EMPTY_ADDRESS),
    d.referenceType,
    reference,
    message,
    "EPD",
    billInfo,
    ...alt.map((a) => field("Alternatives Verfahren", a, 100, true)),
  ];
  // Fehlende Zeilen am Ende (leere Rechnungsinformation ohne Alternativverfahren) sind erlaubt.
  const payload = lines.join("\n");
  if (payload.length > 997) throw new QrBillError("Payload länger als 997 Zeichen.");
  return payload;
}
