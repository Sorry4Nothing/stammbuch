import { describe, expect, it } from "vitest";
import { vatTransactionsOf } from "./vat-lines.js";
import type { VatLine } from "./vat-lines.js";

type T = VatLine["accountType"];
const line = (
  bookingId: string,
  account: string,
  accountType: T,
  side: "debit" | "credit",
  cents: number,
  rateBp: number | null = null,
  bookingKind = "invoice",
): VatLine => ({
  bookingId,
  date: "2026-01-15",
  bookingKind,
  account,
  accountType,
  side,
  cents,
  rateBp,
});

describe("Umsatz und Steuer aus Buchungszeilen", () => {
  it("Bestand ohne Satz: Satz aus Netto und Steuer auf 2200", () => {
    const tx = vatTransactionsOf([
      line("B1", "1100", "asset", "debit", 108_100),
      line("B1", "3200", "revenue", "credit", 100_000),
      line("B1", "2200", "liability", "credit", 8_100),
    ]);
    expect(tx).toEqual([
      {
        bookingId: "B1",
        date: "2026-01-15",
        kind: "output",
        rateBp: 810,
        netCents: 100_000,
        taxCents: 8_100,
        account: "2200",
      },
    ]);
  });

  it("Erlös ohne Steuerzeile ist Umsatz zu 0 % mit Herkunft", () => {
    const tx = vatTransactionsOf([
      line("B1", "1100", "asset", "debit", 30_000),
      line("B1", "3000", "revenue", "credit", 20_000),
      line("B1", "3600", "revenue", "credit", 340),
      line("B1", "3400", "revenue", "credit", 9_660),
    ]);
    expect(tx.map((t) => [t.rateBp, t.netCents, t.origin])).toEqual([
      [0, 20_000, "contributions"],
      [0, 340, "dunningFees"],
      [0, 9_660, undefined],
    ]);
  });

  it("Gutschrift ohne Steuer: Herkunft Gutschrift, negativer Umsatz", () => {
    const tx = vatTransactionsOf([
      line("G1", "3000", "revenue", "debit", 1_150, null, "credit_note"),
      line("G1", "1100", "asset", "credit", 1_150, null, "credit_note"),
    ]);
    expect(tx.map((t) => [t.netCents, t.origin])).toEqual([[-1_150, "creditNotes"]]);
  });

  it("Konten mit Satz: Umsatz und Steuer je Satz, Steuerkonto je Satz", () => {
    const tx = vatTransactionsOf([
      line("B1", "1100", "asset", "debit", 12_000 + 972 + 2_000 + 52),
      line("B1", "3200", "revenue", "credit", 12_000, 810),
      line("B1", "3400", "revenue", "credit", 2_000, 260),
      line("B1", "2200", "liability", "credit", 972, 810),
      line("B1", "2201", "liability", "credit", 52, 260),
    ]);
    expect(tx).toEqual([
      expect.objectContaining({ rateBp: 810, netCents: 12_000, taxCents: 972, account: "2200" }),
      expect.objectContaining({ rateBp: 260, netCents: 2_000, taxCents: 52, account: "2201" }),
    ]);
  });

  it("Erlös mit Satz, Steuer nur auf 2200 ohne Satz: die Steuer gehört zum einzigen Satz der Buchung", () => {
    const tx = vatTransactionsOf([
      line("B1", "1100", "asset", "debit", 108_100),
      line("B1", "3200", "revenue", "credit", 100_000, 810),
      line("B1", "2200", "liability", "credit", 8_100),
    ]);
    expect(tx).toEqual([
      expect.objectContaining({ rateBp: 810, netCents: 100_000, taxCents: 8_100, account: "2200" }),
    ]);
  });

  it("Erlös mit Satz ohne gebuchte Steuer zeigt die Abweichung (Steuer 0)", () => {
    const tx = vatTransactionsOf([
      line("B1", "1100", "asset", "debit", 100_000),
      line("B1", "3200", "revenue", "credit", 100_000, 810),
    ]);
    expect(tx).toEqual([expect.objectContaining({ rateBp: 810, netCents: 100_000, taxCents: 0 })]);
  });

  it("Gemischte Buchung: Teil mit Satz, Teil ohne Satz getrennt", () => {
    const tx = vatTransactionsOf([
      line("B1", "1100", "asset", "debit", 20_000 + 8_100 + 100_000),
      line("B1", "3000", "revenue", "credit", 20_000),
      line("B1", "3200", "revenue", "credit", 100_000, 810),
      line("B1", "2200", "liability", "credit", 8_100),
    ]);
    expect(tx.map((t) => [t.rateBp, t.netCents, t.taxCents, t.origin])).toEqual([
      [810, 100_000, 8_100, undefined],
      [0, 20_000, 0, "contributions"],
    ]);
  });

  it("Vorsteuer: Aufwand mit Satz und Vorsteuerkonto 117x", () => {
    const tx = vatTransactionsOf([
      line("B6", "4000", "expense", "debit", 20_000, 810),
      line("B6", "1170", "asset", "debit", 1_620, 810),
      line("B6", "1020", "asset", "credit", 21_620),
    ]);
    expect(tx).toEqual([
      expect.objectContaining({
        kind: "input",
        rateBp: 810,
        netCents: 20_000,
        taxCents: 1_620,
        account: "1170",
      }),
    ]);
  });

  it("Gegenbuchung mit den Sätzen des Originals hebt Umsatz und Steuer je Satz auf", () => {
    const both = [
      line("B1", "1100", "asset", "debit", 108_100),
      line("B1", "3200", "revenue", "credit", 100_000, 810),
      line("B1", "2200", "liability", "credit", 8_100, 810),
      line("S1", "1100", "asset", "credit", 108_100, null, "reversal"),
      line("S1", "3200", "revenue", "debit", 100_000, 810, "reversal"),
      line("S1", "2200", "liability", "debit", 8_100, 810, "reversal"),
    ];
    const tx = vatTransactionsOf(both);
    expect(tx.reduce((s, t) => s + t.netCents, 0)).toBe(0);
    expect(tx.reduce((s, t) => s + t.taxCents, 0)).toBe(0);
  });
});
