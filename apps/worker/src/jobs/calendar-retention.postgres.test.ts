import { Datenbank } from "@stammbuch/db";
import { createTestDatabase, withCredentials } from "@stammbuch/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { postgresRetentionPort, purgeEndedEvents } from "./calendar-retention.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const userA = "aaaaaaaa-0000-4000-8000-000000000001";
const userB = "bbbbbbbb-0000-4000-8000-000000000001";
const NOW = new Date("2026-12-03T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const ev = (n: number) => `00000000-0000-4000-8000-0000000000e${n}`;
const inv = (n: number) => `00000000-0000-4000-8000-0000000000a${n}`;

describe("Löschjob gegen PostgreSQL (Rolle stammbuch_worker)", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let owner: pg.Client;
  let db: Datenbank;

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
    // 1, 3: lange vorbei (A, B). 2: vor 23 Stunden zu Ende. 4: läuft noch. 5: vor genau 24 Stunden zu Ende.
    const rows: [number, string, string, number][] = [
      [1, A, userA, 48],
      [2, A, userA, 23],
      [3, B, userB, 30],
      [4, B, userB, -2],
      [5, A, userA, 24],
    ];
    for (const [n, kunde, user, endedHoursAgo] of rows) {
      await owner.query(
        `INSERT INTO kalender_event (id, kunde_id, titel, beginnt_am, endet_am, erstellt_von)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [ev(n), kunde, `Event ${n}`, hoursAgo(endedHoursAgo + 3), hoursAgo(endedHoursAgo), user],
      );
      await owner.query(
        `INSERT INTO kalender_einladung (id, kunde_id, event_id, email, name, token_hash)
         VALUES ($1, $2, $3, 'x@example.test', 'X', decode(repeat($4, 32), 'hex'))`,
        [inv(n), kunde, ev(n), String(n).padStart(2, "0")],
      );
      await owner.query(
        `INSERT INTO kalender_antwort (kunde_id, event_id, einladung_id, status) VALUES ($1, $2, $3, 'accepted')`,
        [kunde, ev(n), inv(n)],
      );
    }
    // Daten, die der Job nie anfassen darf.
    await owner.query(
      `INSERT INTO audit_log (kunde_id, benutzer_id, aktion) VALUES ('${A}', '${userA}', 'bleibt')`,
    );
    db = new Datenbank(
      withCredentials(testDb.adminUrl, "stammbuch_worker", inject("workerPassword")),
    );
  });

  afterAll(async () => {
    await db.close();
    await owner.end();
    await testDb.drop();
  });

  it("löscht beendete Events über alle Kunden und lässt alles andere stehen", async () => {
    const count = async (t: string) =>
      (await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]!.n;
    const before = {
      kunde: await count("kunde"),
      benutzer: await count("benutzer"),
      audit_log: await count("audit_log"),
    };

    const errors: unknown[] = [];
    const deleted = await purgeEndedEvents(postgresRetentionPort(db), NOW, (_id, err) =>
      errors.push(err),
    );

    expect(errors).toEqual([]);
    expect(deleted).toBe(3); // Events 1, 3 und 5 (Ende <= jetzt - 24 h)
    const left = (t: string) => owner.query(`SELECT event_id FROM ${t} ORDER BY event_id`);
    expect((await owner.query("SELECT id FROM kalender_event ORDER BY id")).rows).toEqual([
      { id: ev(2) },
      { id: ev(4) },
    ]);
    expect((await left("kalender_einladung")).rows).toEqual([
      { event_id: ev(2) },
      { event_id: ev(4) },
    ]);
    expect((await left("kalender_antwort")).rows).toEqual([
      { event_id: ev(2) },
      { event_id: ev(4) },
    ]);
    expect({
      kunde: await count("kunde"),
      benutzer: await count("benutzer"),
      audit_log: await count("audit_log"),
    }).toEqual(before);

    // Zweiter Lauf: nichts mehr zu tun.
    expect(await purgeEndedEvents(postgresRetentionPort(db), NOW, () => {})).toBe(0);
  });
});
