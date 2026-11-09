import { fiscalYearOf, previousDay } from "./format";

export interface FiscalRange {
  key: "current" | "previous";
  /** Jahr, in dem das Geschäftsjahr beginnt («Geschäftsjahr 2026»). */
  year: number;
  from: string;
  to: string;
}

/**
 * Laufendes Geschäftsjahr (bis heute) und das vorherige (ganz). Das Geschäftsjahr beginnt im
 * Monat `startMonth`; die Organisation legt ihn in den Einstellungen fest.
 */
export function fiscalRanges(today: string, startMonth: number): FiscalRange[] {
  const cur = fiscalYearOf(today, startMonth);
  const prevFrom = `${cur.year - 1}-${String(startMonth).padStart(2, "0")}-01`;
  return [
    { key: "current", year: cur.year, from: cur.from, to: today },
    { key: "previous", year: cur.year - 1, from: prevFrom, to: previousDay(cur.from) },
  ];
}
