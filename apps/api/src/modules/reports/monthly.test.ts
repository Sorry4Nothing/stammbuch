import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../lib/errors.js";
import { fixture } from "./fixtures.js";
import { InMemoryLedger } from "./ledger-port.js";
import { monthlyReport } from "./monthly.js";
import { InMemoryPeriodStore, PeriodService } from "./periods.js";
import { registerReportRoutes } from "./routes.js";

const ledger = new InMemoryLedger().seed("t1", fixture);
const Q1 = { from: "2026-01-01", to: "2026-03-31" };

describe("Ergebnis je Monat", () => {
  it("gruppiert Ertrag, Aufwand, Fakturiert und Beglichen je Monat", async () => {
    const r = await monthlyReport(ledger, "t1", Q1);
    expect(r.rows).toEqual([
      {
        month: "2026-01",
        revenueCents: 120_000,
        expenseCents: 0,
        resultCents: 120_000,
        invoicedCents: 128_100,
        settledCents: 0,
      },
      {
        month: "2026-02",
        revenueCents: 50_000,
        expenseCents: 20_000,
        resultCents: 30_000,
        invoicedCents: 54_050,
        settledCents: 108_100,
      },
      {
        month: "2026-03",
        revenueCents: -10_000,
        expenseCents: 0,
        resultCents: -10_000,
        invoicedCents: -10_810,
        settledCents: 0,
      },
    ]);
    // Summe der Monate = Erfolgsrechnung (Ertrag 1'600.00, Aufwand 200.00, Ergebnis 1'400.00).
    expect(r.totals).toMatchObject({
      revenueCents: 160_000,
      expenseCents: 20_000,
      resultCents: 140_000,
    });
  });

  it("führt Monate ohne Buchung mit 0 und überspringt den Jahreswechsel richtig", async () => {
    const r = await monthlyReport(ledger, "t1", { from: "2025-11-01", to: "2026-02-28" });
    expect(r.rows.map((x) => x.month)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(r.rows[0]).toMatchObject({ revenueCents: 0, invoicedCents: 0 });
  });

  it("zählt nur den Zeitraum und nie einen fremden Mandanten", async () => {
    const feb = await monthlyReport(ledger, "t1", { from: "2026-02-01", to: "2026-02-28" });
    expect(feb.rows).toHaveLength(1);
    expect(feb.totals.revenueCents).toBe(50_000);
    const other = await monthlyReport(ledger, "t2", Q1);
    expect(other.totals).toEqual({
      revenueCents: 0,
      expenseCents: 0,
      resultCents: 0,
      invoicedCents: 0,
      settledCents: 0,
    });
  });
});

async function setup() {
  const periods = new PeriodService({ ledger, store: new InMemoryPeriodStore() });
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  await app.register(rateLimit, { max: 1000, timeWindow: "1 minute" });
  await app.register(async (s) =>
    registerReportRoutes(s, {
      ledger,
      periods,
      authenticate: async (req) => {
        const h = req.headers["x-user"];
        if (typeof h !== "string") return undefined;
        const [tenantId, userId] = h.split(":");
        return tenantId && userId ? { tenantId, userId } : undefined;
      },
    }),
  );
  return app;
}

describe("Route /reports/monthly-result", () => {
  const url = "/reports/monthly-result?from=2026-01-01&to=2026-03-31";

  it("verlangt Anmeldung", async () => {
    const app = await setup();
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    await app.close();
  });

  it("liefert Monate samt Summen und trennt Mandanten", async () => {
    const app = await setup();
    const own = await app.inject({ method: "GET", url, headers: { "x-user": "t1:u1" } });
    expect(own.statusCode).toBe(200);
    expect(own.json().rows).toHaveLength(3);
    expect(own.json().totals.resultCents).toBe(140_000);
    const foreign = await app.inject({ method: "GET", url, headers: { "x-user": "t2:u2" } });
    expect(foreign.json().totals.revenueCents).toBe(0);
    await app.close();
  });

  it("exportiert als CSV", async () => {
    const app = await setup();
    const res = await app.inject({
      method: "GET",
      url: `/reports/monthly-result/export?from=2026-01-01&to=2026-03-31&format=csv`,
      headers: { "x-user": "t1:u1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("2026-02;500.00;200.00;300.00;540.50;1081.00");
    await app.close();
  });

  it.each([
    "/reports/monthly-result",
    "/reports/monthly-result?from=2026-03-31&to=2026-01-01",
    "/reports/monthly-result?from=2026-02-30&to=2026-03-31",
    "/reports/monthly-result?from=2020-01-01&to=2026-03-31",
  ])("lehnt ungültige Eingabe ab: %s", async (bad) => {
    const app = await setup();
    const res = await app.inject({ method: "GET", url: bad, headers: { "x-user": "t1:u1" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
