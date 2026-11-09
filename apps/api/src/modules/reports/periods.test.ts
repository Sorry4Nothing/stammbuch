import { beforeEach, describe, expect, it } from "vitest";
import { fixture } from "./fixtures.js";
import { InMemoryLedger } from "./ledger-port.js";
import { createPeriodGuard, InMemoryPeriodStore, PeriodError, PeriodService } from "./periods.js";

const T = "t1";
let ledger: InMemoryLedger;
let store: InMemoryPeriodStore;
let svc: PeriodService;
let ids: string[];

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof PeriodError ? e.code : "other"),
  );

beforeEach(() => {
  ledger = new InMemoryLedger().seed(T, fixture);
  store = new InMemoryPeriodStore();
  let n = 0;
  svc = new PeriodService({
    ledger,
    store,
    now: () => new Date("2026-04-01T08:00:00Z"),
    newId: () => `p${++n}`,
  });
  ids = [];
});

async function createQuarterMonths() {
  for (const [label, from, to] of [
    ["Januar", "2026-01-01", "2026-01-31"],
    ["Februar", "2026-02-01", "2026-02-28"],
    ["März", "2026-03-01", "2026-03-31"],
  ] as const) {
    ids.push((await svc.create(T, { label, from, to })).id);
  }
}

describe("Periodenabschluss", () => {
  it("open -> checked -> closed, mit Verlauf", async () => {
    await createQuarterMonths();
    const checked = await svc.runCheck(T, ids[0]!, "u1");
    expect(checked.state).toBe("checked");
    expect(checked.checkFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const closed = await svc.confirm(T, ids[0]!, "u1");
    expect(closed.state).toBe("closed");
    expect(closed.history.map((h) => [h.from, h.to, h.actor])).toEqual([
      ["open", "checked", "u1"],
      ["checked", "closed", "u1"],
    ]);
  });

  it("Bestätigung ohne Prüfung ist verboten", async () => {
    await createQuarterMonths();
    expect(await code(svc.confirm(T, ids[0]!, "u1"))).toBe("INVALID_STATE");
  });

  it("Perioden schliessen nur der Reihe nach", async () => {
    await createQuarterMonths();
    await svc.runCheck(T, ids[1]!, "u1");
    expect(await code(svc.confirm(T, ids[1]!, "u1"))).toBe("PREDECESSOR_OPEN");
  });

  it("abgeschlossen ist endgültig", async () => {
    await createQuarterMonths();
    await svc.runCheck(T, ids[0]!, "u1");
    await svc.confirm(T, ids[0]!, "u1");
    expect(await code(svc.runCheck(T, ids[0]!, "u1"))).toBe("INVALID_STATE");
    expect(await code(svc.revokeCheck(T, ids[0]!, "u1"))).toBe("INVALID_STATE");
    expect(await code(svc.confirm(T, ids[0]!, "u1"))).toBe("INVALID_STATE");
  });

  it("Prüfung zurücknehmen führt zu open", async () => {
    await createQuarterMonths();
    await svc.runCheck(T, ids[0]!, "u1");
    const p = await svc.revokeCheck(T, ids[0]!, "u1");
    expect(p.state).toBe("open");
    expect(p.checkFingerprint).toBeUndefined();
  });

  it("Buchung nach der Prüfung macht die Bestätigung ungültig", async () => {
    await createQuarterMonths();
    await svc.runCheck(T, ids[0]!, "u1");
    ledger.seed(T, {
      ...fixture,
      lines: [
        ...fixture.lines,
        {
          id: "n1",
          bookingId: "BN",
          date: "2026-01-31",
          accountId: "a1020",
          side: "debit",
          amountCents: 100,
          text: "",
        },
        {
          id: "n2",
          bookingId: "BN",
          date: "2026-01-31",
          accountId: "a2800",
          side: "credit",
          amountCents: 100,
          text: "",
        },
      ],
    });
    expect(await code(svc.confirm(T, ids[0]!, "u1"))).toBe("STALE_CHECK");
    expect((await store.get(T, ids[0]!))?.state).toBe("open");
  });

  it("Prüfung scheitert bei unausgeglichener Buchung und bleibt open", async () => {
    await createQuarterMonths();
    ledger.seed(T, { ...fixture, lines: fixture.lines.filter((l) => l.id !== "l02") });
    const p = await svc.runCheck(T, ids[0]!, "u1");
    expect(p.state).toBe("open");
    expect(p.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(["BOOKING_UNBALANCED", "TRIAL_BALANCE_UNBALANCED"]),
    );
    expect(await code(svc.confirm(T, ids[0]!, "u1"))).toBe("INVALID_STATE");
  });

  it("Prüfung scheitert bei Abweichung zwischen Debitoren und offenen Posten", async () => {
    await createQuarterMonths();
    ledger.seed(T, { ...fixture, openItems: fixture.openItems.filter((i) => i.id !== "p2") });
    const p = await svc.runCheck(T, ids[0]!, "u1");
    expect(p.state).toBe("open");
    expect(p.issues.some((i) => i.code === "DEBTOR_CONTROL_MISMATCH")).toBe(true);
  });

  it("Warnung (Überzahlung) blockiert nicht", async () => {
    await createQuarterMonths();
    ledger.seed(T, {
      ...fixture,
      openItems: fixture.openItems.map((i) =>
        i.id === "p2" ? { ...i, settlements: [{ date: "2026-01-25", amountCents: 20_001 }] } : i,
      ),
      // Hauptbuch passend zur Überzahlung: Bank/Debitoren +0.01
      lines: [
        ...fixture.lines,
        {
          id: "o1",
          bookingId: "BO",
          date: "2026-01-25",
          accountId: "a1020",
          side: "debit",
          amountCents: 20_001,
          text: "",
        },
        {
          id: "o2",
          bookingId: "BO",
          date: "2026-01-25",
          accountId: "a1100",
          side: "credit",
          amountCents: 20_001,
          text: "",
        },
      ],
    });
    const p = await svc.runCheck(T, ids[0]!, "u1");
    expect(p.issues).toEqual([
      expect.objectContaining({ code: "OVERPAID_ITEM", severity: "warning" }),
      expect.objectContaining({ code: "VAT_NOT_CONFIRMED", severity: "warning" }),
    ]);
    expect(p.state).toBe("checked");
  });

  it("Zeiträume dürfen sich nicht überschneiden", async () => {
    await createQuarterMonths();
    expect(await code(svc.create(T, { label: "x", from: "2026-01-31", to: "2026-02-05" }))).toBe(
      "OVERLAP",
    );
    expect(await code(svc.create(T, { label: "x", from: "2026-05-02", to: "2026-05-01" }))).toBe(
      "INVALID_RANGE",
    );
  });

  it("Perioden anderer Mandanten sind unsichtbar", async () => {
    await createQuarterMonths();
    expect(await code(svc.runCheck("fremd", ids[0]!, "u9"))).toBe("NOT_FOUND");
  });

  it("gleichzeitige Änderung wird erkannt (optimistische Sperre)", async () => {
    await createQuarterMonths();
    const stale = (await store.get(T, ids[0]!))!;
    await svc.runCheck(T, ids[0]!, "u1");
    expect(await code(store.save(T, { ...stale, version: stale.version + 1 }, stale.version))).toBe(
      "CONFLICT",
    );
  });
});

describe("Prüfpunkt MwSt geprüft", () => {
  const codes = (p: { issues: { code: string }[] }) => p.issues.map((i) => i.code);
  const extraBooking = {
    ...fixture,
    vat: [
      ...fixture.vat,
      {
        bookingId: "B9",
        date: "2026-01-30",
        kind: "output" as const,
        rateBp: 810,
        netCents: 1_000,
        taxCents: 81,
      },
    ],
    lines: [
      ...fixture.lines,
      ...(
        [
          ["x1", "a1020", "debit", 1_081],
          ["x2", "a3200", "credit", 1_000],
          ["x3", "a2200", "credit", 81],
        ] as const
      ).map(([id, accountId, side, amountCents]) => ({
        id,
        bookingId: "B9",
        date: "2026-01-30",
        accountId,
        side,
        amountCents,
        text: "",
      })),
    ],
  };

  it("Periode mit MwSt-Buchungen: Warnung, bis die Person die Abrechnung bestätigt", async () => {
    await createQuarterMonths();
    const first = await svc.runCheck(T, ids[0]!, "u1");
    expect(codes(first)).toEqual(["VAT_NOT_CONFIRMED"]);
    expect(first.state).toBe("checked");

    const confirmed = await svc.setVatConfirmation(T, ids[0]!, "u2", true);
    expect(codes(confirmed)).toEqual([]);
    expect(confirmed.state).toBe("checked");
    // Januar: Umsatz 1200.00 (1000 mit, 200 ohne Steuer), Steuer 81.00.
    expect(confirmed.vatConfirmation).toMatchObject({
      actor: "u2",
      turnoverCents: 120_000,
      outputTaxCents: 8_100,
      inputTaxCents: 0,
    });
    // Die Bestätigung bleibt bei der Periode, auch nach erneuter Prüfung.
    expect((await svc.runCheck(T, ids[0]!, "u1")).vatConfirmation?.actor).toBe("u2");
    expect((await svc.confirm(T, ids[0]!, "u1")).state).toBe("closed");
  });

  it("die Bestätigung lässt sich zurücknehmen", async () => {
    await createQuarterMonths();
    await svc.setVatConfirmation(T, ids[0]!, "u1", true);
    const p = await svc.setVatConfirmation(T, ids[0]!, "u1", false);
    expect(p.vatConfirmation).toBeUndefined();
    expect(codes(p)).toEqual(["VAT_NOT_CONFIRMED"]);
  });

  it("ändert sich die Abrechnung nach der Bestätigung, gilt sie nicht mehr", async () => {
    await createQuarterMonths();
    await svc.setVatConfirmation(T, ids[0]!, "u1", true);
    ledger.seed(T, extraBooking);
    const p = await svc.runCheck(T, ids[0]!, "u1");
    expect(p.issues).toEqual([
      expect.objectContaining({
        code: "VAT_NOT_CONFIRMED",
        message: "Die MwSt-Abrechnung hat sich seit der Bestätigung geändert.",
      }),
    ]);
  });

  it("Differenz zwischen MwSt-Buchungen und Steuerkonten ist eine Warnung", async () => {
    ledger.seed(T, {
      ...fixture,
      // Die Abrechnung kennt 1.00 mehr Steuer, als auf 2200 gebucht ist.
      vat: fixture.vat.map((v) => (v.bookingId === "B2" ? { ...v, taxCents: 8_200 } : v)),
    });
    await createQuarterMonths();
    const p = await svc.setVatConfirmation(T, ids[0]!, "u1", true);
    expect(p.issues).toEqual([
      expect.objectContaining({
        code: "VAT_ACCOUNT_MISMATCH",
        severity: "warning",
        message: "Die MwSt-Buchungen weichen um 100 Rappen von den Steuerkonten ab.",
      }),
    ]);
    // Eine Warnung blockiert den Abschluss nicht.
    expect((await svc.confirm(T, ids[0]!, "u1")).state).toBe("closed");
  });

  it("ohne MwSt-Buchungen gibt es nichts zu bestätigen", async () => {
    const april = await svc.create(T, { label: "April", from: "2026-04-01", to: "2026-04-30" });
    expect(codes(await svc.runCheck(T, april.id, "u1"))).toEqual([]);
    expect(await code(svc.setVatConfirmation(T, april.id, "u1", true))).toBe("INVALID_STATE");
  });

  it("in abgeschlossenen Perioden und für fremde Mandanten nicht möglich", async () => {
    await createQuarterMonths();
    await svc.runCheck(T, ids[0]!, "u1");
    await svc.confirm(T, ids[0]!, "u1");
    expect(await code(svc.setVatConfirmation(T, ids[0]!, "u1", true))).toBe("INVALID_STATE");
    expect(await code(svc.setVatConfirmation("fremd", ids[1]!, "u9", true))).toBe("NOT_FOUND");
  });
});

describe("Buchungssperre (PeriodGuard)", () => {
  it("sperrt Buchungen in abgeschlossenen Perioden, erlaubt sonst", async () => {
    await createQuarterMonths();
    const guard = createPeriodGuard(store);
    await svc.runCheck(T, ids[0]!, "u1");
    // geprüft, aber noch nicht abgeschlossen: noch erlaubt
    await expect(guard.assertBookingAllowed(T, "2026-01-31")).resolves.toBeUndefined();
    await svc.confirm(T, ids[0]!, "u1");
    expect(await code(guard.assertBookingAllowed(T, "2026-01-01"))).toBe("PERIOD_CLOSED");
    expect(await code(guard.assertBookingAllowed(T, "2026-01-31"))).toBe("PERIOD_CLOSED");
    await expect(guard.assertBookingAllowed(T, "2026-02-01")).resolves.toBeUndefined();
    await expect(guard.assertBookingAllowed("fremd", "2026-01-15")).resolves.toBeUndefined();
  });

  it("lehnt ungültige Daten ab (fail closed)", async () => {
    const guard = createPeriodGuard(store);
    expect(await code(guard.assertBookingAllowed(T, "morgen"))).toBe("INVALID_RANGE");
  });
});
