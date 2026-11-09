import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  formatDayMonth,
  instantOf,
  isoWeek,
  localOf,
  monthGrid,
  parseClock,
  parseDay,
  startOfWeek,
  wallOf,
  weekdayIndex,
} from "./time";

describe("Tage", () => {
  it("rechnet über Monats- und Jahresgrenzen", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("begrenzt den Tag beim Monatswechsel", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
  });

  it("zählt die Woche ab Montag", () => {
    expect(weekdayIndex("2026-11-02")).toBe(0);
    expect(weekdayIndex("2026-11-08")).toBe(6);
    expect(startOfWeek("2026-11-08")).toBe("2026-11-02");
  });

  it("bestimmt die ISO-Kalenderwoche", () => {
    expect(isoWeek("2026-11-09")).toBe(46);
    expect(isoWeek("2026-01-01")).toBe(1);
    expect(isoWeek("2027-01-01")).toBe(53);
  });

  it("zeigt Tag und Monat ohne führende Null", () => {
    expect(formatDayMonth("2026-11-01")).toBe("1.11.");
  });
});

describe("Monatsraster", () => {
  it("November 2026 hat sechs Wochen von Montag, 26.10., bis Sonntag, 6.12.", () => {
    const grid = monthGrid("2026-11-14");
    expect(grid).toHaveLength(6);
    expect(grid[0]![0]).toBe("2026-10-26");
    expect(grid[5]![6]).toBe("2026-12-06");
    expect(grid.every((w) => w.length === 7)).toBe(true);
  });

  it("Februar 2027 (Montag bis Sonntag) braucht nur vier Wochen", () => {
    expect(monthGrid("2027-02-10")).toHaveLength(4);
  });
});

describe("Eingaben", () => {
  it("liest Datum als TT.MM.JJJJ", () => {
    expect(parseDay("14.11.2026")).toBe("2026-11-14");
    expect(parseDay("1.2.2026")).toBe("2026-02-01");
    expect(parseDay("31.02.2026")).toBeNull();
    expect(parseDay("2026-11-14")).toBeNull();
    expect(parseDay("")).toBeNull();
  });

  it("liest Zeit als HH:MM", () => {
    expect(parseClock("17:00")).toBe("17:00");
    expect(parseClock("7:05")).toBe("07:05");
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("17:60")).toBeNull();
    expect(parseClock("1700")).toBeNull();
  });
});

describe("Zeitzone Europe/Zurich", () => {
  it("Winterzeit ist UTC+1, Sommerzeit UTC+2", () => {
    expect(new Date(instantOf("2026-11-14T17:00")).toISOString()).toBe("2026-11-14T16:00:00.000Z");
    expect(new Date(instantOf("2026-07-14T17:00")).toISOString()).toBe("2026-07-14T15:00:00.000Z");
  });

  it("wallOf und localOf kehren instantOf um", () => {
    const ms = instantOf("2026-11-02T14:41");
    expect(localOf(ms)).toBe("2026-11-02T14:41");
    expect(wallOf(ms).day).toBe("2026-11-02");
  });

  it("nimmt bei der doppelten Stunde im Herbst die Sommerzeit", () => {
    expect(new Date(instantOf("2026-10-25T02:30")).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });
});
