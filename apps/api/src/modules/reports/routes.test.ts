import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { errorHandler } from "../../lib/errors.js";
import { neutralize, toCsv, toXlsx } from "./export.js";
import type { Table } from "./export.js";
import { fixture } from "./fixtures.js";
import { InMemoryLedger } from "./ledger-port.js";
import { InMemoryPeriodStore, PeriodService } from "./periods.js";
import { registerReportRoutes } from "./routes.js";

const config = loadConfig({ LOG_LEVEL: "silent" });

async function setup() {
  const ledger = new InMemoryLedger().seed("t1", fixture);
  const periods = new PeriodService({ ledger, store: new InMemoryPeriodStore() });
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  await app.register(rateLimit, { max: 1000, timeWindow: "1 minute" });
  await app.register(async (s) =>
    registerReportRoutes(s, {
      ledger,
      periods,
      // Test-Auth: Header `x-user` = `<mandant>:<benutzer>`.
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
const as = (user: string) => ({ "x-user": user });

describe("Export-Sicherheit", () => {
  it("neutralisiert Formelanfänge", () => {
    for (const s of ["=1+1", "+1", "-1", "@SUM(A1)", "\tX", "\rX"]) {
      expect(neutralize(s)).toBe(`'${s}`);
    }
    expect(neutralize("Muster AG")).toBe("Muster AG");
  });

  const table: Table = {
    title: "Test/[Blatt]",
    columns: [
      { label: "Name", type: "text" },
      { label: "Betrag", type: "money" },
      { label: "Anzahl", type: "int" },
    ],
    rows: [
      ['=HYPERLINK("http://evil","x")', -10_810, 2],
      ['Semikolon; und "Zitat"\nZeile', 5, 0],
      ["+cmd|' /C calc'!A0", 123_456, 1],
    ],
  };

  it("CSV: neutralisiert Texte, lässt Zahlen unverändert, quotet korrekt", () => {
    const csv = toCsv(table).toString("utf8");
    expect(csv.startsWith("﻿Name;Betrag;Anzahl\r\n")).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")";-108.10;2`);
    expect(csv).toContain(`"Semikolon; und ""Zitat""\nZeile";0.05;0`);
    expect(csv).toContain(`'+cmd|' /C calc'!A0;1234.56;1`);
  });

  it("XLSX: gültiges Paket, keine Formeln, Beträge exakt", () => {
    const files = unzipSync(toXlsx(table));
    expect(Object.keys(files).sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]!);
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain(
      '<t xml:space="preserve">\'=HYPERLINK(&quot;http://evil&quot;,&quot;x&quot;)</t>',
    );
    expect(sheet).toContain("<v>-108.10</v>");
    expect(sheet).toContain("<v>1234.56</v>");
    expect(strFromU8(files["xl/workbook.xml"]!)).toContain('name="Test  Blatt "');
  });
});

describe("Routen", () => {
  it("ohne Anmeldung 401 (Standard-Verdrahtung ist fail closed)", async () => {
    const app = await buildApp(config);
    const res = await app.inject({ method: "GET", url: "/reports/debtors?asOf=2026-03-31" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHENTICATED");
    const post = await app.inject({ method: "POST", url: "/reports/periods", payload: {} });
    expect(post.statusCode).toBe(401);
    await app.close();
  });

  it("liefert Bericht samt Kontrollsummen", async () => {
    const app = await setup();
    const res = await app.inject({
      method: "GET",
      url: "/reports/debtors?asOf=2026-03-31",
      headers: as("t1:u1"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totals).toMatchObject({ openCents: 63_240, differenceCents: 0 });
    expect(res.json().page).toEqual({ limit: 100, offset: 0, total: 2 });
  });

  it("Pagination schneidet nur Zeilen, Summen bleiben", async () => {
    const app = await setup();
    const res = await app.inject({
      method: "GET",
      url: "/reports/trial-balance?from=2026-01-01&to=2026-03-31&limit=3&offset=2",
      headers: as("t1:u1"),
    });
    const body = res.json();
    expect(body.rows).toHaveLength(3);
    expect(body.page.total).toBe(8);
    expect(body.totals.balanced).toBe(true);
  });

  it("Mandantentrennung: anderer Mandant sieht keine Daten", async () => {
    const app = await setup();
    const res = await app.inject({
      method: "GET",
      url: "/reports/open-items?asOf=2026-03-31",
      headers: as("t2:u2"),
    });
    expect(res.json().rows).toEqual([]);
  });

  it.each([
    "/reports/debtors",
    "/reports/debtors?asOf=2026-02-30",
    "/reports/debtors?asOf=morgen",
    "/reports/income-statement?from=2026-03-01&to=2026-01-01",
    "/reports/vat?from=2026-01-01&to=2026-03-31&method=saldo",
    "/reports/vat?from=2026-01-01&to=2026-03-31&method=saldo&saldoRateBp=99999",
    "/reports/open-items?asOf=2026-03-31&limit=100000",
  ])("ungültige Eingabe %s -> 400 ohne Details", async (url) => {
    const app = await setup();
    const res = await app.inject({ method: "GET", url, headers: as("t1:u1") });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: "VALIDATION", message: "Ungültige Anfrage." } });
  });

  it("unbekannter Bericht -> 404", async () => {
    const app = await setup();
    for (const name of ["gibts-nicht", "constructor", "__proto__"]) {
      const res = await app.inject({
        method: "GET",
        url: `/reports/${name}`,
        headers: as("t1:u1"),
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it("MwSt über die API", async () => {
    const app = await setup();
    const res = await app.inject({
      method: "GET",
      url: "/reports/vat?from=2026-01-01&to=2026-03-31&method=saldo&saldoRateBp=620",
      headers: as("t1:u1"),
    });
    expect(res.json().totals.payableCents).toBe(9_383);
  });

  it("Export CSV und XLSX mit Anhang-Headern", async () => {
    const app = await setup();
    const csv = await app.inject({
      method: "GET",
      url: "/reports/open-items/export?asOf=2026-03-31&format=csv",
      headers: as("t1:u1"),
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(csv.headers["content-disposition"]).toBe('attachment; filename="open-items.csv"');
    expect(csv.headers["cache-control"]).toBe("no-store");
    expect(csv.body).toContain("Total;;;;;;;632.40;");
    const xlsx = await app.inject({
      method: "GET",
      url: "/reports/balance-sheet/export?asOf=2026-03-31&format=xlsx",
      headers: as("t1:u1"),
    });
    expect(xlsx.headers["content-type"]).toContain("spreadsheetml.sheet");
    expect(Object.keys(unzipSync(xlsx.rawPayload))).toContain("xl/worksheets/sheet1.xml");
    const bad = await app.inject({
      method: "GET",
      url: "/reports/open-items/export?asOf=2026-03-31&format=exe",
      headers: as("t1:u1"),
    });
    expect(bad.statusCode).toBe(400);
  });

  it("Export ist enger ratenbegrenzt als der Rest (SR-71)", async () => {
    const app = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/reports/debtors/export?asOf=2026-03-31&format=csv",
        headers: as("t1:u1"),
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it("Periodenablauf über die API inkl. Mandantengrenze", async () => {
    const app = await setup();
    const h = as("t1:u1");
    const created = await app.inject({
      method: "POST",
      url: "/reports/periods",
      headers: h,
      payload: { label: "Januar 2026", from: "2026-01-01", to: "2026-01-31" },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();

    // Ein anderer Mandant findet die Periode nicht.
    const foreign = await app.inject({
      method: "POST",
      url: `/reports/periods/${id}/check`,
      headers: as("t2:u2"),
    });
    expect(foreign.statusCode).toBe(404);

    const early = await app.inject({
      method: "POST",
      url: `/reports/periods/${id}/confirm`,
      headers: h,
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe("INVALID_STATE");

    const checked = await app.inject({
      method: "POST",
      url: `/reports/periods/${id}/check`,
      headers: h,
    });
    expect(checked.json().state).toBe("checked");
    const closed = await app.inject({
      method: "POST",
      url: `/reports/periods/${id}/confirm`,
      headers: h,
    });
    expect(closed.json().state).toBe("closed");

    const list = await app.inject({ method: "GET", url: "/reports/periods", headers: h });
    expect(list.json().periods).toHaveLength(1);
    const overlap = await app.inject({
      method: "POST",
      url: "/reports/periods",
      headers: h,
      payload: { label: "x", from: "2026-01-15", to: "2026-02-15" },
    });
    expect(overlap.statusCode).toBe(409);
  });

  it("Perioden-Eingabe: unbekannte Felder werden ignoriert, Pflichtfelder verlangt", async () => {
    const app = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/reports/periods",
      headers: as("t1:u1"),
      payload: { label: "", from: "2026-01-01", to: "2026-01-31", state: "closed" },
    });
    expect(res.statusCode).toBe(400);
    const ok = await app.inject({
      method: "POST",
      url: "/reports/periods",
      headers: as("t1:u1"),
      payload: { label: "Q1", from: "2026-01-01", to: "2026-03-31", state: "closed", version: 99 },
    });
    expect(ok.json()).toMatchObject({ state: "open", version: 1 });
  });
});
