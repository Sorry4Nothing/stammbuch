import { describe, expect, it } from "vitest";
import { fixture } from "./fixtures.js";
import { InMemoryLedger } from "./ledger-port.js";
import { applyRateBp, formatCents } from "./money.js";
import {
  balanceSheetReport,
  bucketOf,
  debtorsReport,
  incomeStatementReport,
  LedgerInconsistencyError,
  openItemsReport,
  trialBalanceReport,
  vatCheck,
  vatReport,
} from "./reports.js";

const T = "t1";
const ledger = new InMemoryLedger().seed(T, fixture);

describe("Rappen-Rechnen", () => {
  it.each([
    [5, 1000, 1],
    [-5, 1000, -1],
    [4, 1000, 0],
    [1, 810, 0],
    [10, 810, 1],
    [140_000, 810, 11_340],
  ])("applyRateBp(%i, %i) = %i", (c, r, e) => expect(applyRateBp(c, r)).toBe(e));

  it.each([
    [0, "0.00"],
    [5, "0.05"],
    [-5, "-0.05"],
    [108_100, "1081.00"],
    [-1_234_567, "-12345.67"],
  ])("formatCents(%i) = %s", (c, e) => expect(formatCents(c)).toBe(e));

  it("lehnt Nicht-Ganzzahlen ab", () => expect(() => formatCents(1.5)).toThrow());
});

describe("Offene-Posten-Liste", () => {
  it("zeigt zum Stichtag nur offene Beträge und Altersklassen", async () => {
    const r = await openItemsReport(ledger, T, { asOf: "2026-03-31" });
    expect(r.rows.map((x) => [x.reference, x.openCents, x.daysOverdue, x.bucket])).toEqual([
      ["G-1", -10_810, 26, "d1_30"],
      ["R-3", 54_050, 9, "d1_30"],
      ["R-2", 20_000, 40, "d31_60"],
    ]);
    // Kontrollsumme: Summe der Zeilen = Total = Summe der Altersklassen.
    expect(r.totals.openCents).toBe(63_240);
    expect(Object.values(r.totals.byBucket).reduce((a, b) => a + b, 0)).toBe(63_240);
  });

  it("Stichtag vor der Zahlung: Rechnung ist noch offen", async () => {
    const r = await openItemsReport(ledger, T, { asOf: "2026-02-09" });
    expect(r.rows.map((x) => [x.reference, x.openCents])).toEqual([
      ["R-1", 108_100],
      ["R-2", 20_000],
    ]);
  });

  it("Filter Debitor und überfällig", async () => {
    const r = await openItemsReport(ledger, T, {
      asOf: "2026-03-23",
      debtorId: "d1",
      overdueOnly: true,
    });
    expect(r.rows.map((x) => x.reference)).toEqual(["G-1", "R-3"]);
  });

  it("Altersklassen an den Grenzen", () => {
    expect([0, 1, 30, 31, 60, 61, 90, 91].map(bucketOf)).toEqual([
      "notDue",
      "d1_30",
      "d1_30",
      "d31_60",
      "d31_60",
      "d61_90",
      "d61_90",
      "d90plus",
    ]);
  });
});

describe("Debitorenliste", () => {
  it("Nebenbuch stimmt mit Sammelkonto überein", async () => {
    const r = await debtorsReport(ledger, T, { asOf: "2026-03-31" });
    expect(r.rows.map((x) => [x.number, x.itemCount, x.openCents, x.overdueCents])).toEqual([
      ["10001", 2, 43_240, 43_240],
      ["10002", 1, 20_000, 20_000],
    ]);
    expect(r.totals).toMatchObject({
      openCents: 63_240,
      controlAccountCents: 63_240,
      differenceCents: 0,
    });
  });

  it("zeigt Abweichung zwischen Hauptbuch und offenen Posten", async () => {
    const broken = new InMemoryLedger().seed(T, {
      ...fixture,
      openItems: fixture.openItems.filter((i) => i.id !== "p2"),
    });
    const r = await debtorsReport(broken, T, { asOf: "2026-03-31" });
    expect(r.totals.differenceCents).toBe(20_000);
  });
});

