import { describe, expect, it } from "vitest";
import {
  DomainError,
  MAX_AMOUNT,
  assertBalanced,
  daysBetween,
  entryHash,
  isIsoDate,
  retentionUntil,
  sha256,
  stableStringify,
  taxRateAllowed,
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

describe("Steuersatz in Konto und Hash", () => {
  const base = {
    number: 1,
    bookingDate: "2026-01-15",
    kind: "manual" as const,
    description: "Test",
    lines: [d("1020", 100), c("3000", 100)],
    reversalOf: null,
    createdAt: "2026-01-15T10:00:00.000Z",
    createdBy: "u1",
    retentionUntil: "2036-12-31",
    prevHash: "0".repeat(64),
  };

  it("der Hash einer Buchung ohne Satz bleibt wie vor der Einführung des Satzes", () => {
    const old = sha256(
      stableStringify([
        "t1",
        base.prevHash,
        1,
        base.bookingDate,
        "manual",
        "Test",
        [
          ["1020", "debit", 100, null],
          ["3000", "credit", 100, null],
        ],
        null,
        base.createdAt,
        "u1",
        "2036-12-31",
      ]),
    );
    expect(entryHash("t1", base)).toBe(old);
  });

  it("ein Satz auf einer Zeile ist Teil des Hashs", () => {
    const rated = {
      ...base,
      lines: [d("1020", 100), { ...c("3000", 100), taxRateBp: 810 as const }],
    };
    expect(entryHash("t1", rated)).not.toBe(entryHash("t1", base));
  });

  it.each([
    ["revenue", "3200", true],
    ["expense", "4000", true],
    ["liability", "2200", true],
    ["liability", "2000", false],
    ["asset", "1170", true],
    ["asset", "1020", false],
    ["asset", "1100", false],
    ["equity", "2800", false],
  ] as const)("Satz auf %s %s erlaubt: %s", (type, code, allowed) => {
    expect(taxRateAllowed(type, code)).toBe(allowed);
  });
});
