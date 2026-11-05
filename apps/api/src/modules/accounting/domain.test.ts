import { describe, expect, it } from "vitest";
import {
  DomainError,
  MAX_AMOUNT,
  assertBalanced,
  daysBetween,
  isIsoDate,
  retentionUntil,
  stableStringify,
} from "./domain.js";
import type { EntryLine } from "./domain.js";

const d = (accountCode: string, amount: number): EntryLine => ({
  accountCode,
  side: "debit",
  amount,
});
const c = (accountCode: string, amount: number): EntryLine => ({
  accountCode,
  side: "credit",
  amount,
});

describe("assertBalanced", () => {
  const ok: [string, EntryLine[]][] = [
    ["einfach", [d("1020", 100), c("3000", 100)]],
    ["mehrere Gegenkonten", [d("1100", 10800), c("3000", 10000), c("2200", 800)]],
    ["Maximalbetrag", [d("1020", MAX_AMOUNT), c("3000", MAX_AMOUNT)]],
  ];
  it.each(ok)("akzeptiert: %s", (_n, lines) => {
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  const bad: [string, EntryLine[]][] = [
    ["Soll > Haben", [d("1020", 101), c("3000", 100)]],
    ["nur eine Zeile", [d("1020", 100)]],
    ["nur Soll", [d("1020", 50), d("1000", 50)]],
    ["Betrag 0", [d("1020", 0), c("3000", 0)]],
    ["negativer Betrag", [d("1020", -5), c("3000", -5)]],
    ["Bruchrappen", [d("1020", 0.5), c("3000", 0.5)]],
    ["über Maximum", [d("1020", MAX_AMOUNT + 1), c("3000", MAX_AMOUNT + 1)]],
    ["NaN", [d("1020", NaN), c("3000", NaN)]],
    [
      "zu viele Zeilen",
      Array.from({ length: 101 }, (_, i) => (i % 2 ? c("3000", 1) : d("1020", 1))),
    ],
  ];
  it.each(bad)("verweigert: %s", (_n, lines) => {
    expect(() => assertBalanced(lines)).toThrow(DomainError);
  });
});

describe("Datum und Aufbewahrung", () => {
  it.each([
    ["2026-02-28", true],
    ["2024-02-29", true],
    ["2026-02-29", false],
    ["2026-13-01", false],
    ["26-01-01", false],
    ["2026-1-1", false],
  ])("isIsoDate(%s) = %s", (s, expected) => expect(isIsoDate(s)).toBe(expected));

  it("Aufbewahrung endet 10 Jahre nach Ende des Geschäftsjahres (Art. 958f OR)", () => {
    expect(retentionUntil("2026-03-15")).toBe("2036-12-31");
  });

  it("zählt Tage zwischen Daten", () => {
    expect(daysBetween("2026-01-31", "2026-03-01")).toBe(29);
    expect(daysBetween("2026-03-01", "2026-01-31")).toBe(-29);
  });
});

describe("stableStringify", () => {
  it("ist unabhängig von der Schlüsselreihenfolge", () => {
    expect(stableStringify({ a: 1, b: [1, { y: 1, x: 2 }] })).toBe(
      stableStringify({ b: [1, { x: 2, y: 1 }], a: 1 }),
    );
  });
});
