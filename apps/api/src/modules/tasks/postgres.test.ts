import { Datenbank } from "@stammbuch/db";
import { createTestDatabase, withCredentials } from "@stammbuch/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { PostgresTaskStore, type Task } from "./store.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const userA = "aaaaaaaa-0000-4000-8000-000000000001";
const userB = "bbbbbbbb-0000-4000-8000-000000000001";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const task = (n: number, due: string, tenantId = A, createdBy = userA): Task => ({
  id: uuid(n),
  tenantId,
  title: `Aufgabe ${n}`,
  due,
  createdBy,
});

describe("PostgresTaskStore (echte Datenbank)", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let owner: pg.Client;
  let db: Datenbank;
  let store: PostgresTaskStore;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject("adminUrl"), inject("templateDb"));
    owner = new pg.Client({ connectionString: testDb.adminUrl });
    await owner.connect();
    await owner.query(`INSERT INTO kunde (id, name) VALUES ('${A}', 'A'), ('${B}', 'B')`);
    await owner.query(
      `INSERT INTO benutzer (id, kunde_id, email, name, passwort_hash) VALUES
        ('${userA}', '${A}', 'a@example.test', 'A', 'h'),
        ('${userB}', '${B}', 'b@example.test', 'B', 'h')`,
    );
    db = new Datenbank(withCredentials(testDb.adminUrl, "stammbuch_app", inject("appPassword")), {
      max: 1,
    });
    store = new PostgresTaskStore(db);
  });

  afterAll(async () => {
    await db.close();
    await owner.end();
    await testDb.drop();
  });

  it("legt an, listet offene nach Fälligkeit und zählt Gesamtzahl und fällige", async () => {
    await store.create(task(1, "2026-11-30"));
    await store.create(task(2, "2026-11-04"));
    await store.create(task(3, "2026-11-01"));
    await store.create(task(4, "2026-11-04", B, userB));

    const all = await store.listOpen(A, "2026-11-04", 10);
    expect(all.items.map((t) => t.id)).toEqual([uuid(3), uuid(2), uuid(1)]);
    expect(all.items[0]).toMatchObject({ tenantId: A, title: "Aufgabe 3", due: "2026-11-01" });
    expect([all.total, all.dueCount]).toEqual([3, 2]);

    const limited = await store.listOpen(A, "2026-11-04", 1);
    expect(limited.items).toHaveLength(1);
    expect([limited.total, limited.dueCount]).toEqual([3, 2]);
  });

  it("erledigt nur offene Aufgaben des eigenen Mandanten", async () => {
    expect(await store.complete(B, uuid(1), new Date())).toBe(false); // fremder Mandant
    expect((await store.listOpen(A, "2026-11-04", 10)).total).toBe(3);
    expect(await store.complete(A, uuid(3), new Date())).toBe(true);
    expect(await store.complete(A, uuid(3), new Date())).toBe(false); // schon erledigt
    expect(await store.complete(A, uuid(99), new Date())).toBe(false);
    const open = await store.listOpen(A, "2026-11-04", 10);
    expect(open.items.map((t) => t.id)).toEqual([uuid(2), uuid(1)]);
    expect([open.total, open.dueCount]).toEqual([2, 1]);
    const { rows } = await owner.query("SELECT erledigt_am FROM aufgabe WHERE id = $1", [uuid(3)]);
    expect(rows[0].erledigt_am).toBeInstanceOf(Date);
  });

  it("listet erledigte Aufgaben, zuletzt erledigte zuerst, nur des eigenen Mandanten", async () => {
    expect(await store.complete(A, uuid(1), new Date(Date.now() + 60_000))).toBe(true);
    const done = await store.listDone(A, 10);
    expect(done.items.map((t) => t.id)).toEqual([uuid(1), uuid(3)]);
    expect(done.items[0]).toMatchObject({ tenantId: A, title: "Aufgabe 1", due: "2026-11-30" });
    expect(done.items[0]?.doneAt).toBeInstanceOf(Date);
    expect(done.total).toBe(2);
    expect((await store.listDone(A, 1)).items).toHaveLength(1);
    expect(await store.listDone(B, 10)).toEqual({ items: [], total: 0 });
  });

  it("Mandantentrennung per RLS: ohne Mandant nichts, nichts für einen fremden Mandanten, kein Löschen", async () => {
    expect(await db.kysely.selectFrom("aufgabe").selectAll().execute()).toEqual([]);
    const own = await db.withKunde(B, (t) => t.selectFrom("aufgabe").select("id").execute());
    expect(own.map((r) => r.id)).toEqual([uuid(4)]);

    // Aufgabe für Mandant B unter Mandant A anlegen: Richtlinie verletzt.
    await expect(
      db.withKunde(A, (t) =>
        t
          .insertInto("aufgabe")
          .values({ kunde_id: B, titel: "x", faellig_am: "2026-11-04", erstellt_von: userB })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // Benutzer eines anderen Mandanten als Ersteller: zusammengesetzter Fremdschlüssel.
    await expect(store.create(task(6, "2026-11-04", A, userB))).rejects.toMatchObject({
      code: "23503",
    });
    // Löschen und Ändern anderer Spalten als der Erledigung ist der Anwendungsrolle verwehrt.
    await expect(
      db.withKunde(A, (t) => t.deleteFrom("aufgabe").where("id", "=", uuid(1)).execute()),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      db.withKunde(A, (t) =>
        t.updateTable("aufgabe").set({ titel: "umbenannt" }).where("id", "=", uuid(1)).execute(),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("lehnt Titel und Fälligkeit ausserhalb der Grenzen ab (CHECK)", async () => {
    await expect(store.create({ ...task(7, "2026-11-04"), title: "" })).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      store.create({ ...task(8, "2026-11-04"), title: "x".repeat(201) }),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
