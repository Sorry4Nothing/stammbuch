import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { createMemoryStore } from "./repository.js";
import type { MemoryNames } from "./repository.js";
import { registerAccountingRoutes } from "./routes.js";
import { AccountingService } from "./service.js";

async function testApp(names: MemoryNames = {}) {
  const app = Fastify();
  await registerAccountingRoutes(app, {
    service: new AccountingService(
      createMemoryStore(names),
      () => new Date("2026-06-15T10:00:00Z"),
    ),
    // Test-Auth: Mandant aus Header; ohne Header nicht angemeldet.
    authenticate: async (req) => {
      const tenant = req.headers["x-test-tenant"];
      return typeof tenant === "string" ? { tenantId: tenant, userId: `user-${tenant}` } : null;
    },
  });
  const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, tenant = "t1") =>
    app.inject({ method, url, payload: payload as object, headers: { "x-test-tenant": tenant } });
  return { app, call };
}

const invoice = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: "inv-0001-abcd",
  kind: "invoice",
  personId: "p1",
  reference: "R-1",
  bookingDate: "2026-06-01",
  dueDate: "2026-07-01",
  counterLines: [{ accountCode: "3000", amount: 10000 }],
  ...over,
});

describe("Zugriffsschutz (SR-10, SR-12, SR-54)", () => {
  const routes: ["GET" | "POST" | "PATCH", string][] = [
    ["GET", "/accounting/accounts"],
    ["POST", "/accounting/accounts"],
    ["PATCH", "/accounting/accounts/3000"],
    ["GET", "/accounting/export/accounts"],
    ["GET", "/accounting/entries/count"],
    ["GET", "/accounting/persons/p1/statement"],
    ["GET", "/accounting/entries"],
    ["GET", "/accounting/entries/00000000-0000-4000-8000-000000000000"],
    ["POST", "/accounting/entries"],
    ["POST", "/accounting/entries/00000000-0000-4000-8000-000000000000/reverse"],
    ["POST", "/accounting/receivables"],
    ["POST", "/accounting/payments"],
    ["POST", "/accounting/allocations"],
    ["POST", "/accounting/allocations/00000000-0000-4000-8000-000000000000/reverse"],
    ["GET", "/accounting/open-items"],
    ["GET", "/accounting/credits"],
    ["GET", "/accounting/debtors"],
    ["GET", "/accounting/debtors/reconciliation"],
    ["GET", "/accounting/persons/p1/ledger"],
    ["GET", "/accounting/trial-balance"],
    ["GET", "/accounting/periods"],
    ["POST", "/accounting/periods/2026-05/close"],
    ["POST", "/accounting/periods/2026-05/reopen"],
    ["GET", "/accounting/audit"],
    ["GET", "/accounting/integrity"],
  ];

  it.each(routes)("%s %s verlangt Anmeldung", async (method, url) => {
    const { app } = await testApp();
    const res = await app.inject({ method, url, payload: method === "GET" ? undefined : {} });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("Standard-Verdrahtung des Moduls lehnt alles ab, bis die Auth-Schicht eingebunden ist", async () => {
    const app = await buildApp(loadConfig({ LOG_LEVEL: "silent" }));
    const res = await app.inject({ method: "GET", url: "/accounting/accounts" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("ein Fehler in der Authentifizierung ist ein 500, kein Durchlass", async () => {
    const app = Fastify();
    await registerAccountingRoutes(app, {
      service: new AccountingService(createMemoryStore()),
      authenticate: async () => {
        throw new Error("Auth-Backend down");
      },
    });
    const res = await app.inject({ method: "GET", url: "/accounting/accounts" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("Auth-Backend");
  });
});

describe("Ablauf Rechnung, Zahlung, Zuordnung", () => {
  it("buchen, zuordnen, Debitorenkonto lesen", async () => {
    const { call } = await testApp();
    const inv = await call("POST", "/accounting/receivables", invoice());
    expect(inv.statusCode).toBe(201);
    const openItemId = inv.json().openItem.id;

    const replay = await call("POST", "/accounting/receivables", invoice());
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);

    const pay = await call("POST", "/accounting/payments", {
      idempotencyKey: "pay-0001-abcd",
      personId: "p1",
      bankAccountCode: "1020",
      valueDate: "2026-06-10",
      amount: 12000,
      reference: "Z-1",
    });
    expect(pay.statusCode).toBe(201);

    const alloc = await call("POST", "/accounting/allocations", {
      idempotencyKey: "alloc-0001-abcd",
      creditId: pay.json().credit.id,
      allocations: [{ openItemId, amount: 10000 }],
    });
    expect(alloc.statusCode).toBe(201);

    const ledger = (await call("GET", "/accounting/persons/p1/ledger")).json();
    expect(ledger.balance).toBe(-2000);
    expect(ledger.unallocatedCredits[0].available).toBe(2000);
    expect(ledger.openItems).toEqual([]);

    expect((await call("GET", "/accounting/trial-balance")).json().balanced).toBe(true);
    expect((await call("GET", "/accounting/integrity")).json().ok).toBe(true);
    expect((await call("GET", "/accounting/debtors/reconciliation")).json().difference).toBe(0);
    expect((await call("GET", "/accounting/audit")).json().length).toBeGreaterThan(0);
  });

  it("Storno per Gegenbuchung über die API", async () => {
    const { call } = await testApp();
    const inv = (await call("POST", "/accounting/receivables", invoice())).json();
    const rev = await call("POST", `/accounting/entries/${inv.entry.id}/reverse`, {
      idempotencyKey: "rev-0001-abcd",
      bookingDate: "2026-06-02",
      reason: "Doppelt erfasst",
    });
    expect(rev.statusCode).toBe(201);
    expect((await call("GET", "/accounting/persons/p1/ledger")).json().balance).toBe(0);
    const again = await call("POST", `/accounting/entries/${inv.entry.id}/reverse`, {
      idempotencyKey: "rev-0002-abcd",
      bookingDate: "2026-06-02",
      reason: "Doppelt erfasst",
    });
    expect(again.statusCode).toBe(409);
  });

  it("Mandanten sehen nie Daten des anderen", async () => {
    const { call } = await testApp();
    const inv = (await call("POST", "/accounting/receivables", invoice())).json();
    expect(
      (await call("GET", `/accounting/entries/${inv.entry.id}`, undefined, "t2")).statusCode,
    ).toBe(404);
    expect(
      (await call("GET", "/accounting/persons/p1/ledger", undefined, "t2")).json().balance,
    ).toBe(0);
  });
});

describe("Eingabevalidierung (SR-20, SR-72) und Fehlerantworten (SR-51)", () => {
  it.each([
    ["unbekanntes Feld", invoice({ tenantId: "t2" })],
    ["Dezimalbetrag", invoice({ counterLines: [{ accountCode: "3000", amount: 10.5 }] })],
    ["negativer Betrag", invoice({ counterLines: [{ accountCode: "3000", amount: -1 }] })],
    ["ungültiges Datum", invoice({ bookingDate: "2026-02-30" })],
    ["Fälligkeit vor Rechnungsdatum", invoice({ dueDate: "2026-05-01" })],
    ["zu kurzer Schlüssel", invoice({ idempotencyKey: "x" })],
    ["leere Gegenkonten", invoice({ counterLines: [] })],
  ])("400 bei %s, ohne Schema-Details", async (_n, body) => {
    const { call } = await testApp();
    const res = await call("POST", "/accounting/receivables", body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: "VALIDATION", message: "Ungültige Anfrage." } });
  });

  it("Regelverletzungen sind 422 mit festem Text", async () => {
    const { call } = await testApp();
    const res = await call("POST", "/accounting/entries", {
      idempotencyKey: "man-0001-abcd",
      bookingDate: "2026-06-01",
      description: "schief",
      lines: [
        { accountCode: "1020", side: "debit", amount: 100 },
        { accountCode: "3000", side: "credit", amount: 90 },
      ],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toEqual({
      code: "UNBALANCED",
      message: "Soll und Haben sind nicht gleich.",
    });
  });

  it("Pagination ist begrenzt", async () => {
    const { call } = await testApp();
    expect((await call("GET", "/accounting/entries?limit=100000")).statusCode).toBe(400);
    expect((await call("GET", "/accounting/entries?foo=1")).statusCode).toBe(400);
  });
});

describe("Konto umbenennen, Anzahl, Export und Kontoauszug", () => {
  it("PATCH /accounts/:code benennt um; ungültig und unbekannt werden abgelehnt", async () => {
    const { call } = await testApp();
    const ok = await call("PATCH", "/accounting/accounts/3000", { name: "Vereinsbeiträge" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ code: "3000", name: "Vereinsbeiträge", type: "revenue" });
    const list = (await call("GET", "/accounting/accounts")).json();
    expect(list.find((a: { code: string }) => a.code === "3000").name).toBe("Vereinsbeiträge");

    for (const bad of [
      {},
      { name: "x" },
      { name: "Gut", type: "expense" },
      { name: "a".repeat(101) },
    ]) {
      expect((await call("PATCH", "/accounting/accounts/3000", bad)).statusCode).toBe(400);
    }
    expect((await call("PATCH", "/accounting/accounts/abc", { name: "Gut" })).statusCode).toBe(400);
    const missing = await call("PATCH", "/accounting/accounts/9999", { name: "Gut" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toEqual({ code: "NOT_FOUND", message: "Konto nicht gefunden." });
  });

  it("Mandant t2 kann das Konto von t1 nicht umbenennen", async () => {
    const { call } = await testApp();
    await call("PATCH", "/accounting/accounts/3000", { name: "Nur für t1" }, "t1");
    await call("GET", "/accounting/accounts", undefined, "t2");
    const t2 = (await call("GET", "/accounting/accounts", undefined, "t2")).json();
    expect(t2.find((a: { code: string }) => a.code === "3000").name).not.toBe("Nur für t1");
  });

  it("GET /entries/count zählt mit demselben Filter wie /entries; Namen aus dem Verzeichnis", async () => {
    const { call } = await testApp({ users: { "user-t1": "Erika Muster" } });
    await call("POST", "/accounting/receivables", invoice());
    await call("POST", "/accounting/receivables", invoice({ idempotencyKey: "inv-0002-abcd" }));
    expect((await call("GET", "/accounting/entries/count")).json()).toEqual({ total: 2 });
    expect((await call("GET", "/accounting/entries/count?accountCode=1020")).json()).toEqual({
      total: 0,
    });
    expect((await call("GET", "/accounting/entries/count?from=2026-07-01")).json()).toEqual({
      total: 0,
    });
    expect((await call("GET", "/accounting/entries/count", undefined, "t2")).json()).toEqual({
      total: 0,
    });
    expect((await call("GET", "/accounting/entries/count?limit=5")).statusCode).toBe(400);
    expect((await call("GET", "/accounting/entries/count?accountCode=x")).statusCode).toBe(400);

    const entries = (await call("GET", "/accounting/entries")).json();
    expect(entries[0]).toMatchObject({ createdBy: "user-t1", createdByName: "Erika Muster" });
  });

  it("Trial-Balance liefert die Buchungszahl je Konto", async () => {
    const { call } = await testApp();
    await call("POST", "/accounting/receivables", invoice());
    const rows = (await call("GET", "/accounting/trial-balance")).json().rows;
    expect(rows.find((r: { code: string }) => r.code === "1100").entryCount).toBe(1);
    expect(rows.find((r: { code: string }) => r.code === "1020").entryCount).toBe(0);
  });

  it("GET /export/accounts liefert eine XLSX-Datei ohne Zwischenspeicher", async () => {
    const { call } = await testApp();
    const res = await call("GET", "/accounting/export/accounts");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(res.headers["content-disposition"]).toBe('attachment; filename="kontenplan.xlsx"');
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.rawPayload.subarray(0, 2).toString()).toBe("PK");
  });

  it("GET /persons/:personId/statement liefert ein PDF; unbekannte Person und fremder Mandant 404", async () => {
    const { call } = await testApp();
    await call("POST", "/accounting/receivables", invoice());
    const res = await call("GET", "/accounting/persons/p1/statement");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="kontoauszug.pdf"');
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");

    expect((await call("GET", "/accounting/persons/niemand/statement")).statusCode).toBe(404);
    expect(
      (await call("GET", "/accounting/persons/p1/statement", undefined, "t2")).statusCode,
    ).toBe(404);
    expect((await call("GET", "/accounting/persons/p%201/statement")).statusCode).toBe(400);
  });
});
