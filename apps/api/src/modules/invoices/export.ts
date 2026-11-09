import type { Table } from "../reports/export.js";
import type { InvoiceView } from "./service.js";

export interface ExportRow {
  view: InvoiceView;
  /** Titel der erreichten Mahnstufe, leer ohne Mahnung. */
  levelTitle: string;
}

const STATUS = {
  draft: "Entwurf",
  sent: "Offen",
  paid: "Bezahlt",
  cancelled: "Storniert",
} as const;

/** Statusbezeichnung wie in der Oberfläche: «Gemahnt» und «Gutgeschrieben» sind abgeleitet. */
export function statusLabel({ view, levelTitle }: ExportRow): string {
  const { invoice, creditedCents, openCents } = view;
  if (invoice.status === "sent") {
    if (creditedCents > 0 && openCents <= 0) return "Gutgeschrieben";
    if (levelTitle) return "Gemahnt";
  }
  return STATUS[invoice.status];
}

/** Rechnungsliste als Tabelle für den Excel-Export (Beträge in Rappen, die Ausgabe formatiert sie). */
export const invoicesTable = (rows: readonly ExportRow[], today: string): Table => ({
  title: `Rechnungen ${today}`,
  columns: [
    { label: "Nummer", type: "text" },
    { label: "Rechnungsdatum", type: "text" },
    { label: "Fällig am", type: "text" },
    { label: "Empfänger", type: "text" },
    { label: "Betreff", type: "text" },
    { label: "Status", type: "text" },
    { label: "Mahnstufe", type: "text" },
    { label: "Total", type: "money" },
    { label: "Bezahlt", type: "money" },
    { label: "Gutgeschrieben", type: "money" },
    { label: "Offen", type: "money" },
  ],
  rows: rows.map((r) => {
    const { invoice: i } = r.view;
    return [
      i.number ?? "",
      i.issueDate,
      i.dueDate,
      i.debtor.name,
      i.subject,
      statusLabel(r),
      r.levelTitle,
      i.totals.totalCents,
      r.view.paidCents,
      r.view.creditedCents,
      r.view.openCents,
    ];
  }),
});
