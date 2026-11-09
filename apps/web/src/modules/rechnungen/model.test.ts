import { describe, expect, it } from "vitest";
import {
  addDays,
  amount,
  chf,
  computeTotals,
  date,
  displayStatus,
  formatIban,
  formatReference,
  levelStartDay,
  parseAmount,
  parseDate,
  parseQuantity,
  qrPayload,
  quantity,
} from "./model";
import { buildHistory } from "./history";
import { makeInvoice, seedSettings } from "./memoryRechnungenService";

describe("Formate", () => {
  it("setzt Tausenderapostroph und zwei Nachkommastellen", () => {
    expect(chf(125000)).toBe("CHF 1'250.00");
    expect(amount(5)).toBe("0.05");
    expect(date("2026-11-02")).toBe("02.11.2026");
    expect(formatIban("CH0000000000000000000")).toBe("CH00 0000 0000 0000 0000 0");
    const ref = "00" + "00000" + "00000" + "00000" + "04310" + "00007";
    expect(formatReference({ type: "QRR", value: ref })).toBe("00 00000 00000 00000 04310 00007");
  });
});

describe("Eingaben", () => {
  it("liest Datum, Betrag und Menge", () => {
    expect(parseDate("02.11.2026")).toBe("2026-11-02");
    expect(parseDate("31.02.2026")).toBeNull();
    expect(parseDate("2026-11-02")).toBeNull();
    expect(parseAmount("250.00")).toBe(25000);
    expect(parseAmount("1'250")).toBe(125000);
    expect(parseAmount("12,5")).toBe(1250);
    expect(parseAmount("abc")).toBeNull();
    expect(parseQuantity("8")).toBe(8000);
    expect(parseQuantity("1.5")).toBe(1500);
    expect(parseQuantity("0")).toBeNull();
    expect(quantity(1500)).toBe("1.5");
    expect(quantity(8000)).toBe("8");
  });
});

describe("Summen wie im Board 4.2", () => {
  it("rechnet die MwSt je Satz auf der Summe der Nettobeträge", () => {
    const totals = computeTotals(
      [
        { description: "a", quantityMilli: 1000, unitCents: 25000, vatRateBp: 810 },
        { description: "b", quantityMilli: 8000, unitCents: 2500, vatRateBp: 260 },
      ],
      "exclusive",
      false,
    );
    expect(totals.netCents).toBe(45000);
    expect(totals.vatBuckets.map((b) => b.vatCents)).toEqual([520, 2025]);
    expect(totals.totalCents).toBe(47545);
  });

  it("rundet auf 5 Rappen, wenn gewünscht", () => {
    const t = computeTotals(
      [{ description: "a", quantityMilli: 1000, unitCents: 1003, vatRateBp: 0 }],
      "none",
      true,
    );
    expect(t.totalCents).toBe(1005);
    expect(t.roundingCents).toBe(2);
  });
});

describe("Mahnstufen", () => {
  it("zählt die Tage seit Fälligkeit wie im Board 4.5", () => {
    const levels = seedSettings.dunning.levels;
    expect([1, 2, 3].map((l) => levelStartDay(levels, l))).toEqual([10, 20, 30]);
  });

  it("leitet den Anzeige-Status ab", () => {
    const sent = makeInvoice({ id: "a" });
    expect(displayStatus(sent, 0)).toBe("open");
    expect(displayStatus(sent, 2)).toBe("reminded");
    expect(displayStatus(makeInvoice({ id: "b", status: "draft" }), 0)).toBe("draft");
    expect(displayStatus(makeInvoice({ id: "c", creditedCents: 100, openCents: 0 }), 0)).toBe(
      "credited",
    );
  });
});

describe("QR-Payload", () => {
  it("folgt dem Aufbau der SIX-Spezifikation", () => {
    const a = {
      name: "Verein",
      street: "Weg",
      buildingNumber: "1",
      postalCode: "8000",
      town: "Ort",
      country: "CH",
    };
    const lines = qrPayload({
      iban: "CH00 0000 0000 0000 0000 0",
      creditor: a,
      debtor: { ...a, name: "Firma" },
      amountCents: 47545,
      currency: "CHF",
      reference: { type: "QRR", value: "000000000000000004310000007" },
      message: "Rechnung R-1",
    }).split("\n");
    expect(lines.slice(0, 4)).toEqual(["SPC", "0200", "1", "CH0000000000000000000"]);
    expect(lines[18]).toBe("475.45");
    expect(lines[19]).toBe("CHF");
    expect(lines[27]).toBe("QRR");
    expect(addDays("2026-11-02", 30)).toBe("2026-12-02");
  });
});

describe("Verlauf", () => {
  const original = makeInvoice({ id: "i1", number: "R-1", status: "cancelled" });
  const history = (note: Partial<Parameters<typeof makeInvoice>[0]>) =>
    buildHistory({
      invoice: original,
      reminders: [],
      creditNotes: [
        makeInvoice({
          id: "c1",
          kind: "credit_note",
          number: "G-1",
          sentAt: "2026-11-03T10:00:00Z",
          totals: { ...original.totals, totalCents: -5000 },
          ...note,
        }),
      ],
      dueLevel: undefined,
      today: "2026-11-04",
    });

  it("zeigt Grund und Bemerkung eines Stornos", () => {
    const entry = history({ subject: "Storno: Falscher Betrag", notes: "Telefonisch geklärt" }).at(
      -1,
    );
    expect(entry).toMatchObject({
      kind: "cancel",
      params: { number: "G-1", amount: "50.00", note: " (Falscher Betrag. Telefonisch geklärt)" },
    });
    expect(history({ subject: "Storno", notes: "" }).at(-1)).toMatchObject({
      kind: "cancel",
      params: { note: "" },
    });
  });

  it("lässt eine gewöhnliche Gutschrift eine Gutschrift bleiben", () => {
    expect(history({ subject: "Beitrag anteilig erlassen" }).at(-1)?.kind).toBe("credit");
  });
});
