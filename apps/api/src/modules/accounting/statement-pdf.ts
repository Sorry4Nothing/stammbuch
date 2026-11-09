import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { PDFFont, PDFPage } from "pdf-lib";
import { formatAmount } from "../invoices/money.js";
import { mm, safeText, wrap } from "../invoices/pdf/text.js";
import type { PersonLine } from "./repository.js";

export interface StatementData {
  name: string;
  asOf: string;
  balance: number;
  openItems: { reference: string; dueDate: string; remaining: number }[];
  lines: PersonLine[];
}

const A4 = { w: 210, h: 297 };
const LEFT = 20;
const RIGHT = 190;
const BOTTOM = 275;
const BLACK = rgb(0, 0, 0);
const GREY = rgb(0.33, 0.33, 0.33);
// Spaltenanker in mm (rechtsbündige Beträge)
const COL = { nr: 20, date: 34, text: 56, debit: 142, credit: 163, balance: 190 };

const chDate = (iso: string) => iso.split("-").reverse().join(".");

/**
 * Kontoauszug einer Person als PDF (A4, weiss, Standardschrift). Beträge in CHF aus ganzen Rappen.
 * Texte laufen durch `safeText`, damit Nutzereingaben die Erzeugung nie stören.
 */
export async function renderStatementPdf(data: StatementData): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle("Kontoauszug");
  doc.setProducer("Stammbuch");
  doc.setCreator("Stammbuch");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page!: PDFPage;
  let y = 0;
  const text = (
    s: string,
    x: number,
    o: { size?: number; bold?: boolean; grey?: boolean; right?: boolean } = {},
  ) => {
    const font: PDFFont = o.bold ? bold : regular;
    const size = o.size ?? 9;
    const t = safeText(s);
    page.drawText(t, {
      x: o.right ? mm(x) - font.widthOfTextAtSize(t, size) : mm(x),
      y: mm(A4.h - y),
      size,
      font,
      color: o.grey ? GREY : BLACK,
    });
  };
  const rule = () =>
    page.drawLine({
      start: { x: mm(LEFT), y: mm(A4.h - y) },
      end: { x: mm(RIGHT), y: mm(A4.h - y) },
      thickness: 0.5,
      color: BLACK,
    });
  const header = () => {
    text("Beleg", COL.nr, { bold: true });
    text("Datum", COL.date, { bold: true });
    text("Text", COL.text, { bold: true });
    text("Soll", COL.debit, { bold: true, right: true });
    text("Haben", COL.credit, { bold: true, right: true });
    text("Saldo", COL.balance, { bold: true, right: true });
    y += 1.8;
    rule();
    y += 4.5;
  };
  const newPage = () => {
    page = doc.addPage([mm(A4.w), mm(A4.h)]);
    y = 22;
  };

  newPage();
  text("Kontoauszug", LEFT, { size: 16, bold: true });
  y += 8;
  text(data.name, LEFT, { size: 11, bold: true });
  y += 5;
  text(`Stand ${chDate(data.asOf)}`, LEFT, { grey: true });
  y += 8;
  text("Saldo (positiv = Forderung)", LEFT);
  text(`CHF ${formatAmount(data.balance)}`, RIGHT, { bold: true, right: true });
  y += 10;

  if (data.openItems.length > 0) {
    text("Offene Posten", LEFT, { bold: true, size: 10 });
    y += 5;
    for (const i of data.openItems) {
      if (y > BOTTOM) newPage();
      text(i.reference, LEFT);
      text(`fällig ${chDate(i.dueDate)}`, COL.text);
      text(formatAmount(i.remaining), COL.balance, { right: true });
      y += 4.4;
    }
    y += 6;
  }

  if (y > BOTTOM - 20) newPage();
  text("Buchungen", LEFT, { bold: true, size: 10 });
  y += 5;
  header();
  for (const l of data.lines) {
    // Lange Texte umbrechen; die Zeile belegt so viele Zeilenhöhen wie nötig.
    const parts = wrap(l.description, regular, 9, COL.debit - COL.text - 20);
    if (y + parts.length * 4.4 > BOTTOM) {
      newPage();
      header();
    }
    text(String(l.entryNumber), COL.nr);
    text(chDate(l.bookingDate), COL.date);
    text(formatAmount(l.amount), l.side === "debit" ? COL.debit : COL.credit, { right: true });
    text(formatAmount(l.balanceAfter), COL.balance, { right: true });
    for (const part of parts) {
      text(part, COL.text);
      y += 4.4;
    }
  }
  if (data.lines.length === 0) text("Keine Buchungen.", LEFT, { grey: true });

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = `Seite ${i + 1} von ${pages.length}`;
    p.drawText(label, {
      x: mm(RIGHT) - regular.widthOfTextAtSize(label, 8),
      y: mm(12),
      size: 8,
      font: regular,
      color: GREY,
    });
  });
  return Buffer.from(await doc.save());
}
