import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { errorHandler } from "../../lib/errors.js";
import type { Table } from "./export.js";
import { InMemoryPeriodFacts } from "./facts.js";
import type { PeriodFacts } from "./facts.js";
import { fixture } from "./fixtures.js";
import { InMemoryLedger } from "./ledger-port.js";
import type { LedgerData } from "./ledger-port.js";
import { toPdf } from "./pdf.js";
import { InMemoryPeriodStore, PeriodService } from "./periods.js";
import { debtorsReport, vatReport } from "./reports.js";
import { registerReportRoutes } from "./routes.js";

const T = "t1";

// ---------------------------------------------------------------- Debitorenliste

const control = (id: string, name: string) => ({
  id,
  number: id,
  name,
  type: "asset" as const,
  debtorControl: true,
});

const debtorData: Partial<LedgerData> = {
  accounts: [control("1100", "Debitoren Mitglieder"), control("1101", "Debitoren Firmen")],
  debtors: [
    { id: "d1", number: "M-1", name: "Anna Muster", type: "person" },
    { id: "d2", number: "M-2", name: "Muster AG", type: "company" },
    { id: "d3", number: "M-3", name: "Ohne Art" },
  ],
  openItems: [
    {
      id: "p1",
      debtorId: "d1",
      reference: "R-1",
      issueDate: "2026-01-10",
      dueDate: "2026-02-10",
      amountCents: 10_000,
      settlements: [],
      dunningLevel: 1,
      accountId: "1100",
    },
    {
      id: "p2",
      debtorId: "d1",
      reference: "R-2",
      issueDate: "2026-01-12",
      dueDate: "2026-02-12",
      amountCents: 5_000,
      settlements: [],
      dunningLevel: 3,
      accountId: "1100",
    },
    {
      id: "p3",
      debtorId: "d2",
      reference: "R-3",
      issueDate: "2026-01-15",
      dueDate: "2026-02-15",
      amountCents: 20_000,
      settlements: [],
      dunningLevel: 0,
      accountId: "1101",
    },
    {
      id: "p4",
      debtorId: "d3",
      reference: "R-4",
      issueDate: "2026-01-20",
      dueDate: "2026-02-20",
      amountCents: 700,
      settlements: [],
    },
  ],
};

describe("Debitorenliste: Art, Mahnstufe und Konten", () => {
  const run = (data: Partial<LedgerData>) =>
    debtorsReport(new InMemoryLedger().seed(T, data), T, { asOf: "2026-03-01" });

  it("liefert Art und höchste Mahnstufe je Debitor", async () => {
    const r = await run(debtorData);
    const by = Object.fromEntries(r.rows.map((x) => [x.number, x]));
    expect(by["M-1"]).toMatchObject({ type: "person", dunningLevel: 3, itemCount: 2 });
    expect(by["M-2"]).toMatchObject({ type: "company", dunningLevel: 0 });
    // Quelle ohne Angaben: die Felder fehlen, es wird nichts erfunden.
    expect(by["M-3"]).not.toHaveProperty("type");
    expect(by["M-3"]).not.toHaveProperty("dunningLevel");
  });

  it("teilt nach Sammelkonto auf; Posten ohne Konto gehören zum ersten Sammelkonto", async () => {
    const r = await run(debtorData);
    expect(r.accounts).toEqual([
      { number: "1100", name: "Debitoren Mitglieder", debtors: 2, items: 3, balanceCents: 15_700 },
      { number: "1101", name: "Debitoren Firmen", debtors: 1, items: 1, balanceCents: 20_000 },
    ]);
    expect(r.accounts?.reduce((s, a) => s + a.balanceCents, 0)).toBe(r.totals.openCents);
  });

  it("ohne Sammelkonto keine Aufteilung", async () => {
    const r = await run({ ...debtorData, accounts: [] });
    expect(r).not.toHaveProperty("accounts");
  });

  it("die Offene-Posten-Liste trägt die Mahnstufe, aber keine internen Felder", async () => {
    const { openItemsReport } = await import("./reports.js");
    const r = await openItemsReport(new InMemoryLedger().seed(T, debtorData), T, {
      asOf: "2026-03-01",
    });
    expect(r.rows[0]).toMatchObject({ reference: "R-1", dunningLevel: 1 });
    expect(r.rows[0]).not.toHaveProperty("accountId");
  });
});

// ---------------------------------------------------------------- MwSt

