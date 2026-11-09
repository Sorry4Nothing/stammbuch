import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { PDFFont, PDFPage } from "pdf-lib";
import type { Cell, ColumnType, Table } from "./export.js";
import { formatCents } from "./money.js";

/** A4 quer: Auswertungen haben bis zu neun Spalten. */
const PAGE: [number, number] = [841.89, 595.28];
const MARGIN = 40;
const SIZE = 9;
const ROW = 15;
const PAD = 4;
/** Eine Spalte nimmt höchstens diesen Anteil der Breite, damit lange Namen die Zahlen nicht verdrängen. */
const MAX_SHARE = 0.4;

/** `1234567` Rappen -> `12'345.67` (Schweizer Schreibweise, rein ganzzahlig). */
function money(cents: number): string {
  const [int, frac] = formatCents(cents).split(".") as [string, string];
  const neg = int.startsWith("-");
  const digits = neg ? int.slice(1) : int;
  return `${neg ? "-" : ""}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, "'")}.${frac}`;
}

function cellText(cell: Cell, type: ColumnType): string {
  if (cell === null) return "";
  if (typeof cell === "number") return type === "money" ? money(cell) : String(cell);
  return cell;
}

/** Schriften ohne Unicode: Zeichen ausserhalb von WinAnsi (z. B. kyrillische Namen) werden zu «?». */
const charsets = new WeakMap<PDFFont, Set<number>>();
function safe(font: PDFFont, s: string): string {
  let set = charsets.get(font);
  if (!set) charsets.set(font, (set = new Set(font.getCharacterSet())));
  return [...s.replace(/[\r\n\t]+/g, " ")]
    .map((ch) => (set.has(ch.codePointAt(0)!) ? ch : "?"))
    .join("");
}

function fit(font: PDFFont, s: string, width: number): string {
  if (font.widthOfTextAtSize(s, SIZE) <= width) return s;
  let t = s;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, SIZE) > width) t = t.slice(0, -1);
  return `${t}...`;
}

/**
 * Tabelle als PDF (A4 quer): Kopfzeile auf jeder Seite, Beträge rechtsbündig, Seitenzahl in der Fusszeile.
 * shortcut: nur Standardschrift Helvetica (WinAnsi), keine Zeilenumbrüche in Zellen; lange Texte werden
 * gekürzt. Ab Bedarf für Mehrzeiligkeit oder Unicode-Schrift durch eingebettete Schrift ersetzen.
 */
export async function toPdf(table: Table): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(table.title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const labels = table.columns.map((c) => safe(bold, c.label));
  const rows = table.rows.map((r) =>
    table.columns.map((c, i) => safe(font, cellText(r[i] ?? null, c.type))),
  );

  // Spaltenbreiten: natürliche Breite, gedeckelt; passt die Summe nicht, schrumpfen alle im gleichen Verhältnis.
  const avail = PAGE[0] - 2 * MARGIN;
  const natural = table.columns.map((_, i) =>
    Math.min(
      avail * MAX_SHARE,
      Math.max(
        bold.widthOfTextAtSize(labels[i]!, SIZE),
        ...rows.map((r) => font.widthOfTextAtSize(r[i]!, SIZE)),
      ) +
        2 * PAD,
    ),
  );
  const scale = Math.min(1, avail / natural.reduce((s, w) => s + w, 0));
  const widths = natural.map((w) => w * scale);

  const pages: PDFPage[] = [];
  let page: PDFPage;
  let y = 0;
  const cellAt = (text: string, i: number, f: PDFFont, yy: number) => {
    const w = widths[i]!;
    const x = MARGIN + widths.slice(0, i).reduce((s, v) => s + v, 0);
    const shown = fit(f, text, w - 2 * PAD);
    const right = table.columns[i]!.type !== "text";
    const tx = right ? x + w - PAD - f.widthOfTextAtSize(shown, SIZE) : x + PAD;
    page.drawText(shown, { x: tx, y: yy, size: SIZE, font: f });
  };
  const header = () => {
    page.drawRectangle({
      x: MARGIN,
      y: y - 4,
      width: avail,
      height: ROW,
      color: rgb(0.93, 0.93, 0.93),
    });
    labels.forEach((l, i) => cellAt(l, i, bold, y));
    y -= ROW;
  };
  const newPage = (first: boolean) => {
    page = doc.addPage(PAGE);
    pages.push(page);
    y = PAGE[1] - MARGIN;
    if (first) {
      page.drawText(safe(bold, table.title), { x: MARGIN, y, size: 14, font: bold });
      y -= 28;
    }
    header();
  };

  newPage(true);
  for (const r of rows) {
    if (y < MARGIN + 20) newPage(false);
    r.forEach((t, i) => cellAt(t, i, font, y));
    y -= ROW;
  }

  pages.forEach((p, n) => {
    p.drawText(`Seite ${n + 1} von ${pages.length}`, {
      x: PAGE[0] - MARGIN - 70,
      y: MARGIN - 20,
      size: 8,
      font,
    });
  });
  return Buffer.from(await doc.save());
}
