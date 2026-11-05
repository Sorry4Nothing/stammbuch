import { describe, expect, it } from "vitest";
import { BillingError, computeTotals } from "./domain.js";
import { addDays, daysBetween, formatAmount, qrAmount, roundDiv, roundTo5Rappen } from "./money.js";

const line = (unitCents: number, vatRateBp = 0, quantityMilli = 1000) => ({
  description: "x",
  quantityMilli,
  unitCents,
  vatRateBp,
});

describe("Rundung und Formate", () => {
  it("rundet kaufmännisch, auch negativ", () => {
    expect(roundDiv(5, 10)).toBe(1);
    expect(roundDiv(4, 10)).toBe(0);
    expect(roundDiv(-5, 10)).toBe(-1);
  });
  it("rundet auf 5 Rappen", () => {
    expect([0, 1, 2, 3, 4, 5, 7, 8, 12, 13].map(roundTo5Rappen)).toEqual([
      0, 0, 0, 5, 5, 5, 5, 10, 10, 15,
    ]);
    expect(roundTo5Rappen(-3)).toBe(-5);
  });
  it("formatiert Beträge", () => {
    expect(formatAmount(194975)).toBe("1'949.75");
    expect(formatAmount(5)).toBe("0.05");
    expect(formatAmount(-100000)).toBe("-1'000.00");
    expect(qrAmount(194975)).toBe("1949.75");
  });
  it("rechnet Daten", () => {
    expect(addDays("2026-02-27", 3)).toBe("2026-03-02");
    expect(daysBetween("2026-11-01", "2026-11-04")).toBe(3);
  });
});

describe("Totals", () => {
  it("rechnet MwSt je Satz auf der Summe, nicht je Zeile", () => {
    // 3 x 0.10 CHF: je Zeile 8.1 % = 0.0081 -> 0.01 (3 Rappen), auf der Summe 0.30 -> 0.02
    const t = computeTotals([line(10, 810), line(10, 810), line(10, 810)], "exclusive", false);
    expect(t.netCents).toBe(30);
    expect(t.vatCents).toBe(2);
    expect(t.totalCents).toBe(32);
  });
  it("trennt Sätze und rundet Mengen mit Nachkommastellen", () => {
    const t = computeTotals(
      [line(10000, 810, 1500), line(3333, 260, 250)], // 150.00 und 8.33
      "exclusive",
      false,
    );
    expect(t.netCents).toBe(15000 + 833);
    expect(t.vatBuckets).toEqual([
      { rateBp: 260, netCents: 833, vatCents: 22 },
      { rateBp: 810, netCents: 15000, vatCents: 1215 },
    ]);
    expect(t.totalCents).toBe(15833 + 22 + 1215);
  });
  it("wendet die Rappenrundung an und weist sie aus", () => {
    const t = computeTotals([line(1003)], "none", true);
    expect(t.grossCents).toBe(1003);
    expect(t.totalCents).toBe(1005);
    expect(t.roundingCents).toBe(2);
  });
  it("lehnt ungültige Positionen ab", () => {
    expect(() => computeTotals([line(100, 0, 0)], "none", false)).toThrow(BillingError);
    expect(() => computeTotals([line(1.5)], "none", false)).toThrow(BillingError);
    expect(() => computeTotals([line(-1)], "none", false)).toThrow(BillingError);
    expect(() => computeTotals([line(100, 810)], "none", false)).toThrow(BillingError);
    expect(() => computeTotals([], "none", false)).toThrow(BillingError);
  });
  it("begrenzt den Gesamtbetrag auf den QR-Höchstbetrag", () => {
    const big = (n: number) => Array.from({ length: n }, () => line(100_000_000));
    expect(() => computeTotals(big(500), "none", false)).not.toThrow();
    expect(() => computeTotals(big(1001), "none", false)).toThrow(BillingError);
  });
  it("Gutschrift: nur negative Beträge", () => {
    const t = computeTotals([line(-1000, 810)], "exclusive", false, true);
    expect(t.totalCents).toBe(-1081);
    expect(() => computeTotals([line(1000)], "none", false, true)).toThrow(BillingError);
  });
});
