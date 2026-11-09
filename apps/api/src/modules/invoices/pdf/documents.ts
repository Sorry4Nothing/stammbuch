import { PDFDocument, type PDFFont, type PDFPage, StandardFonts, rgb } from "pdf-lib";
import type { Invoice } from "../domain.js";
import type { Reminder } from "../dunning.js";
import { type Cents, formatAmount, formatDate, lineNetCents } from "../money.js";
import type { QrBillData } from "../qrbill.js";
import type { BillingSettings } from "../repository.js";
import { SLIP_HEIGHT_MM, drawQrSlip } from "./qrslip.js";
import { addressLinesOf, formatQuantity, mm, safeText, wrap } from "./text.js";

/**
 * Serverseitige PDFs. Das Papier ist immer weiss mit schwarzer/dunkelgrauer Schrift, unabhängig
 * vom Theme der Oberfläche (Projektplan Abschnitt 4). Es wird kein Hintergrund gezeichnet.
 */
const A4 = { w: 210, h: 297 };
const LEFT = 20;
const RIGHT = 190;
const SLIP_TOP = A4.h - SLIP_HEIGHT_MM; // 192 mm
const BODY_BOTTOM = 275; // unterste Textzeile auf Seiten ohne Zahlteil
const SLIP_CLEAR = SLIP_TOP - 8; // Inhalt der Zahlteil-Seite endet hier
const BLACK = rgb(0, 0, 0);
const GREY = rgb(0.33, 0.33, 0.33);

class Sheet {
  page!: PDFPage;
  y = 0;
  readonly pages: PDFPage[] = [];
  constructor(
    readonly doc: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.newPage();
  }

  newPage(startY = 20) {
    this.page = this.doc.addPage([mm(A4.w), mm(A4.h)]);
    this.pages.push(this.page);
    this.y = startY;
  }

  text(
    s: string,
    x: number,
    size = 9.5,
    opts: { bold?: boolean; grey?: boolean; right?: boolean } = {},
  ) {
    const font = opts.bold ? this.bold : this.regular;
    const t = safeText(s);
    const px = opts.right ? mm(x) - font.widthOfTextAtSize(t, size) : mm(x);
    this.page.drawText(t, {
      x: px,
      y: mm(A4.h - this.y),
      size,
      font,
      color: opts.grey ? GREY : BLACK,
    });
  }

  rule(y = this.y, x1 = LEFT, x2 = RIGHT) {
    this.page.drawLine({
      start: { x: mm(x1), y: mm(A4.h - y) },
      end: { x: mm(x2), y: mm(A4.h - y) },
      thickness: 0.5,
      color: BLACK,
    });
  }

  paragraph(s: string, x: number, width: number, size = 9.5, lead = 4.4) {
    for (const l of wrap(s, this.regular, size, width)) {
      this.text(l, x, size);
      this.y += lead;
    }
  }
}

async function newSheet(title: string): Promise<Sheet> {
  const doc = await PDFDocument.create();
  doc.setTitle(safeText(title));
  doc.setProducer("Stammbuch");
  doc.setCreator("Stammbuch");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return new Sheet(doc, regular, bold);
}

function senderBlock(s: Sheet, settings: BillingSettings) {
  s.y = 20;
  s.text(settings.creditor.name, LEFT, 11, { bold: true });
  for (const l of addressLinesOf(settings.creditor).slice(1)) {
    s.y += 4.4;
    s.text(l, LEFT, 9, { grey: true });
  }
  if (settings.vatNumber) {
    s.y += 4.4;
    s.text(`MWST-Nr. ${settings.vatNumber}`, LEFT, 9, { grey: true });
  }
}

function recipientBlock(s: Sheet, inv: Invoice) {
  s.y = 50;
  for (const l of addressLinesOf(inv.debtor)) {
    s.text(l, 118, 10);
    s.y += 4.8;
  }
}

function pageNumbers(s: Sheet, label: string) {
  const n = s.pages.length;
  s.pages.forEach((p, i) => {
    const t = `${label} - Seite ${i + 1}/${n}`;
    p.drawText(safeText(t), {
      x: mm(RIGHT) - s.regular.widthOfTextAtSize(safeText(t), 8),
      y: mm(A4.h - 10),
      size: 8,
      font: s.regular,
      color: GREY,
    });
  });
}

function footer(s: Sheet, settings: BillingSettings) {
  if (settings.contactLines.length === 0) return;
  s.y = 285;
  s.text(settings.contactLines.join("  |  "), LEFT, 8, { grey: true });
}

interface Row {
  description: string;
  qty: string;
  unit: string;
  vat: string;
  amount: string;
}

const COL = { qty: 112, unit: 137, vat: 153, amount: RIGHT };