describe("Saldenliste", () => {
  it("Periodenbewegung, Anfangs- und Endsaldo, Summen gehen auf", async () => {
    const r = await trialBalanceReport(ledger, T, { from: "2026-02-01", to: "2026-03-31" });
    const deb = r.rows.find((x) => x.number === "1100");
    expect(deb).toMatchObject({
      openingCents: 128_100,
      debitCents: 54_050,
      creditCents: 118_910,
      closingCents: 63_240,
    });
    expect(r.rows.find((x) => x.number === "1020")?.closingCents).toBe(1_086_480);
    expect(r.totals.debitCents).toBe(r.totals.creditCents);
    expect(r.totals).toMatchObject({ openingCents: 0, closingCents: 0, balanced: true });
  });

  it("ganzes Quartal: Anfangssalden sind 0", async () => {
    const r = await trialBalanceReport(ledger, T, { from: "2026-01-01", to: "2026-03-31" });
    expect(r.rows.every((x) => x.openingCents === 0)).toBe(true);
    expect(r.totals.debitCents).toBe(
      1_000_000 + 108_100 + 20_000 + 108_100 + 54_050 + 20_000 + 1_620 + 10_000 + 810,
    );
  });

  it("erkennt eine unausgeglichene Buchung", async () => {
    const bad = new InMemoryLedger().seed(T, {
      ...fixture,
      lines: [...fixture.lines, { ...fixture.lines[0]!, id: "x", bookingId: "BX", amountCents: 1 }],
    });
    const r = await trialBalanceReport(bad, T, { from: "2026-01-01", to: "2026-03-31" });
    expect(r.totals.balanced).toBe(false);
  });

  it("verweigert Buchungen auf unbekannte Konten", async () => {
    const bad = new InMemoryLedger().seed(T, {
      ...fixture,
      lines: [{ ...fixture.lines[0]!, accountId: "gibts-nicht" }],
    });
    await expect(
      trialBalanceReport(bad, T, { from: "2026-01-01", to: "2026-03-31" }),
    ).rejects.toThrow(LedgerInconsistencyError);
  });
});

describe("Erfolgsrechnung und Bilanz", () => {
  it("Erfolgsrechnung Q1", async () => {
    const r = await incomeStatementReport(ledger, T, { from: "2026-01-01", to: "2026-03-31" });
    expect(r.rows.map((x) => [x.number, x.amountCents])).toEqual([
      ["3000", 20_000],
      ["3200", 140_000],
      ["4000", 20_000],
    ]);
    expect(r.totals).toEqual({ revenueCents: 160_000, expenseCents: 20_000, resultCents: 140_000 });
  });

  it("Erfolgsrechnung nur Februar", async () => {
    const r = await incomeStatementReport(ledger, T, { from: "2026-02-01", to: "2026-02-28" });
    expect(r.totals).toEqual({ revenueCents: 50_000, expenseCents: 20_000, resultCents: 30_000 });
  });

  it("Bilanz geht auf, zu jedem Stichtag", async () => {
    for (const asOf of ["2026-01-01", "2026-01-31", "2026-02-28", "2026-03-31", "2026-12-31"]) {
      const r = await balanceSheetReport(ledger, T, { asOf });
      expect(r.totals.differenceCents, asOf).toBe(0);
      expect(r.totals.balanced).toBe(true);
    }
    const q1 = await balanceSheetReport(ledger, T, { asOf: "2026-03-31" });
    expect(q1.totals).toMatchObject({
      assetsCents: 1_151_340,
      liabilitiesCents: 11_340,
      equityCents: 1_000_000,
      resultCents: 140_000,
      liabilitiesAndEquityCents: 1_151_340,
    });
    expect(q1.rows.find((x) => x.number === "1100")?.amountCents).toBe(63_240);
  });

  it("Bilanz meldet Differenz bei kaputtem Hauptbuch", async () => {
    const bad = new InMemoryLedger().seed(T, { ...fixture, lines: fixture.lines.slice(0, 3) });
    expect((await balanceSheetReport(bad, T, { asOf: "2026-03-31" })).totals.balanced).toBe(false);
  });
});

