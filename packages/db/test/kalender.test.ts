import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { Datenbank } from "../src/index.js";
import { createTestDatabase, withCredentials } from "./helpers.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const benutzerA = "aaaaaaaa-0000-4000-8000-000000000001";
const benutzerB = "bbbbbbbb-0000-4000-8000-000000000001";
const eventA = "aaaaaaaa-0000-4000-8000-0000000000e1";
const eventB = "bbbbbbbb-0000-4000-8000-0000000000e1";
const eventNeu = "aaaaaaaa-0000-4000-8000-0000000000e2";
const einladungA = "aaaaaaaa-0000-4000-8000-0000000000a1";
const einladungB = "bbbbbbbb-0000-4000-8000-0000000000a1";
const einladungB2 = "bbbbbbbb-0000-4000-8000-0000000000a2"; // ohne Antwort
const hash = (s: string) => createHash("sha256").update(s).digest();

const rls = { code: "42501" };
const fk = { code: "23503" };

const tabellen = [
  "kunde",
  "benutzer",
  "sitzung",
  "audit_log",
  "kalender_event",
  "kalender_einladung",
  "kalender_antwort",
];

describe("Kalender: Mandantentrennung und Aufräumen", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let owner: pg.Client;
  let db: Datenbank;
  let worker: Datenbank;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject("adminUrl"), inject("templateDb"));
    owner = new pg.Client({ connectionString: testDb.adminUrl });
    await owner.connect();
    await owner.query(`INSERT INTO kunde (id, name) VALUES ('${A}', 'A'), ('${B}', 'B')`);
    await owner.query(
      `INSERT INTO benutzer (id, kunde_id, email, name, passwort_hash) VALUES
        ('${benutzerA}', '${A}', 'a@example.test', 'A', 'h'),
        ('${benutzerB}', '${B}', 'b@example.test', 'B', 'h')`,
    );
    // Event A ist beendet, Event B läuft noch.
    await owner.query(
      `INSERT INTO kalender_event (id, kunde_id, titel, beginnt_am, endet_am, erstellt_von) VALUES
        ('${eventA}', '${A}', 'Alt', now() - interval '3 days', now() - interval '2 days', '${benutzerA}'),
        ('${eventB}', '${B}', 'Neu', now() + interval '1 day', now() + interval '2 days', '${benutzerB}')`,
    );
    await owner.query(
      `INSERT INTO kalender_einladung (id, kunde_id, event_id, email, name, token_hash) VALUES
        ('${einladungA}', '${A}', '${eventA}', 'x@example.test', 'X', $1),
        ('${einladungB}', '${B}', '${eventB}', 'y@example.test', 'Y', $2),
        ('${einladungB2}', '${B}', '${eventB}', 'w@example.test', 'W', $3)`,
      [hash("token-a"), hash("token-b"), hash("token-b2")],
    );
    await owner.query(
      `INSERT INTO kalender_antwort (kunde_id, event_id, einladung_id, status) VALUES
        ('${A}', '${eventA}', '${einladungA}', 'accepted'),
        ('${B}', '${eventB}', '${einladungB}', 'declined')`,
    );
    await owner.query(
      `INSERT INTO audit_log (kunde_id, benutzer_id, aktion) VALUES ('${A}', '${benutzerA}', 'bleibt')`,
    );
    db = new Datenbank(withCredentials(testDb.adminUrl, "stammbuch_app", inject("appPassword")), {
      max: 1,
    });
    worker = new Datenbank(
      withCredentials(testDb.adminUrl, "stammbuch_worker", inject("workerPassword")),
      { max: 1 },
    );
  });

  afterAll(async () => {
    await db.close();
    await worker.close();
    await owner.end();
    await testDb.drop();
  });

  it("jeder Kunde sieht nur die eigenen Kalenderzeilen; ohne Mandant nichts", async () => {
    const lies = (kunde: string) =>
      db.withKunde(kunde, (t) =>
        Promise.all([
          t.selectFrom("kalender_event").select("id").execute(),
          t.selectFrom("kalender_einladung").select("id").execute(),
          t.selectFrom("kalender_antwort").select("kunde_id").execute(),
        ]),
      );
    const [ev, ein, ant] = await lies(A);
    expect([ev.map((r) => r.id), ein.map((r) => r.id), ant.map((r) => r.kunde_id)]).toEqual([
      [eventA],
      [einladungA],
      [A],
    ]);
    expect((await lies(B))[0]!.map((r) => r.id)).toEqual([eventB]);
    expect(await db.kysely.selectFrom("kalender_event").selectAll().execute()).toEqual([]);
    expect(await db.kysely.selectFrom("kalender_einladung").selectAll().execute()).toEqual([]);
    expect(await db.kysely.selectFrom("kalender_antwort").selectAll().execute()).toEqual([]);
  });

  it("Kunde A kann nichts für Kunde B anlegen oder an fremde Zeilen hängen", async () => {
    const neuerEvent = (kunde_id: string, erstellt_von: string) =>
      db.withKunde(A, (t) =>
        t
          .insertInto("kalender_event")
          .values({
            kunde_id,
            erstellt_von,
            titel: "X",
            beginnt_am: new Date(Date.now() + 1000),
            endet_am: new Date(Date.now() + 5000),
            geaendert_am: new Date(),
          })
          .execute(),
      );
    await expect(neuerEvent(B, benutzerB)).rejects.toMatchObject(rls);
    // Eigener Mandant, aber Benutzer von B: zusammengesetzter Fremdschlüssel.
    await expect(neuerEvent(A, benutzerB)).rejects.toMatchObject(fk);

    const einladung = (kunde_id: string, event_id: string) =>
      db.withKunde(A, (t) =>
        t
          .insertInto("kalender_einladung")
          .values({ kunde_id, event_id, email: "z@example.test", name: "Z", token_hash: hash("z") })
          .execute(),
      );
    await expect(einladung(B, eventB)).rejects.toMatchObject(rls);
    await expect(einladung(A, eventB)).rejects.toMatchObject(fk);

    await expect(
      db.withKunde(A, (t) =>
        t
          .insertInto("kalender_antwort")
          .values({
            kunde_id: A,
            event_id: eventA,
            einladung_id: einladungB2,
            status: "accepted",
            geantwortet_am: new Date(),
          })
          .execute(),
      ),
    ).rejects.toMatchObject(fk);
  });

  it("A ändert fremde Events nicht; die Anwendungsrolle löscht Events nicht selbst", async () => {
    const upd = await db.withKunde(A, (t) =>
      t
        .updateTable("kalender_event")
        .set({ titel: "gehackt" })
        .where("id", "=", eventB)
        .executeTakeFirst(),
    );
    expect(upd.numUpdatedRows).toBe(0n);
    await expect(
      db.withKunde(A, (t) => t.deleteFrom("kalender_event").where("id", "=", eventA).execute()),
    ).rejects.toMatchObject(rls);
  });

  it("Token-Auflösung ohne Mandant liefert genau die Einladung, sonst nichts", async () => {
    expect(await db.loeseKalenderEinladungAuf(hash("token-b"))).toMatchObject({
      id: einladungB,
      kunde_id: B,
      event_id: eventB,
    });
    expect(await db.loeseKalenderEinladungAuf(hash("unbekannt"))).toBeUndefined();
    const spalten = Object.keys((await db.loeseKalenderEinladungAuf(hash("token-a")))!);
    expect(spalten.sort()).toEqual(["email", "erstellt_am", "event_id", "id", "kunde_id", "name"]);
  });

  it("die Worker-Rolle hat keinen Tabellenzugriff, die Anwendungsrolle keine Aufräumfunktionen", async () => {
    for (const t of tabellen) {
      await expect(
        worker.kysely
          .selectFrom(t as "kunde")
          .selectAll()
          .execute(),
      ).rejects.toMatchObject(rls);
    }
    await expect(db.findeAbgelaufeneKalenderEvents(new Date())).rejects.toMatchObject(rls);
    await expect(db.loescheKalenderEvent(eventB)).rejects.toMatchObject(rls);
    await expect(worker.loeseKalenderEinladungAuf(hash("token-a"))).rejects.toMatchObject(rls);
  });

  it("Aufräumen findet beendete Events über alle Kunden und löscht nur Event, Einladungen, Antworten", async () => {
    const ids = await worker.findeAbgelaufeneKalenderEvents(new Date(Date.now() - 86_400_000));
    expect(ids).toEqual([eventA]);

    const zaehle = async () => {
      const out: Record<string, number> = {};
      for (const t of tabellen) {
        out[t] = (await owner.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
      }
      return out;
    };
    const vorher = await zaehle();
    await worker.loescheKalenderEvent(eventA);
    const nachher = await zaehle();

    expect(nachher).toEqual({
      ...vorher,
      kalender_event: vorher["kalender_event"]! - 1,
      kalender_einladung: vorher["kalender_einladung"]! - 1,
      kalender_antwort: vorher["kalender_antwort"]! - 1,
    });
    // Das andere Event samt Einladung und Antwort ist unberührt.
    const { rows } = await owner.query("SELECT id FROM kalender_event");
    expect(rows).toEqual([{ id: eventB }]);
    // Unbekannte und bereits gelöschte IDs sind harmlos.
    await worker.loescheKalenderEvent(eventA);
    await worker.loescheKalenderEvent(eventNeu);
  });
});