describe("MwSt: Steuerkonto und Umsatz ohne Steuersatz", () => {
  it("nennt das Konto je Satz und den Umsatz ohne Steuersatz", async () => {
    const ledger = new InMemoryLedger().seed(T, {
      vat: [
        {
          bookingId: "B1",
          date: "2026-01-10",
          kind: "output",
          rateBp: 810,
          netCents: 100_000,
          taxCents: 8_100,
          account: "2200",
        },
        {
          bookingId: "B2",
          date: "2026-01-11",
          kind: "output",
          rateBp: 0,
          netCents: 30_000,
          taxCents: 0,
        },
        {
          bookingId: "B3",
          date: "2026-01-12",
          kind: "output",
          rateBp: 0,
          netCents: -5_000,
          taxCents: 0,
        },
        {
          bookingId: "B4",
          date: "2026-01-13",
          kind: "input",
          rateBp: 810,
          netCents: 10_000,
          taxCents: 810,
          account: "1170",
        },
      ],
    });
    const r = await vatReport(ledger, T, {
      from: "2026-01-01",
      to: "2026-01-31",
      method: "effective",
    });
    expect(r.rows.find((x) => x.kind === "output" && x.rateBp === 810)?.account).toBe("2200");
    expect(r.rows.find((x) => x.kind === "input")?.account).toBe("1170");
    // Quelle ohne Konto: kein erfundenes Konto.
    expect(r.rows.find((x) => x.rateBp === 0)).not.toHaveProperty("account");
    expect(r.totals.turnoverCents).toBe(125_000);
    expect(r.totals.untaxedCents).toBe(25_000);
    expect(r.totals.turnoverCents - r.totals.untaxedCents).toBe(100_000);
  });
});

// ---------------------------------------------------------------- Perioden

describe("Monatsperioden anlegen", () => {
  const make = (now: string, data: Partial<LedgerData> = fixture) => {
    const ledger = new InMemoryLedger().seed(T, data);
    let n = 0;
    const svc = new PeriodService({
      ledger,
      store: new InMemoryPeriodStore(),
      now: () => new Date(now),
      newId: () => `p${++n}`,
    });
    return { svc, ledger };
  };

  it("legt die Monate von der ersten Buchung bis zum laufenden Monat an, idempotent", async () => {
    const { svc } = make("2026-04-15T08:00:00Z");
    const first = await svc.ensureMonths(T);
    expect(first.map((p) => [p.label, p.from, p.to, p.state])).toEqual([
      ["Januar 2026", "2026-01-01", "2026-01-31", "open"],
      ["Februar 2026", "2026-02-01", "2026-02-28", "open"],
      ["März 2026", "2026-03-01", "2026-03-31", "open"],
      ["April 2026", "2026-04-01", "2026-04-30", "open"],
    ]);
    expect((await svc.ensureMonths(T)).map((p) => p.id)).toEqual(first.map((p) => p.id));
  });

  it("überspringt Monate, die zu einer bestehenden Periode gehören", async () => {
    const { svc } = make("2026-04-15T08:00:00Z");
    await svc.create(T, { label: "Quartal 1", from: "2026-01-01", to: "2026-03-31" });
    const list = await svc.ensureMonths(T);
    expect(list.map((p) => p.label)).toEqual(["Quartal 1", "April 2026"]);
  });

  it("ohne Buchung nur der laufende Monat; das Datum gilt in Europe/Zurich", async () => {
    // 31.03. 23:30 UTC ist in Zürich (Sommerzeit) schon der 01.04.
    const { svc } = make("2026-03-31T23:30:00Z", {});
    expect((await svc.ensureMonths(T)).map((p) => p.label)).toEqual(["April 2026"]);
  });

  it("Schaltjahr und Jahreswechsel", async () => {
    const { svc } = make("2028-02-10T08:00:00Z", {
      lines: [
        {
          id: "l1",
          bookingId: "B",
          date: "2027-12-05",
          accountId: "a",
          side: "debit",
          amountCents: 1,
          text: "x",
        },
      ],
    });
    expect((await svc.ensureMonths(T)).map((p) => [p.label, p.to])).toEqual([
      ["Dezember 2027", "2027-12-31"],
      ["Januar 2028", "2028-01-31"],
      ["Februar 2028", "2028-02-29"],
    ]);
  });

  it("Mandanten sind getrennt", async () => {
    const { svc } = make("2026-02-10T08:00:00Z");
    await svc.ensureMonths(T);
    expect(await svc.list("t2")).toEqual([]);
  });
});

