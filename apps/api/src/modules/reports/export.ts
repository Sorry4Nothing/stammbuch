import { strToU8, zipSync } from "fflate";
import { formatCents } from "./money.js";
import type {
  BalanceSheetReport,
  DebtorsReport,
  IncomeStatementReport,
  OpenItemsReport,
  TrialBalanceReport,
  VatReport,
} from "./reports.js";

/** Tabellenform eines Berichts: Grundlage für CSV und XLSX. `money` sind ganze Rappen. */
export type ColumnType = "text" | "money" | "int";
export type Cell = string | number | null;
export interface Table {
  title: string;
  columns: { label: string; type: ColumnType }[];
  rows: Cell[][];
}

/**
 * Formelinjektion neutralisieren (OWASP CSV Injection, SR-20): Textzellen, die mit
 * `= + - @`, Tab oder CR beginnen, bekommen ein führendes `'`. Zahlenzellen sind echte
 * Zahlen und werden nicht angefasst, ihr Minuszeichen ist daher unbedenklich.
 */
export function neutralize(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function text(cell: Cell, type: ColumnType): string {
  if (cell === null) return "";
  if (typeof cell === "number") return type === "money" ? formatCents(cell) : String(cell);
  return neutralize(cell);
}

const BOM = String.fromCharCode(0xfeff);

export function toCsv(table: Table): Buffer {
  const esc = (s: string) => (/[;"\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
  const lines = [
    table.columns.map((c) => esc(neutralize(c.label))).join(";"),
    ...table.rows.map((r) =>
      r.map((c, i) => esc(text(c, table.columns[i]?.type ?? "text"))).join(";"),
    ),
  ];
  // BOM, damit Excel UTF-8 erkennt; Semikolon ist das Trennzeichen der Schweizer Excel-Vorgabe.
  return Buffer.from(`${BOM}${lines.join("\r\n")}\r\n`, "utf8");
}

// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const xml = (s: string) =>
  s
    .replace(XML_INVALID, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function colName(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Stile: 0 normal, 1 fett (Kopf), 2 Zahl mit zwei Nachkommastellen. */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf fontId="1" applyFont="1"/><xf numFmtId="4" applyNumberFormat="1"/></cellXfs></styleSheet>`;

export function toXlsx(table: Table): Buffer {
  const head = table.columns
    .map(
      (c, i) =>
        `<c r="${colName(i)}1" s="1" t="inlineStr"><is><t>${xml(neutralize(c.label))}</t></is></c>`,
    )
    .join("");
  const body = table.rows
    .map((row, r) => {
      const cells = row
        .map((cell, i) => {
          const ref = `${colName(i)}${r + 2}`;
          const type = table.columns[i]?.type ?? "text";
          if (cell === null) return "";
          if (typeof cell === "number") {
            // Betrag als exakter Dezimaltext aus ganzen Rappen, nie über Fliesskomma.
            const v = type === "money" ? formatCents(cell) : String(cell);
            return `<c r="${ref}"${type === "money" ? ' s="2"' : ""}><v>${v}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(neutralize(cell))}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 2}">${cells}</row>`;
    })
    .join("");
  const widths = table.columns
    .map((c, i) => {
      const longest = Math.max(
        c.label.length,
        ...table.rows.map((r) => text(r[i] ?? null, c.type).length),
      );
      return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, longest + 2)}" customWidth="1"/>`;
    })
    .join("");
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths}</cols><sheetData><row r="1">${head}</row>${body}</sheetData></worksheet>`;
  const name = xml(table.title.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Bericht");
  const ns = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${ns}><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${rel}"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${ns}><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": STYLES,
    "xl/worksheets/sheet1.xml": sheet,
  };
  return Buffer.from(
    zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))),
  );
}

// ---------------------------------------------------------------- Berichte als Tabellen

const pct = (bp: number) => `${formatCents(bp)} %`;

export const openItemsTable = (r: OpenItemsReport): Table => ({
  title: `Offene Posten ${r.asOf}`,
  columns: [
    { label: "Debitor-Nr.", type: "text" },
    { label: "Debitor", type: "text" },
    { label: "Rechnung", type: "text" },
    { label: "Rechnungsdatum", type: "text" },
    { label: "Fällig", type: "text" },
    { label: "Betrag", type: "money" },
    { label: "Bezahlt", type: "money" },
    { label: "Offen", type: "money" },
    { label: "Tage überfällig", type: "int" },
  ],
  rows: [
    ...r.rows.map((x) => [
      x.debtorNumber,
      x.debtorName,
      x.reference,
      x.issueDate,
      x.dueDate,
      x.amountCents,
      x.paidCents,
      x.openCents,
      x.daysOverdue,
    ]),
    ["Total", null, null, null, null, null, null, r.totals.openCents, null],
  ],
});

export const debtorsTable = (r: DebtorsReport): Table => ({
  title: `Debitorenliste ${r.asOf}`,
  columns: [
    { label: "Debitor-Nr.", type: "text" },
    { label: "Debitor", type: "text" },
    { label: "Posten", type: "int" },
    { label: "Offen", type: "money" },
    { label: "Davon überfällig", type: "money" },
    { label: "Älteste Fälligkeit", type: "text" },
  ],
  rows: [
    ...r.rows.map((x) => [
      x.number,
      x.name,
      x.itemCount,
      x.openCents,
      x.overdueCents,
      x.oldestDueDate,
    ]),
    ["Total", null, null, r.totals.openCents, r.totals.overdueCents, null],
    ["Saldo Debitoren-Sammelkonto", null, null, r.totals.controlAccountCents, null, null],
    ["Differenz", null, null, r.totals.differenceCents, null, null],
  ],
});

export const trialBalanceTable = (r: TrialBalanceReport): Table => ({
  title: `Saldenliste ${r.from} bis ${r.to}`,
  columns: [
    { label: "Konto", type: "text" },
    { label: "Bezeichnung", type: "text" },
    { label: "Anfangssaldo", type: "money" },
    { label: "Soll", type: "money" },
    { label: "Haben", type: "money" },
    { label: "Endsaldo", type: "money" },
  ],
  rows: [
    ...r.rows.map((x) => [
      x.number,
      x.name,
      x.openingCents,
      x.debitCents,
      x.creditCents,
      x.closingCents,
    ]),
    [
      "Total",
      null,
      r.totals.openingCents,
      r.totals.debitCents,
      r.totals.creditCents,
      r.totals.closingCents,
    ],
  ],
});

const stmtCols: Table["columns"] = [
  { label: "Konto", type: "text" },
  { label: "Bezeichnung", type: "text" },
  { label: "Betrag", type: "money" },
];

export const incomeStatementTable = (r: IncomeStatementReport): Table => ({
  title: `Erfolgsrechnung ${r.from} bis ${r.to}`,
  columns: stmtCols,
  rows: [
    ...r.rows.map((x) => [x.number, x.name, x.amountCents]),
    ["Total Ertrag", null, r.totals.revenueCents],
    ["Total Aufwand", null, r.totals.expenseCents],
    ["Ergebnis", null, r.totals.resultCents],
  ],
});

export const balanceSheetTable = (r: BalanceSheetReport): Table => ({
  title: `Bilanz ${r.asOf}`,
  columns: stmtCols,
  rows: [
    ...r.rows.map((x) => [x.number, x.name, x.amountCents]),
    ["Total Aktiven", null, r.totals.assetsCents],
    ["Total Fremdkapital", null, r.totals.liabilitiesCents],
    ["Total Eigenkapital", null, r.totals.equityCents],
    ["Ergebnis (kumuliert)", null, r.totals.resultCents],
    ["Total Passiven", null, r.totals.liabilitiesAndEquityCents],
    ["Differenz", null, r.totals.differenceCents],
  ],
});

export const vatTable = (r: VatReport): Table => ({
  title: `MwSt ${r.from} bis ${r.to}`,
  columns: [
    { label: "Art", type: "text" },
    { label: "Satz", type: "text" },
    { label: "Entgelt netto", type: "money" },
    { label: "Steuer gebucht", type: "money" },
    { label: "Steuer berechnet", type: "money" },
    { label: "Differenz", type: "money" },
  ],
  rows: [
    ...r.rows.map((x) => [
      x.kind === "output" ? "Umsatzsteuer" : "Vorsteuer",
      pct(x.rateBp),
      x.netCents,
      x.taxCents,
      x.computedTaxCents,
      x.differenceCents,
    ]),
    [
      r.method === "saldo" ? `Saldosteuersatz ${pct(r.saldoRateBp ?? 0)}` : "Effektive Methode",
      null,
      null,
      null,
      null,
      null,
    ],
    ["Geschuldete Steuer", null, null, r.totals.outputTaxCents, null, null],
    ["Vorsteuer", null, null, r.totals.inputTaxCents, null, null],
    ["Zu zahlen", null, null, r.totals.payableCents, null, null],
  ],
});
