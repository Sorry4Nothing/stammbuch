import QRCode from "qrcode";
import { type PDFFont, type PDFPage, rgb } from "pdf-lib";
import { formatIban } from "../iban.js";
import { type QrBillData, buildQrPayload } from "../qrbill.js";
import { formatQrr, formatScor } from "../reference.js";
import { addressLinesOf, mm, safeText, slipAmount, wrap } from "./text.js";

/**
 * Zahlteil mit Empfangsschein nach "Swiss Implementation Guidelines QR-bill" (SIX).
 * Masse in mm, Ursprung links oben am Zahlteil (105 mm hoch, 210 mm breit, unten auf A4).
 * Empfangsschein: 62 mm breit, Zahlteil: 148 mm; Ränder 5 mm; QR-Code 46 x 46 mm ohne Ruhezone.
 */
export const SLIP_HEIGHT_MM = 105;
export const SLIP_WIDTH_MM = 210;
const QR_SIZE = 46;
const CROSS_SIZE = 7;

const BLACK = rgb(0, 0, 0);

export interface SlipFonts {
  regular: PDFFont;
  bold: PDFFont;
}

interface Block {
  heading: string;
  lines: string[];
}

export function drawQrSlip(page: PDFPage, fonts: SlipFonts, data: QrBillData): void {
  // Der Payload wird zuerst gebaut: ein ungültiger Zahlteil bricht ab, statt falsch zu drucken.
  const payload = buildQrPayload(data);
  const y = (fromTop: number) => mm(SLIP_HEIGHT_MM - fromTop);
  const x = mm;

  const text = (s: string, xMm: number, baseline: number, size: number, bold = false) =>
    page.drawText(safeText(s), {
      x: x(xMm),
      y: y(baseline),
      size,
      font: bold ? fonts.bold : fonts.regular,
      color: BLACK,
    });
  const line = (x1: number, y1: number, x2: number, y2: number, dash?: number[]) =>
    page.drawLine({
      start: { x: x(x1), y: y(y1) },
      end: { x: x(x2), y: y(y2) },
      thickness: 0.75,
      color: BLACK,
      ...(dash ? { dashArray: dash } : {}),
    });

  // Trennlinien (Perforation): oben waagrecht, zwischen Empfangsschein und Zahlteil senkrecht.
  line(0, 0, SLIP_WIDTH_MM, 0, [3, 3]);
  line(62, 0, 62, SLIP_HEIGHT_MM, [3, 3]);

  const creditor = [formatIban(data.iban), ...addressLinesOf(data.creditor)];
  const refText =
    data.referenceType === "QRR" && data.reference
      ? formatQrr(data.reference)
      : data.referenceType === "SCOR" && data.reference
        ? formatScor(data.reference)
        : null;
  const debtor = data.debtor ? addressLinesOf(data.debtor) : null;
  const amount = data.amountCents === null ? null : slipAmount(data.amountCents);

  // Empfangsschein
  text("Empfangsschein", 5, 10, 11, true);
  const endR = drawBlocks(
    [
      { heading: "Konto / Zahlbar an", lines: creditor },
      ...(refText ? [{ heading: "Referenz", lines: [refText] }] : []),
      { heading: "Zahlbar durch", lines: debtor ?? [] },
    ],
    5,
    15,
    52,
    6,
    8,
    9,
  );
  if (!debtor) cornerBox(5, endR - 1, 52, 20);
  text("Währung", 5, 71, 6, true);
  text("Betrag", 20, 71, 6, true);
  text(data.currency, 5, 76, 8);
  if (amount) text(amount, 20, 76, 8);
  else cornerBox(30, 70, 27, 10);
  const accept = "Annahmestelle";
  page.drawText(accept, {
    x: x(57) - fonts.bold.widthOfTextAtSize(accept, 6),
    y: y(87),
    size: 6,
    font: fonts.bold,
    color: BLACK,
  });

  // Zahlteil
  text("Zahlteil", 67, 10, 11, true);
  drawQr(page, payload, x(67), y(17 + QR_SIZE));
  text("Währung", 67, 72, 8, true);
  text("Betrag", 82, 72, 8, true);
  text(data.currency, 67, 77, 10);
  if (amount) text(amount, 82, 77, 10);
  else cornerBox(82, 73, 40, 15);

  const right: Block[] = [{ heading: "Konto / Zahlbar an", lines: creditor }];
  if (refText) right.push({ heading: "Referenz", lines: [refText] });
  const info = [data.message, data.billInfo].filter(Boolean).join("\n");
  if (info)
    right.push({ heading: "Zusätzliche Informationen", lines: wrap(info, fonts.regular, 10, 87) });
  right.push({
    heading: debtor ? "Zahlbar durch" : "Zahlbar durch (Name/Adresse)",
    lines: debtor ?? [],
  });
  const endY = drawBlocks(right, 118, 9, 87, 8, 10, 11);
  if (!debtor) cornerBox(118, endY, 65, 25);

  data.altProcedures?.forEach((a, i) => text(a, 67, 93 + i * 3, 7));

  /** Zeichnet Blöcke untereinander und liefert die y-Position (mm) nach dem letzten. */
  function drawBlocks(
    blocks: Block[],
    xMm: number,
    startY: number,
    width: number,
    headSize: number,
    valueSize: number,
    leadingPt: number,
  ): number {
    const lead = (leadingPt * 25.4) / 72;
    let cursor = startY;
    for (const b of blocks) {
      text(b.heading, xMm, cursor, headSize, true);
      cursor += lead;
      for (const l of b.lines) {
        for (const part of wrap(l, fonts.regular, valueSize, width)) {
          text(part, xMm, cursor, valueSize);
          cursor += lead;
        }
      }
      cursor += lead * 0.75;
    }
    return cursor;
  }

  /** Rechteck mit Eckmarken für Felder, die von Hand ausgefüllt werden (Betrag, Zahlbar durch). */
  function cornerBox(xMm: number, yMm: number, w: number, h: number) {
    const c = 3;
    for (const [cx, cy, dx, dy] of [
      [xMm, yMm, 1, 1],
      [xMm + w, yMm, -1, 1],
      [xMm, yMm + h, 1, -1],
      [xMm + w, yMm + h, -1, -1],
    ] as const) {
      line(cx, cy, cx + dx * c, cy, undefined);
      line(cx, cy, cx, cy + dy * c, undefined);
    }
  }
}

