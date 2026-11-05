import { readFileSync } from "node:fs";
import { Datenbank } from "@stammbuch/db";
import Fastify from "fastify";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createTestDatabase, withCredentials } from "../../../../../packages/db/test/helpers.js";
import { errorHandler } from "../../lib/errors.js";
import { createPgCamtModule } from "./pg.js";
import { UniquenessError } from "./repository.js";
import type { ImportedPayment, ImportRecord } from "./repository.js";
import { PgCamtRepository } from "./repository.pg.js";
import type { CamtContext } from "./repository.pg.js";
import { CamtImportService } from "./service.js";
import { CamtError } from "./types.js";
import type { CamtTransaction } from "./types.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const userA = "aaaaaaaa-0000-4000-8000-000000000001";
const userB = "bbbbbbbb-0000-4000-8000-000000000001";
const ctxA: CamtContext = { kundeId: A, benutzerId: userA };
const ctxB: CamtContext = { kundeId: B, benutzerId: userB };
const R1 = "000000021000000000000100009";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
/** Gleiche Buchungen, andere Bytes: eine andere Datei mit überlappendem Inhalt. */
const variant = (n: number) =>
  Buffer.concat([fixture("camt053-v04.xml"), Buffer.from(`\n<!-- variante ${n} -->\n`)]);

const k = (c: string) => c.repeat(64);