function tableHeader(s: Sheet, withVat: boolean) {
  s.rule(s.y - 4);
  s.text("Beschreibung", LEFT, 8.5, { bold: true });
  s.text("Menge", COL.qty, 8.5, { bold: true, right: true });
  s.text("Preis", COL.unit, 8.5, { bold: true, right: true });
  if (withVat) s.text("MwSt", COL.vat, 8.5, { bold: true, right: true });
  s.text("Betrag", COL.amount, 8.5, { bold: true, right: true });
  s.y += 2;
  s.rule();
  s.y += 5;
}

function drawRows(s: Sheet, rows: Row[], withVat: boolean, contHeader: string) {
  for (const r of rows) {
    const lines = wrap(r.description, s.regular, 9.5, 80);
    const height = lines.length * 4.4 + 1.5;
    if (s.y + height > BODY_BOTTOM) {
      s.newPage(30);
      s.text(contHeader, LEFT, 9, { grey: true });
      s.y += 10;
      tableHeader(s, withVat);
    }
    const top = s.y;
    lines.forEach((l, i) => {
      s.y = top + i * 4.4;
      s.text(l, LEFT, 9.5);
    });
    s.y = top;
    s.text(r.qty, COL.qty, 9.5, { right: true });
    s.text(r.unit, COL.unit, 9.5, { right: true });
    if (withVat) s.text(r.vat, COL.vat, 9.5, { right: true });
    s.text(r.amount, COL.amount, 9.5, { right: true });
    s.y = top + height;
  }
}

function totalLine(s: Sheet, label: string, amount: string, bold = false) {
  s.text(label, 137, 9.5, { bold, right: false });
  s.text(amount, COL.amount, 9.5, { bold, right: true });
  s.y += 5;
}

export interface InvoicePdfInput {
  invoice: Invoice;
  settings: BillingSettings;
  /** Nummer der korrigierten Rechnung (nur bei Gutschriften). */
  creditNoteOfNumber?: string | null;
}

/** Nur offene (versendete) Rechnungen bekommen einen Zahlteil; Entwürfe, bezahlte, stornierte und Gutschriften nicht. */
export function invoiceQrData(
  inv: Invoice,
  settings: BillingSettings,
  amountCents: Cents,
): QrBillData | null {
  if (inv.kind !== "invoice" || inv.status !== "sent" || !inv.reference || amountCents <= 0)
    return null;
  return {
    iban: settings.iban,
    creditor: settings.creditor,
    amountCents,
    currency: inv.currency,
    debtor: inv.debtor,
    referenceType: inv.reference.type,
    reference: inv.reference.value ?? undefined,
    message: inv.number ?? undefined,
  };
}

export async function renderInvoicePdf(input: InvoicePdfInput): Promise<Uint8Array> {
  const { invoice: inv, settings } = input;
  const isCredit = inv.kind === "credit_note";
  const kindLabel = isCredit ? "Gutschrift" : "Rechnung";
  const label = `${kindLabel} ${inv.number ?? "(Entwurf)"}`;
  const s = await newSheet(label);
  const withVat = inv.vatMode === "exclusive";

  senderBlock(s, settings);
  recipientBlock(s, inv);

  s.y = 88;
  s.text(label, LEFT, 15, { bold: true });
  s.y += 7;
  const meta: [string, string][] = [
    ["Datum", formatDate(inv.issueDate)],
    ...(isCredit && input.creditNoteOfNumber
      ? [["Zu Rechnung", input.creditNoteOfNumber] as [string, string]]
      : []),
    ...(isCredit ? [] : [["Zahlbar bis", formatDate(inv.dueDate)] as [string, string]]),
    ...(inv.memberNumber ? [["Mitgl.-Nr.", inv.memberNumber] as [string, string]] : []),
  ];
  for (const [k, v] of meta) {
    s.text(k, LEFT, 9, { grey: true });
    s.text(v, LEFT + 28, 9);
    s.y += 4.4;
  }
  s.y += 3;
  if (inv.subject) {
    s.text(inv.subject, LEFT, 10.5, { bold: true });
    s.y += 8;
  }

  tableHeader(s, withVat);
  drawRows(
    s,
    inv.lines.map((l) => ({
      description: l.description,
      qty: formatQuantity(l.quantityMilli),
      unit: formatAmount(l.unitCents),
      vat: withVat ? `${(l.vatRateBp / 100).toFixed(1)} %` : "",
      amount: formatAmount(lineNetCents(l.quantityMilli, l.unitCents)),
    })),
    withVat,
    label,
  );

  // Summenblock: zusammenhängend halten.
  const t = inv.totals;
  const need = (t.vatBuckets.length + 4) * 5 + 12;
  if (s.y + need > BODY_BOTTOM) {
    s.newPage(30);
    s.text(label, LEFT, 9, { grey: true });
    s.y += 10;
  }
  s.y += 1;
  s.rule(s.y - 4, 130, RIGHT);
  if (withVat) {
    totalLine(s, "Zwischensumme", formatAmount(t.netCents));
    for (const b of t.vatBuckets)
      totalLine(
        s,
        `MwSt ${(b.rateBp / 100).toFixed(1)} % auf ${formatAmount(b.netCents)}`,
        formatAmount(b.vatCents),
      );
  }
  if (t.roundingCents !== 0) totalLine(s, "Rundung", formatAmount(t.roundingCents));
  totalLine(s, `Total ${inv.currency}`, formatAmount(t.totalCents), true);
  if (!withVat) {
    s.text("Ohne MwSt.", 137, 8, { grey: true });
    s.y += 5;
  }

  s.y += 4;
  // Auf Gutschriften steht die interne Bemerkung des Stornos (nur im Verlauf), nicht auf dem Beleg.
  if (inv.notes && inv.kind === "invoice") s.paragraph(inv.notes, LEFT, 120);

  const qr = invoiceQrData(inv, settings, t.totalCents);
  if (inv.kind === "invoice" && inv.status === "draft") {
    s.y += 3;
    s.text("Entwurf - der Zahlteil erscheint erst nach dem Versenden.", LEFT, 8.5, { grey: true });
  }
  if (qr) {
    if (s.y > SLIP_CLEAR) {
      s.newPage(30);
      s.text(label, LEFT, 9, { grey: true });
      s.y += 8;
      s.text("Zahlteil siehe unten.", LEFT, 9);
    }
    drawQrSlip(s.page, { regular: s.regular, bold: s.bold }, qr);
  } else {
    footer(s, settings);
  }
  pageNumbers(s, label);
  return s.doc.save();
}

