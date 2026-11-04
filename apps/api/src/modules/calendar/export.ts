import ExcelJS from "exceljs";
import { type CalendarEvent, TIME_ZONE, formatLocal } from "./domain.js";
import type { ParticipantList } from "./service.js";

/**
 * Schützt vor Formelinjektion (CSV/Excel-Injection): Zellen, die mit `=`, `+`, `-`, `@`,
 * Tab oder Zeilenumbruch beginnen, bekommen ein führendes `'`. Excel wertet sie dann nie als
 * Formel aus, auch nicht nach einem Export nach CSV.
 */
export function neutralize(value: string): string {
  return /^[=+\-@\t\r\n]/.test(value) ? `'${value}` : value;
}

const STATUS_LABEL = { accepted: "Zusage", declined: "Absage", pending: "Offen" } as const;
const STATUS_FILL = { accepted: "FFE3F4E8", declined: "FFFBE4E4", pending: "FFEDEFF2" } as const;

const INK = "FF1B2430";
const HEADER_FILL = "FF1F3A5F";
const LINE = "FFC9CED6";
const thin = { style: "thin", color: { argb: LINE } } as const;

export async function participantsWorkbook(
  event: CalendarEvent,
  list: ParticipantList,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Stammbuch";
  const ws = wb.addWorksheet("Teilnehmer", { views: [{ state: "frozen", ySplit: 6 }] });
  ws.columns = [
    { width: 28 },
    { width: 34 },
    { width: 12 },
    { width: 12 },
    { width: 44 },
    { width: 18 },
  ];

  ws.mergeCells("A1:F1");
  const title = ws.getCell("A1");
  title.value = neutralize(event.title);
  title.font = { name: "Calibri", size: 16, bold: true, color: { argb: INK } };
  ws.getRow(1).height = 26;

  ws.mergeCells("A2:F2");
  const when = `${formatLocal(event.startsAt)} bis ${formatLocal(event.endsAt)} (${TIME_ZONE})`;
  ws.getCell("A2").value = neutralize(event.location ? `${when}, ${event.location}` : when);
  ws.getCell("A2").font = { name: "Calibri", size: 11, color: { argb: "FF556070" } };

  const s = list.summary;
  ws.mergeCells("A3:F3");
  ws.getCell("A3").value =
    `Eingeladen: ${s.invited} | Zusagen: ${s.accepted} | Absagen: ${s.declined} | ` +
    `Offen: ${s.pending} | Personen vor Ort: ${s.attendees}`;
  ws.getCell("A3").font = { name: "Calibri", size: 11, bold: true, color: { argb: INK } };

  const header = ws.getRow(6);
  header.values = ["Name", "E-Mail", "Antwort", "Begleitung", "Hinweis", "Rückmeldung am"];
  header.height = 22;
  header.eachCell((cell) => {
    cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.alignment = { vertical: "middle", horizontal: "left" };
  });

  for (const r of list.rows) {
    const row = ws.addRow([
      neutralize(r.name),
      neutralize(r.email),
      STATUS_LABEL[r.status],
      r.status === "accepted" ? r.guests : "",
      neutralize(r.note),
      r.respondedAt ? formatLocal(r.respondedAt) : "",
    ]);
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: "Calibri", size: 11, color: { argb: INK } };
      cell.alignment = { vertical: "top", wrapText: true };
      cell.border = { bottom: thin };
    });
    row.getCell(3).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: STATUS_FILL[r.status] },
    };
    row.getCell(4).alignment = { vertical: "top", horizontal: "center" };
  }

  ws.autoFilter = { from: "A6", to: `F${Math.max(6, ws.rowCount)}` };
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// --- ICS ------------------------------------------------------------------------------------

const icsStamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** Escaping nach RFC 5545: Backslash, Semikolon, Komma, Zeilenumbruch. */
function icsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([;,])/g, "\\$1")
    .replace(/\r?\n/g, "\\n");
}

/** Zeilen länger als 75 Oktette werden gefaltet (RFC 5545, 3.1). */
function fold(line: string): string {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > (out.length === 0 ? 75 : 74)) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n ");
}

/** Zeitangaben in UTC: gültig in jedem Kalenderprogramm und unabhängig von VTIMEZONE-Daten. */
export function eventToIcs(event: CalendarEvent, now: Date): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Stammbuch//Kalender//DE",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${event.id}@stammbuch`,
    `DTSTAMP:${icsStamp(now)}`,
    `DTSTART:${icsStamp(event.startsAt)}`,
    `DTEND:${icsStamp(event.endsAt)}`,
    `SUMMARY:${icsText(event.title)}`,
  ];
  if (event.location) lines.push(`LOCATION:${icsText(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${icsText(event.description)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