describe("MwSt-Abrechnung", () => {
  const q = { from: "2026-01-01", to: "2026-03-31" } as const;

  it("effektive Methode, rappengenau", async () => {
    const r = await vatReport(ledger, T, { ...q, method: "effective" });
    expect(r.rows).toEqual([
      {
        kind: "output",
        rateBp: 810,
        netCents: 140_000,
        taxCents: 11_340,
        computedTaxCents: 11_340,
        differenceCents: 0,
      },
      {
        kind: "output",
        rateBp: 0,
        netCents: 20_000,
        taxCents: 0,
        computedTaxCents: 0,
        differenceCents: 0,
      },
      {
        kind: "input",
        rateBp: 810,
        netCents: 20_000,
        taxCents: 1_620,
        computedTaxCents: 1_620,
        differenceCents: 0,
      },
    ]);
    expect(r.totals).toEqual({
      turnoverCents: 160_000,
      untaxedCents: 20_000,
      untaxedBreakdown: {
        contributionsCents: 20_000,
        dunningFeesCents: 0,
        creditNotesCents: 0,
        otherCents: 0,
      },
      taxableGrossCents: 151_340,
      outputTaxCents: 11_340,
      inputTaxCents: 1_620,
      payableCents: 9_720,
    });
  });

  it("Umsatz ohne Steuer nach Herkunft: die Teile ergeben den Umsatz ohne Steuer", async () => {
    const free = (
      id: string,
      netCents: number,
      origin?: "contributions" | "dunningFees" | "creditNotes",
    ) => ({
      bookingId: id,
      date: "2026-01-10",
      kind: "output" as const,
      rateBp: 0,
      netCents,
      taxCents: 0,
      ...(origin ? { origin } : {}),
    });
    const l = new InMemoryLedger().seed(T, {
      vat: [
        free("a", 10_000, "contributions"),
        free("b", 340, "dunningFees"),
        free("c", -1_150, "creditNotes"),
        free("d", 700),
        { ...free("e", 5_000), rateBp: 810, taxCents: 405 },
      ],
    });
    const r = await vatReport(l, T, { ...q, method: "effective" });
    expect(r.totals.untaxedBreakdown).toEqual({
      contributionsCents: 10_000,
      dunningFeesCents: 340,
      creditNotesCents: -1_150,
      otherCents: 700,
    });
    expect(r.totals.untaxedCents).toBe(9_890);
    expect(r.totals.turnoverCents - r.totals.untaxedCents).toBe(5_000);
  });

  it("MwSt-Kontrolle: Abrechnung = Steuerkonten; Konten mit Satz zählen als Steuerkonto", async () => {
    expect(await vatCheck(ledger, T, q)).toMatchObject({
      active: true,
      payableCents: 9_720,
      accountsCents: 9_720,
      differenceCents: 0,
    });
    // 2201 trägt einen Satz und zählt als Steuerkonto. Die Abrechnung kennt die Buchung nicht: Differenz.
    const line = (
      id: string,
      accountId: string,
      side: "debit" | "credit",
      amountCents: number,
    ) => ({
      id,
      bookingId: "B8",
      date: "2026-03-10",
      accountId,
      side,
      amountCents,
      text: "",
    });
    const extra = new InMemoryLedger().seed(T, {
      ...fixture,
      accounts: [
        ...fixture.accounts,
        { id: "a2201", number: "2201", name: "MwSt 2.6 %", type: "liability", taxRateBp: 260 },
      ],
      lines: [
        ...fixture.lines,
        line("z1", "a1100", "debit", 10_260),
        line("z2", "a3200", "credit", 10_000),
        line("z3", "a2201", "credit", 260),
      ],
    });
    const off = await vatCheck(extra, T, q);
    expect(off.accountsCents).toBe(9_980);
    expect(off.differenceCents).toBe(-260);
  });

  it("MwSt-Kontrolle: nur Umsatz ohne Steuer ist keine MwSt-Periode", async () => {
    const l = new InMemoryLedger().seed(T, {
      vat: [
        {
          bookingId: "x",
          date: "2026-01-10",
          kind: "output",
          rateBp: 0,
          netCents: 100,
          taxCents: 0,
        },
      ],
    });
    expect((await vatCheck(l, T, q)).active).toBe(false);
  });

  it("Kontrolle: geschuldete Steuer = Bewegung auf Konto 2200", async () => {
    const r = await vatReport(ledger, T, { ...q, method: "effective" });
    const tb = await trialBalanceReport(ledger, T, q);
    const acc2200 = tb.rows.find((x) => x.number === "2200")!;
    expect(r.totals.outputTaxCents).toBe(-acc2200.closingCents);
  });

  it("Saldosteuersatz auf Brutto-Umsatz der ganzen Periode, kein Vorsteuerabzug", async () => {
    const r = await vatReport(ledger, T, { ...q, method: "saldo", saldoRateBp: 620 });
    // 1513.40 x 6.2 % = 93.8308 -> 93.83
    expect(r.totals).toMatchObject({
      taxableGrossCents: 151_340,
      outputTaxCents: 9_383,
      inputTaxCents: 0,
      payableCents: 9_383,
    });
    expect(r.rows.some((x) => x.kind === "input")).toBe(false);
  });

  it("Saldosteuersatz ist Pflicht bei Methode saldo", async () => {
    await expect(vatReport(ledger, T, { ...q, method: "saldo" })).rejects.toThrow(RangeError);
  });

  it("Periodenfilter: nur Februar", async () => {
    const r = await vatReport(ledger, T, {
      from: "2026-02-01",
      to: "2026-02-28",
      method: "effective",
    });
    expect(r.totals).toMatchObject({
      outputTaxCents: 4_050,
      inputTaxCents: 1_620,
      payableCents: 2_430,
    });
  });

  it("zeigt Rundungsabweichung der Einzelbuchungen", async () => {
    const tx = (n: number) => ({
      bookingId: `R${n}`,
      date: "2026-01-10",
      kind: "output" as const,
      rateBp: 810,
      netCents: 10,
      taxCents: 1,
    });
    const l = new InMemoryLedger().seed(T, { vat: [tx(1), tx(2), tx(3)] });
    const r = await vatReport(l, T, { ...q, method: "effective" });
    expect(r.rows[0]).toMatchObject({ taxCents: 3, computedTaxCents: 2, differenceCents: 1 });
  });
});

describe("Mandantentrennung", () => {
  it("fremder Mandant sieht nichts", async () => {
    const r = await openItemsReport(ledger, "anderer", { asOf: "2026-03-31" });
    expect(r.rows).toEqual([]);
  });
});