/** QR-Code als Vektor (46 mm, Fehlerkorrektur M) mit Schweizer Kreuz (7 mm) in der Mitte. */
function drawQr(page: PDFPage, payload: string, left: number, bottom: number): void {
  const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const cell = mm(QR_SIZE) / n;
  const top = bottom + mm(QR_SIZE);
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.modules.get(r, c)) {
        c++;
        continue;
      }
      const start = c;
      while (c < n && qr.modules.get(r, c)) c++;
      // Waagrechte Läufe zusammenfassen: weniger Objekte und keine Haarlinien zwischen Modulen.
      page.drawRectangle({
        x: left + start * cell,
        y: top - (r + 1) * cell,
        width: (c - start) * cell,
        height: cell,
        color: BLACK,
      });
    }
  }
  const mid = { x: left + mm(QR_SIZE) / 2, y: bottom + mm(QR_SIZE) / 2 };
  const white = mm(CROSS_SIZE);
  page.drawRectangle({
    x: mid.x - white / 2,
    y: mid.y - white / 2,
    width: white,
    height: white,
    color: rgb(1, 1, 1),
  });
  const box = mm(CROSS_SIZE - 1); // schwarzes Quadrat, 0.5 mm weisser Rand
  page.drawRectangle({
    x: mid.x - box / 2,
    y: mid.y - box / 2,
    width: box,
    height: box,
    color: BLACK,
  });
  const arm = box * (20 / 32);
  const thick = box * (6 / 32);
  page.drawRectangle({
    x: mid.x - arm / 2,
    y: mid.y - thick / 2,
    width: arm,
    height: thick,
    color: rgb(1, 1, 1),
  });
  page.drawRectangle({
    x: mid.x - thick / 2,
    y: mid.y - arm / 2,
    width: thick,
    height: arm,
    color: rgb(1, 1, 1),
  });
}