describe("CAMT mit PostgreSQL", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let owner: pg.Client;
  let db: Datenbank;

  const repo = (ctx: CamtContext) => new PgCamtRepository(db, ctx);
  // Nur R1 hat einen offenen Posten: 1 Treffer, 3 Restposten (NO_OPEN_ITEM, NO_REFERENCE, REVERSAL).
  const service = (ctx: CamtContext) =>
    new CamtImportService(repo(ctx), {
      findByReferences: (refs) =>
        Promise.resolve(
          refs.includes(R1)
            ? [{ id: "inv-1", reference: R1, amountRappen: 12000, currency: "CHF" }]
            : [],
        ),
    });
  const count = async (table: string, kunde = A) =>
    Number(
      (await owner.query(`SELECT count(*) AS n FROM ${table} WHERE kunde_id = $1`, [kunde])).rows[0]
        .n,
    );
  const restItems = async (ctx: CamtContext) =>
    (await repo(ctx).listRestPayments({ limit: 100 })).items;
  const assignable = async (ctx: CamtContext) =>
    (await restItems(ctx)).filter((p) => !p.transaction.reversal);

  beforeAll(async () => {
    testDb = await createTestDatabase(inject("adminUrl"), inject("templateDb"));
    owner = new pg.Client({ connectionString: testDb.adminUrl });
    await owner.connect();
    await owner.query(
      `INSERT INTO kunde (id, name) VALUES ('${A}', 'Kunde A'), ('${B}', 'Kunde B')`,
    );
    await owner.query(
      `INSERT INTO benutzer (id, kunde_id, email, name, passwort_hash) VALUES
        ('${userA}', '${A}', 'a@example.test', 'A', 'x'), ('${userB}', '${B}', 'b@example.test', 'B', 'x')`,
    );
    db = new Datenbank(withCredentials(testDb.adminUrl, "stammbuch_app", inject("appPassword")), {
      max: 10,
    });
  });

  afterAll(async () => {
    await db.close();
    await owner.end();
    await testDb.drop();
  });

  describe("Import", () => {
    it("speichert Import, Zahlungen und Audit-Ereignis; Wiederholung ist ein Duplikat", async () => {
      const r = await service(ctxA).importFile(fixture("camt053-v04.xml"));
      expect(r.import.counts).toMatchObject({ total: 5, matched: 1, rest: 3 });
      expect(await count("camt_import")).toBe(1);
      expect(await count("camt_zahlung")).toBe(4);
      const audit = await owner.query(
        "SELECT benutzer_id FROM audit_log WHERE kunde_id = $1 AND aktion = 'camt.import'",
        [A],
      );
      expect(audit.rows).toEqual([{ benutzer_id: userA }]);

      await expect(service(ctxA).importFile(fixture("camt053-v04.xml"))).rejects.toMatchObject({
        code: "DUPLICATE_FILE",
      });
      expect(await count("camt_zahlung")).toBe(4);

      const known = await repo(ctxA).findImportByFileHash(r.import.fileHash);
      expect(known).toMatchObject({ id: r.import.id, kind: "camt.053", counts: r.import.counts });
    });

    it("überlappender Auszug (andere Datei) bucht dieselben Buchungen nicht doppelt", async () => {
      const r = await service(ctxA).importFile(variant(0));
      expect(r.import.counts).toMatchObject({ matched: 0, rest: 0, duplicates: 4 });
      expect(await count("camt_zahlung")).toBe(4);
    });

    it("parallele Uploads derselben Datei: genau einer gewinnt, keine Doppelbuchung", async () => {
      await owner.query("DELETE FROM camt_import WHERE kunde_id = $1", [A]);
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => service(ctxA).importFile(fixture("camt053-v04.xml"))),
      );
      const failed = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(failed).toHaveLength(5);
      expect(failed.every((e) => e instanceof CamtError && e.code === "DUPLICATE_FILE")).toBe(true);
      expect(await count("camt_import")).toBe(1);
      expect(await count("camt_zahlung")).toBe(4);
    });

    it("parallele Uploads überlappender Dateien: jede Buchung nur einmal", async () => {
      await owner.query("DELETE FROM camt_import WHERE kunde_id = $1", [A]);
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => service(ctxA).importFile(variant(i + 1))),
      );
      const booked = results.reduce(
        (n, r) => n + r.import.counts.matched + r.import.counts.rest,
        0,
      );
      expect(booked).toBe(4);
      expect(await count("camt_zahlung")).toBe(4);
      expect(await count("camt_import")).toBe(6);
    });

    it("saveImport ist atomar: bei verletzter Eindeutigkeit bleibt nichts zurück", async () => {
      await owner.query("DELETE FROM camt_import WHERE kunde_id = $1", [A]);
      const tx: CamtTransaction = {
        accountIban: "CH9300762011623852957",
        bookingDate: "2026-11-01",
        amountRappen: 100,
        currency: "CHF",
        direction: "CREDIT",
        reversal: false,
        ordinal: 0,
      };
      const record = (id: string, fileHash: string): ImportRecord => ({
        id,
        fileHash,
        kind: "camt.054",
        version: "08",
        messageId: "M",
        importedAt: new Date().toISOString(),
        counts: { total: 2, matched: 0, rest: 2, duplicates: 0, ignored: 0 },
      });
      const pay = (id: string, importId: string, key: string): ImportedPayment => ({
        id,
        importId,
        bookingKey: key,
        transaction: tx,
        status: "REST",
        restReason: "NO_REFERENCE",
      });
      const i1 = "00000000-0000-4000-8000-0000000000a1";
      const i2 = "00000000-0000-4000-8000-0000000000a2";
      const p = (n: number) => `00000000-0000-4000-8000-0000000000b${n}`;
      const auditBefore = await count("audit_log");

      // Zweite Zahlung im selben Batch kollidiert: Import und erste Zahlung dürfen nicht bleiben.
      await expect(
        repo(ctxA).saveImport(record(i1, k("1")), [pay(p(1), i1, k("a")), pay(p(2), i1, k("a"))]),
      ).rejects.toBeInstanceOf(UniquenessError);
      expect(await count("camt_import")).toBe(0);
      expect(await count("camt_zahlung")).toBe(0);
      expect(await count("audit_log")).toBe(auditBefore);

      await repo(ctxA).saveImport(record(i1, k("1")), [pay(p(1), i1, k("a"))]);
      await expect(
        repo(ctxA).saveImport(record(i2, k("2")), [pay(p(3), i2, k("b")), pay(p(4), i2, k("a"))]),
      ).rejects.toBeInstanceOf(UniquenessError);
      expect(await count("camt_import")).toBe(1);
      expect(await count("camt_zahlung")).toBe(1);
    });
  });

  describe("Mandantentrennung", () => {
    it("Kunde B sieht nichts von Kunde A und darf dieselbe Datei selbst importieren", async () => {
      await owner.query("DELETE FROM camt_import");
      const a = await service(ctxA).importFile(fixture("camt053-v04.xml"));
      expect(await repo(ctxB).findImportByFileHash(a.import.fileHash)).toBeUndefined();
      expect((await repo(ctxB).listRestPayments({ limit: 10 })).items).toEqual([]);
      const b = await service(ctxB).importFile(fixture("camt053-v04.xml"));
      expect(b.import.counts.duplicates).toBe(0);
      expect(await count("camt_zahlung", B)).toBe(4);
      expect(await count("camt_zahlung", A)).toBe(4);
    });

    it("die Anwendungsrolle ändert Beträge nicht und löscht keine Zahlungen", async () => {
      await expect(
        db.withKunde(A, (t) => sql`UPDATE camt_zahlung SET betrag_rappen = 1`.execute(t)),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        db.withKunde(A, (t) => sql`DELETE FROM camt_zahlung`.execute(t)),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  describe("Routen", () => {
    type Outcome = "ASSIGNED" | "NOT_FOUND" | "NOT_OPEN";
    async function app(assign: () => Outcome = () => "ASSIGNED") {
      const f = Fastify();
      f.setErrorHandler(errorHandler);
      await f.register(async (scope) => {
        await createPgCamtModule({
          db,
          authorize: () => Promise.resolve(),
          // Stellvertreter für die Sitzung aus #4.
          context: (req) => (req.headers["x-test-kunde"] === "B" ? ctxB : ctxA),
          openItems: () => ({ findByReferences: () => Promise.resolve([]) }),
          assigner: () => ({ assign: () => Promise.resolve(assign()) }),
        }).register(scope);
      });
      return f;
    }

    it("GET /camt/rest paginiert per Cursor in fester Reihenfolge", async () => {
      const f = await app();
      const seen: { id: string }[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const res = await f.inject({
          method: "GET",
          url: `/camt/rest?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        seen.push(...body.items);
        cursor = body.nextCursor;
        pages++;
      } while (cursor);
      const expected = await restItems(ctxA);
      expect(seen.map((p) => p.id)).toEqual(expected.map((p) => p.id));
      expect(seen).toHaveLength(3);
      expect(pages).toBe(2);
      expect(seen[0]).not.toHaveProperty("bookingKey");

      const other = await f.inject({
        method: "GET",
        url: "/camt/rest",
        headers: { "x-test-kunde": "B" },
      });
      expect(other.json().items).toHaveLength(3); // B hat die Datei selbst importiert
      expect(other.json().items.map((p: { id: string }) => p.id)).not.toContain(seen[0]?.id);

      for (const bad of ["limit=0", "limit=1000", "cursor=a%20b", "cursor=abc"]) {
        const res = await f.inject({ method: "GET", url: `/camt/rest?${bad}` });
        expect(res.statusCode, bad).toBe(400);
      }
      await f.close();
    });

    it("POST /camt/rest/:id/zuordnen ordnet zu, schreibt Audit und ist nicht wiederholbar", async () => {
      const f = await app();
      const id = (await assignable(ctxA))[0]!.id;
      const res = await f.inject({
        method: "POST",
        url: `/camt/rest/${id}/zuordnen`,
        payload: { openItemId: "inv-9" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id, status: "MANUAL", openItemId: "inv-9" });

      const row = await owner.query(
        "SELECT status, offener_posten_id, zugeordnet_von FROM camt_zahlung WHERE id = $1",
        [id],
      );
      expect(row.rows[0]).toEqual({
        status: "MANUAL",
        offener_posten_id: "inv-9",
        zugeordnet_von: userA,
      });
      const audit = await owner.query(
        "SELECT benutzer_id, objekt_id, details FROM audit_log WHERE aktion = 'camt.zahlung_zugeordnet'",
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({ benutzer_id: userA, objekt_id: id });
      expect(audit.rows[0].details).toMatchObject({ offenerPostenId: "inv-9" });

      const again = await f.inject({
        method: "POST",
        url: `/camt/rest/${id}/zuordnen`,
        payload: { openItemId: "inv-9" },
      });
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe("PAYMENT_NOT_REST");
      expect((await restItems(ctxA)).map((p) => p.id)).not.toContain(id);
      await f.close();
    });

    it("lehnt fremde, unbekannte und ungültige Anfragen ab", async () => {
      const f = await app();
      const target = (await assignable(ctxA))[0]!;
      const post = (url: string, payload: object, headers = {}) =>
        f.inject({ method: "POST", url, payload, headers });
      const url = `/camt/rest/${target.id}/zuordnen`;

      // Die Zahlung gehört Kunde A: für B existiert sie nicht.
      const foreign = await post(url, { openItemId: "x" }, { "x-test-kunde": "B" });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json().error.code).toBe("PAYMENT_NOT_FOUND");

      const missing = "/camt/rest/00000000-0000-4000-8000-00000000ffff/zuordnen";
      expect((await post(missing, { openItemId: "x" })).statusCode).toBe(404);
      expect((await post("/camt/rest/keine-uuid/zuordnen", { openItemId: "x" })).statusCode).toBe(
        400,
      );
      expect((await post(url, {})).statusCode).toBe(400);
      expect((await post(url, { openItemId: "" })).statusCode).toBe(400);
      expect((await post(url, { openItemId: "x".repeat(101) })).statusCode).toBe(400);

      const reversal = (await restItems(ctxA)).find((p) => p.transaction.reversal)!;
      const rev = await post(`/camt/rest/${reversal.id}/zuordnen`, { openItemId: "x" });
      expect(rev.statusCode).toBe(409);
      expect(rev.json().error.code).toBe("PAYMENT_NOT_ASSIGNABLE");
      await f.close();
    });

    it("Posten nicht gefunden oder nicht offen: Zahlung bleibt Restposten, kein Audit", async () => {
      const auditBefore = await count("audit_log");
      const target = (await assignable(ctxA))[0]!;
      for (const [outcome, status, code] of [
        ["NOT_FOUND", 404, "OPEN_ITEM_NOT_FOUND"],
        ["NOT_OPEN", 409, "OPEN_ITEM_NOT_OPEN"],
      ] as const) {
        const f = await app(() => outcome);
        const res = await f.inject({
          method: "POST",
          url: `/camt/rest/${target.id}/zuordnen`,
          payload: { openItemId: "inv-x" },
        });
        expect(res.statusCode).toBe(status);
        expect(res.json().error.code).toBe(code);
        expect((await restItems(ctxA)).map((p) => p.id)).toContain(target.id);
        await f.close();
      }
      expect(await count("audit_log")).toBe(auditBefore);
    });

    it("gleichzeitige Zuordnung derselben Zahlung gelingt genau einmal", async () => {
      let booked = 0;
      const f = await app(() => {
        booked++;
        return "ASSIGNED";
      });
      const target = (await assignable(ctxA))[0]!;
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          f.inject({
            method: "POST",
            url: `/camt/rest/${target.id}/zuordnen`,
            payload: { openItemId: "inv-7" },
          }),
        ),
      );
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 409)).toHaveLength(4);
      expect(booked).toBe(1);
      await f.close();
    });
  });
});
