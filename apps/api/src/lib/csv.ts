/**
 * Ein CSV-Feld für Excel. Beginnt der Text mit `=`, `+`, `-`, `@`, Tab oder Zeilenumbruch,
 * würde Excel ihn als Formel ausführen (CSV-Injection). Ein vorangestelltes `'` neutralisiert das.
 * Trennzeichen ist `;` (Excel mit deutscher oder Schweizer Ländereinstellung).
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r\n]/.test(value) ? `'${value}` : value;
  return /[";\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** Zeilen als CSV mit UTF-8-BOM, damit Excel Umlaute richtig liest. */
export function toCsv(rows: string[][]): string {
  return "﻿" + rows.map((r) => r.map(csvCell).join(";")).join("\r\n") + "\r\n";
}