export interface ReminderPdfInput {
  invoice: Invoice;
  reminder: Reminder;
  /** Frühere Mahnungen dieser Rechnung (für die ausgewiesenen Gebühren). */
  previous: Reminder[];
  settings: BillingSettings;
}

function reminderBody(level: number, dueOn: string): string {
  const base = `Wir konnten für die unten aufgeführte Rechnung keinen Zahlungseingang feststellen. Bitte überweisen Sie den Gesamtbetrag bis zum ${formatDate(dueOn)}.`;
  if (level <= 1)
    return `${base}\nHaben Sie bereits bezahlt, betrachten Sie dieses Schreiben als gegenstandslos.`;
  if (level === 2) return `${base}\nFür diese Mahnung verrechnen wir eine Mahngebühr.`;
  return `${base}\nBei Nichtzahlung behalten wir uns weitere Schritte bis hin zur Einleitung der Betreibung vor.`;
}

export async function renderReminderPdf(input: ReminderPdfInput): Promise<Uint8Array> {
  const { invoice: inv, reminder: r, settings } = input;
  const label = `${r.title} zu Rechnung ${inv.number ?? ""}`.trim();
  const s = await newSheet(label);

  senderBlock(s, settings);
  recipientBlock(s, inv);

  s.y = 88;
  s.text(r.title, LEFT, 15, { bold: true });
  s.y += 7;
  for (const [k, v] of [
    ["Datum", formatDate(r.issuedOn)],
    ["Rechnung", `${inv.number ?? ""} vom ${formatDate(inv.issueDate)}`],
    ["Zahlbar bis", formatDate(r.dueOn)],
    ...(inv.memberNumber ? ([["Mitgl.-Nr.", inv.memberNumber]] as const) : []),
  ] as const) {
    s.text(k, LEFT, 9, { grey: true });
    s.text(v, LEFT + 28, 9);
    s.y += 4.4;
  }
  s.y += 6;
  s.paragraph(reminderBody(r.level, r.dueOn), LEFT, 150);
  s.y += 6;

  const feeLines: [string, Cents][] = [
    ...input.previous
      .filter((p) => p.feeCents > 0)
      .map((p): [string, Cents] => [`Mahngebühr ${p.title}`, p.feeCents]),
    ...(r.feeCents > 0 ? [[`Mahngebühr ${r.title}`, r.feeCents] as [string, Cents]] : []),
  ];
  s.rule(s.y - 4);
  s.text(`Offener Rechnungsbetrag ${inv.currency}`, LEFT, 9.5);
  s.text(formatAmount(r.openCents), COL.amount, 9.5, { right: true });
  s.y += 5;
  for (const [text, cents] of feeLines) {
    s.text(text, LEFT, 9.5);
    s.text(formatAmount(cents), COL.amount, 9.5, { right: true });
    s.y += 5;
  }
  s.rule(s.y - 3.5);
  s.text(`Total ${inv.currency}`, LEFT, 9.5, { bold: true });
  s.text(formatAmount(r.totalCents), COL.amount, 9.5, { bold: true, right: true });
  s.y += 8;

  const qr = invoiceQrData(inv, settings, r.totalCents);
  if (qr) {
    qr.message = `${r.title} ${inv.number ?? ""}`.trim();
    drawQrSlip(s.page, { regular: s.regular, bold: s.bold }, qr);
  } else {
    footer(s, settings);
  }
  pageNumbers(s, label);
  return s.doc.save();
}
