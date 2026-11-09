import { describe, expect, it } from "vitest";
import { formatAmount, formatChf, formatIban, formatInt, formatPhone } from "./format";

describe("Zahlenformat", () => {
  it("formatiert Beträge mit Hochkomma und echtem Minus", () => {
    expect(formatChf(125000)).toBe("CHF 1'250.00");
    expect(formatChf(5)).toBe("CHF 0.05");
    expect(formatChf(-115000)).toBe("CHF −1'150.00");
    expect(formatChf(-5)).toBe("CHF −0.05");
    expect(formatChf(0)).toBe("CHF 0.00");
    expect(formatChf(123456789)).toBe("CHF 1'234'567.89");
    expect(formatChf(1000, "EUR")).toBe("EUR 10.00");
    expect(formatAmount(-100000)).toBe("−1'000.00");
  });

  it("formatiert Ganzzahlen", () => {
    expect(formatInt(1426)).toBe("1'426");
    expect(formatInt(-1426)).toBe("−1'426");
    expect(formatInt(12)).toBe("12");
  });

  it("gruppiert die IBAN in Vierergruppen", () => {
    expect(formatIban("CH9300762011623852957")).toBe("CH93 0076 2011 6238 5295 7");
    expect(formatIban("CH93 0076 2011 6238 5295 7")).toBe("CH93 0076 2011 6238 5295 7");
  });

  it("formatiert Schweizer Telefonnummern und lässt anderes unverändert", () => {
    expect(formatPhone("0791234567")).toBe("079 123 45 67");
    expect(formatPhone("+41791234567")).toBe("+41 79 123 45 67");
    expect(formatPhone("0041 79 123 45 67")).toBe("+41 79 123 45 67");
    expect(formatPhone("+49 30 123456")).toBe("+49 30 123456");
    expect(formatPhone("123")).toBe("123");
  });
});