describe("Prüfpunkte aus Rechnungen und Zahlungsimport", () => {
  const setup = (facts: Partial<PeriodFacts>) => {
    const ledger = new InMemoryLedger().seed(T, fixture);
    const f = new InMemoryPeriodFacts(ledger).seed(T, { facts });
    return new PeriodService({ ledger, facts: f, store: new InMemoryPeriodStore() });
  };
  const jan = { label: "Januar", from: "2026-01-01", to: "2026-01-31" };

  it("nicht gebuchte Belege sperren den Abschluss", async () => {
    const svc = setup({ invoices: { total: 5, unbooked: 2 } });
    const p = await svc.create(T, jan);
    const r = await svc.runCheck(T, p.id, "u1");
    expect(r.state).toBe("open");
    expect(r.issues).toContainEqual(
      expect.objectContaining({ code: "INVOICE_NOT_BOOKED", severity: "error" }),
    );
  });

  it("Restposten und Entwürfe sind Warnungen und sperren nicht", async () => {
    const svc = setup({
      drafts: 2,
      leftovers: { count: 3, totalCents: 146_600, rows: [] },
    });
    const p = await svc.create(T, jan);
    const r = await svc.runCheck(T, p.id, "u1");
    expect(r.state).toBe("checked");
    expect(r.issues.map((i) => [i.code, i.severity])).toEqual([
      ["PAYMENT_LEFTOVERS", "warning"],
      ["DRAFT_INVOICES", "warning"],
    ]);
    expect((await svc.confirm(T, p.id, "u1")).state).toBe("closed");
  });
});

// ---------------------------------------------------------------- Routen

