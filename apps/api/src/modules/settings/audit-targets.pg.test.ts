import { Datenbank } from "@stammbuch/db";
import { createTestDatabase, withCredentials } from "@stammbuch/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { AuditEntry } from "../../platform/index.js";
import { resolveTargets } from "./audit-targets.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const userA = "aaaaaaaa-0000-4000-8000-000000000001";
const userB = "bbbbbbbb-0000-4000-8000-000000000001";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MISSING = id(99);

const entry = (action: string, target: string): AuditEntry => ({
  id: "1",
  at: "2026-11-09T10:00:00.000Z",
  actorId: userA,
  actor: "a@example.test",
  action,
  target,
});

describe("Objekt im Protokoll auflösen (echte Datenbank)", () => {
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
    await owner.query(
      `INSERT INTO mitglied (kunde_id, id, typ, vorname, nachname) VALUES
        ('${A}', '${id(1)}', 'einzel', 'Anna', 'Muster'),
        ('${B}', '${id(2)}', 'einzel', 'Fremd', 'Person')`,
    );
    await owner.query(
      `INSERT INTO firma (kunde_id, id, name, strasse, plz, ort, status) VALUES
        ('${A}', '${id(3)}', 'Muster AG', 'Weg 1', '8000', 'Zürich', 'freigegeben')`,
    );
    await owner.query(
      `INSERT INTO gruppe (kunde_id, id, name) VALUES ('${A}', '${id(4)}', 'Vorstand')`,
    );
    await owner.query(
      `INSERT INTO aufgabe (kunde_id, id, titel, faellig_am, erstellt_von)
       VALUES ('${A}', '${id(5)}', 'Mitgliederliste prüfen', '2026-11-30', '${userA}')`,
    );
    await owner.query(
      `INSERT INTO rechnung (kunde_id, id, art, status, nummer, laufnummer, debitor, waehrung, rechnungsdatum,
                             faelligkeitsdatum, mwst_modus, runden_5, betreff, notizen, netto_rappen, mwst_rappen,
                             brutto_rappen, rundung_rappen, total_rappen, mwst_saetze, versendet_am, erstellt_am,
                             geaendert_am, version)
       VALUES ('${A}', '${id(6)}', 'rechnung', 'versendet', 'RE-2026-0001', 1, '{}'::jsonb, 'CHF', '2026-11-01',
               '2026-12-01', 'ohne', false, 'Beitrag', '', 100, 0, 100, 0, 100, '[]'::jsonb, now(), now(), now(), 1)`,
    );
    db = new Datenbank(withCredentials(testDb.adminUrl, "stammbuch_app", inject("appPassword")), {
      max: 1,
    });
  });

  afterAll(async () => {
    await db.close();
    await owner.end();
    await testDb.drop();
  });

  it("zeigt Mitgliedsnummer mit Name, Firma, Gruppe und Aufgabentitel statt der ID", async () => {
    const out = await resolveTargets(db, A, [
      entry("mitglied.aendern", id(1)),
      entry("gruppe.zuweisen", id(1)),
      entry("firma.anlegen", id(3)),
      entry("gruppe.anlegen", id(4)),
      entry("aufgabe.erledigen", id(5)),
      entry("invoice.send", id(6)),
    ]);
    expect(out.map((e) => e.target)).toEqual([
      expect.stringMatching(/^M-\d+ Anna Muster$/),
      expect.stringMatching(/^M-\d+ Anna Muster$/),
      "Muster AG",
      "Vorstand",
      "Mitgliederliste prüfen",
      "RE-2026-0001",
    ]);
  });

  it("löst nichts aus fremden Mandanten oder gelöschten Objekten auf, nie eine rohe ID", async () => {
    const out = await resolveTargets(db, A, [
      entry("mitglied.aendern", id(2)), // gehört Mandant B
      entry("aufgabe.erledigen", MISSING),
      entry("mail.send", id(1)), // Aktion ohne Objektart
    ]);
    expect(out.map((e) => e.target)).toEqual(["", "", ""]);
  });
});
