import { readFileSync } from "node:fs";
import { Datenbank } from "@stammbuch/db";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createTestDatabase, withCredentials } from "../../../../../packages/db/test/helpers.js";
import { errorHandler } from "../../lib/errors.js";
import { createPgCamtModule } from "./pg.js";
import { PgCamtRepository } from "./repository.pg.js";
import type { CamtContext } from "./repository.pg.js";
import { CamtImportService } from "./service.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const userA = "aaaaaaaa-0000-4000-8000-000000000001";
const userB = "bbbbbbbb-0000-4000-8000-000000000001";
const ctxA: CamtContext = { kundeId: A, benutzerId: userA };
const ctxB: CamtContext = { kundeId: B, benutzerId: userB };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

// Erfundene Namen und Daten (SR-41).
describe("CAMT mit PostgreSQL: Restposten zurückstellen und Importliste", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let owner: pg.Client;
  let db: Datenbank;

  const repo = (ctx: CamtContext) => new PgCamtRepository(db, ctx);
  const importFile = (ctx: CamtContext, name: string) =>
    new CamtImportService(repo(ctx), { findByReferences: () => Promise.resolve([]) }).importFile(
      fixture(name),
    );
  const rest = async (ctx: CamtContext) => (await repo(ctx).listRestPayments({ limit: 100 })).items;

  async function app() {
    const f = Fastify();
    f.setErrorHandler(errorHandler);
    await f.register(async (scope) => {
      await createPgCamtModule({
        db,
        authorize: () => Promise.resolve(),
        context: (req) => (req.headers["x-test-kunde"] === "B" ? ctxB : ctxA),
        openItems: () => ({ findByReferences: () => Promise.resolve([]) }),
        assigner: () => ({ assign: () => Promise.resolve("ASSIGNED") }),
      }).register(scope);
    });
    return f;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(inject("adminUrl"), inject("templateDb"));
    owner = new pg.Client({ connectionString: testDb.adminUrl });
    await owner.connect();
    await owner.query(
      `INSERT INTO kunde (id, name) VALUES ('${A}', 'Kunde A'), ('${B}', 'Kunde B')`,
    );
    await owner.query(
      `INSERT INTO benutzer (id, kunde_id, email, name, passwort_hash) VALUES
        ('${userA}', '${A}', 'a@example.test', 'Erika Muster', 'x'),
        ('${userB}', '${B}', 'b@example.test', 'Bruno Beispiel', 'x')`,
    );
    db = new Datenbank(withCredentials(testDb.adminUrl, "stammbuch_app", inject("appPassword")), {
      max: 5,
    });
  });

  afterAll(async () => {
    await db.close();
    await owner.end();
    await testDb.drop();
  });

  it("Importliste: neueste zuerst, mit Namen des Importierenden, je Mandant getrennt", async () => {
    await importFile(ctxA, "camt053-v04.xml");
    await importFile(ctxA, "camt054-v08.xml");
    await importFile(ctxB, "camt053-v04.xml");
    const f = await app();

    const res = await f.inject({ method: "GET", url: "/camt/imports" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasMore).toBe(false);
    expect(body.items.map((i: { kind: string }) => i.kind)).toEqual(["camt.054", "camt.053"]);
    expect(body.items.every((i: { importedBy: string }) => i.importedBy === "Erika Muster")).toBe(
      true,
    );
    expect(JSON.stringify(body)).not.toMatch(/hash|Bruno/i);

    const other = await f.inject({
      method: "GET",
      url: "/camt/imports",
      headers: { "x-test-kunde": "B" },
    });
    expect(other.json().items).toHaveLength(1);
    expect(other.json().items[0].importedBy).toBe("Bruno Beispiel");

    const paged = await f.inject({ method: "GET", url: "/camt/imports?limit=1" });
    expect(paged.json()).toMatchObject({ hasMore: true });
    expect(paged.json().items).toHaveLength(1);
    await f.close();
  });

  it("zurückstellen setzt die Markierung, schreibt Audit, bleibt Restposten und lässt sich aufheben", async () => {
    const f = await app();
    const id = (await rest(ctxA))[0]!.id;
    const post = (postponed: boolean, headers = {}) =>
      f.inject({
        method: "POST",
        url: `/camt/rest/${id}/zurueckstellen`,
        payload: { postponed },
        headers,
      });

    expect((await post(true)).json()).toEqual({ id, postponed: true });
    const row = await owner.query(
      "SELECT status, zurueckgestellt_von, zurueckgestellt_am IS NOT NULL AS gesetzt FROM camt_zahlung WHERE id = $1",
      [id],
    );
    expect(row.rows[0]).toEqual({ status: "REST", zurueckgestellt_von: userA, gesetzt: true });
    expect((await rest(ctxA)).find((p) => p.id === id)?.postponed).toBe(true);
    const list = (await f.inject({ method: "GET", url: "/camt/rest" })).json().items;
    expect(list.find((p: { id: string }) => p.id === id).postponed).toBe(true);

    // Anderer Mandant: Zahlung unbekannt, nichts verändert.
    expect((await post(true, { "x-test-kunde": "B" })).statusCode).toBe(404);

    expect((await post(false)).statusCode).toBe(200);
    expect((await rest(ctxA)).find((p) => p.id === id)).not.toHaveProperty("postponed");
    const audit = await owner.query(
      "SELECT aktion, benutzer_id, details FROM audit_log WHERE objekt_id = $1 AND aktion LIKE 'camt.zahlung_%' ORDER BY id",
      [id],
    );
    expect(audit.rows.map((r) => r.aktion)).toEqual([
      "camt.zahlung_zurueckgestellt",
      "camt.zahlung_wieder_aufgenommen",
    ]);
    expect(audit.rows[0]).toMatchObject({ benutzer_id: userA, details: {} });
    await f.close();
  });

  it("Zuordnen löscht die Markierung; eine zugeordnete Zahlung lässt sich nicht zurückstellen", async () => {
    const f = await app();
    const target = (await rest(ctxA)).find((p) => !p.transaction.reversal)!;
    await repo(ctxA).setPostponed(target.id, true);
    const assigned = await f.inject({
      method: "POST",
      url: `/camt/rest/${target.id}/zuordnen`,
      payload: { openItemId: "inv-9" },
    });
    expect(assigned.statusCode).toBe(200);
    const row = await owner.query(
      "SELECT status, zurueckgestellt_am, zurueckgestellt_von FROM camt_zahlung WHERE id = $1",
      [target.id],
    );
    expect(row.rows[0]).toEqual({
      status: "MANUAL",
      zurueckgestellt_am: null,
      zurueckgestellt_von: null,
    });
    const again = await f.inject({
      method: "POST",
      url: `/camt/rest/${target.id}/zurueckstellen`,
      payload: { postponed: true },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("PAYMENT_NOT_REST");
    await f.close();
  });

  it("die Datenbank erlaubt die Markierung nur bei Restposten und nur im eigenen Mandanten", async () => {
    const manual = await owner.query("SELECT id FROM camt_zahlung WHERE status = 'MANUAL' LIMIT 1");
    await expect(
      owner.query("UPDATE camt_zahlung SET zurueckgestellt_am = now() WHERE id = $1", [
        manual.rows[0].id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });

    // Fremder Benutzer (Kunde B) darf nicht als Auslöser bei Kunde A stehen: zusammengesetzter Fremdschlüssel.
    const restId = (await rest(ctxA))[0]!.id;
    await expect(
      owner.query(
        "UPDATE camt_zahlung SET zurueckgestellt_am = now(), zurueckgestellt_von = $2 WHERE id = $1",
        [restId, userB],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