async function setup() {
  const ledger = new InMemoryLedger().seed(T, fixture);
  const facts = new InMemoryPeriodFacts(ledger).seed(T, {
    users: { u1: "Sabine Muster" },
    facts: {
      invoices: { total: 3, unbooked: 0 },
      drafts: 1,
      leftovers: {
        count: 1,
        totalCents: 84_600,
        rows: [
          {
            id: "l1",
            valueDate: "2026-01-28",
            payer: "Beispiel Bäckerei GmbH",
            amountCents: 84_600,
            reason: "Referenz fehlt",
          },
        ],
      },
    },
  });
  const periods = new PeriodService({
    ledger,
    facts,
    store: new InMemoryPeriodStore(),
    now: () => new Date("2026-03-15T08:00:00Z"),
  });
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  await app.register(rateLimit, { max: 1000, timeWindow: "1 minute" });
  await app.register(async (s) =>
    registerReportRoutes(s, {
      ledger,
      facts,
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
const as = (user: string) => ({ "x-user": user });

describe("Routen für Perioden und Export", () => {
  it("Standard-Verdrahtung ohne Anmeldung: 401 auf allen neuen Routen (fail closed)", async () => {
    const app = await buildApp(loadConfig({ LOG_LEVEL: "silent" }));
    for (const [method, url] of [
      ["POST", "/reports/periods/ensure"],
      ["GET", "/reports/periods/x/facts"],
      ["GET", "/reports/periods/x/export?format=pdf"],
      ["GET", "/reports/debtors/export?asOf=2026-03-31&format=pdf"],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, url).toBe(401);
    }
    await app.close();
  });

  it("legt Monate an und liefert Buchungsanzahl je Periode", async () => {
    const app = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/reports/periods/ensure",
      headers: as("t1:u1"),
    });
    expect(res.statusCode).toBe(200);
    const periods = res.json().periods as { label: string; bookings: number }[];
    expect(periods.map((p) => [p.label, p.bookings])).toEqual([
      ["Januar 2026", 3],
      ["Februar 2026", 3],
      ["März 2026", 1],
    ]);
    const again = await app.inject({
      method: "POST",
      url: "/reports/periods/ensure",
      headers: as("t1:u1"),
    });
    expect(again.json().periods).toHaveLength(3);
    // Der andere Mandant hat nichts: ohne Buchung entsteht nur der laufende Monat.
    const other = await app.inject({
      method: "POST",
      url: "/reports/periods/ensure",
      headers: as("t2:u2"),
    });
    expect(other.json().periods.map((p: { label: string }) => p.label)).toEqual(["März 2026"]);
  });

  it("nennt den Namen der abschliessenden Person", async () => {
    const app = await setup();
    const h = as("t1:u1");
    const { periods } = (
      await app.inject({ method: "POST", url: "/reports/periods/ensure", headers: h })
    ).json();
    const id = periods[0].id as string;
    await app.inject({ method: "POST", url: `/reports/periods/${id}/check`, headers: h });
    const closed = await app.inject({
      method: "POST",
      url: `/reports/periods/${id}/confirm`,
      headers: h,
    });
    expect(closed.json()).toMatchObject({
      state: "closed",
      closedBy: "Sabine Muster",
      bookings: 3,
    });
    const list = (await app.inject({ method: "GET", url: "/reports/periods", headers: h })).json();
    expect(list.periods[0]).toMatchObject({ closedBy: "Sabine Muster" });
    expect(list.periods[1]).not.toHaveProperty("closedBy");
  });

  it("Angaben zur Periode: nur eigener Mandant, unbekannte Periode 404", async () => {
    const app = await setup();
    const { periods } = (
      await app.inject({ method: "POST", url: "/reports/periods/ensure", headers: as("t1:u1") })
    ).json();
    const id = periods[0].id as string;
    const ok = await app.inject({
      method: "GET",
      url: `/reports/periods/${id}/facts`,
      headers: as("t1:u1"),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      drafts: 1,
      leftovers: { count: 1, rows: [{ payer: "Beispiel Bäckerei GmbH" }] },
      stats: { bookings: 3 },
    });
    for (const [url, user] of [
      [`/reports/periods/${id}/facts`, "t2:u2"],
      ["/reports/periods/gibts-nicht/facts", "t1:u1"],
    ] as const) {
      const res = await app.inject({ method: "GET", url, headers: as(user) });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("NOT_FOUND");
    }
  });

  it("Auswertung als PDF mit Anhang-Headern", async () => {
    const app = await setup();
    const res = await app.inject({
      method: "GET",
      url: "/reports/trial-balance/export?from=2026-01-01&to=2026-03-31&format=pdf",
      headers: as("t1:u1"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="trial-balance.pdf"');
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(res.rawPayload);
    expect(doc.getTitle()).toContain("Saldenliste");
    const bad = await app.inject({
      method: "GET",
      url: "/reports/trial-balance/export?from=2026-01-01&to=2026-03-31&format=exe",
      headers: as("t1:u1"),
    });
    expect(bad.statusCode).toBe(400);
  });

  it("Abschlussbericht als PDF; fremder Mandant 404, anderes Format 400", async () => {
    const app = await setup();
    const { periods } = (
      await app.inject({ method: "POST", url: "/reports/periods/ensure", headers: as("t1:u1") })
    ).json();
    const id = periods[0].id as string;
    const url = `/reports/periods/${id}/export?format=pdf`;
    const ok = await app.inject({ method: "GET", url, headers: as("t1:u1") });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("application/pdf");
    expect((await PDFDocument.load(ok.rawPayload)).getTitle()).toBe("Abschlussbericht Januar 2026");
    expect((await app.inject({ method: "GET", url, headers: as("t2:u2") })).statusCode).toBe(404);
    const csv = await app.inject({
      method: "GET",
      url: `/reports/periods/${id}/export?format=csv`,
      headers: as("t1:u1"),
    });
    expect(csv.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------- PDF

describe("PDF-Erzeugung", () => {
  const table = (rows: Table["rows"]): Table => ({
    title: "Test",
    columns: [
      { label: "Name", type: "text" },
      { label: "Betrag", type: "money" },
      { label: "Anzahl", type: "int" },
    ],
    rows,
  });

  it("schreibt mehrere Seiten, wenn die Zeilen nicht auf eine passen", async () => {
    const rows: Table["rows"] = Array.from({ length: 120 }, (_, i) => [`Zeile ${i}`, i * 1_00, i]);
    const doc = await PDFDocument.load(await toPdf(table(rows)));
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it("verkraftet Zeichen ausserhalb von WinAnsi, Umlaute und sehr lange Texte", async () => {
    const pdf = await toPdf(
      table([
        ["Здравствуйте 東京 Müller-Zürich", -1_234_567_89, 1],
        ["x".repeat(5_000), 5, 0],
        ["Zeile\nmit\tUmbruch", null, null],
      ]),
    );
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });

  it("leere Tabelle ergibt trotzdem ein gültiges PDF", async () => {
    expect((await PDFDocument.load(await toPdf(table([])))).getPageCount()).toBe(1);
  });
});
