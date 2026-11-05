import type { PDFFont } from "pdf-lib";
import { formatAmount } from "../money.js";
import type { QrAddress } from "../qrbill.js";

export const MM = 72 / 25.4;
export const mm = (v: number) => v * MM;

/**
 * Die Standardschrift (Helvetica, WinAnsi) kann nur Latin-1 und wenige Zeichen mehr. Alles andere
 * wird zu "?", damit die PDF-Erzeugung nie an Nutzereingaben scheitert und nie etwas Fremdes einbettet.
 */
export function safeText(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFC")) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x20ac) out += "EUR";
    else if (c === 0x2019 || c === 0x2018) out += "'";
    else if (c === 0x2013 || c === 0x2014) out += "-";
    else if (c === 0x201c || c === 0x201d) out += '"';
    else if (c >= 0x20 && c <= 0x7e) out += ch;
    else if (c >= 0xa0 && c <= 0xff) out += ch;
    else if (c === 0x0a || c === 0x0d || c === 0x09) out += " ";
    else out += "?";
  }
  return out;
}

/** Zeilenumbruch nach Textbreite; zu lange Wörter werden hart getrennt. */
export function wrap(text: string, font: PDFFont, size: number, widthMm: number): string[] {
  const max = mm(widthMm);
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/).map(safeText)) {
    let line = "";
    for (const word of para.split(" ")) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= max) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = word;
      while (line.length > 1 && font.widthOfTextAtSize(line, size) > max) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > max) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

export function addressLinesOf(a: QrAddress): string[] {
  const street = [a.street, a.buildingNumber].filter(Boolean).join(" ");
  const town = `${a.country === "CH" ? "" : `${a.country}-`}${a.postalCode} ${a.town}`;
  return [a.name, street, town].filter((l) => l.length > 0);
}

/** "1 949.75" wie im Zahlteil vorgeschrieben (Leerschritt als Tausendertrenner). */
export function slipAmount(cents: number): string {
  return formatAmount(cents).replaceAll("'", " ");
}

/** Menge aus Tausendsteln: 1500 -> "1.5", 2000 -> "2". */
export function formatQuantity(milli: number): string {
  return (milli / 1000).toFixed(3).replace(/\.?0+$/, "");
}
