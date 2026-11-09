import { createHash } from "node:crypto";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { Datenbank } from "../src/index.js";
import { createTestDatabase, withCredentials } from "./helpers.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const benutzerA = "aaaaaaaa-0000-4000-8000-000000000001";
const benutzerB = "bbbbbbbb-0000-4000-8000-000000000001";
const hash = (s: string) => createHash("sha256").update(s).digest();

const rls = { code: "42501" }; // Zeile verletzt Richtlinie bzw. Berechtigung verweigert
const fk = { code: "23503" };

describe("Mandantentrennung (RLS)", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let owner: pg.Client;
  let db: Datenbank;
  let appUrl: string;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject("adminUrl"), inject("templateDb"));
    appUrl = withCredentials(testDb.adminUrl, "stammbuch_app", inject("appPassword"));
    owner = new pg.Client({ connectionString: testDb.adminUrl });
    await owner.connect();
    // Fixtures als Eigentümer; die Tests selbst laufen alle als Anwendungsrolle.
    await owner.query(
      `INSERT INTO kunde (id, name) VALUES ('${A}', 'Kunde A'), ('${B}', 'Kunde B')`,
    );
    await owner.query(
      `INSERT INTO benutzer (id, kunde_id, email, name, passwort_hash) VALUES
        ('${benutzerA}', '${A}', 'a@example.test', 'Benutzer A', 'hash-a'),
        ('${benutzerB}', '${B}', 'b@example.test', 'Benutzer B', 'hash-b')`,
    );
    await owner.query(
      `INSERT INTO sitzung (kunde_id, benutzer_id, token_hash, laeuft_ab_am, phase, csrf_token) VALUES
        ('${A}', '${benutzerA}', $1, now() + interval '1 hour', 'full', 'csrf'),
        ('${B}', '${benutzerB}', $2, now() + interval '1 hour', 'full', 'csrf')`,
      [hash("token-a"), hash("token-b")],
    );
    await owner.query(
      `INSERT INTO audit_log (kunde_id, benutzer_id, aktion) VALUES
        ('${A}', '${benutzerA}', 'anmeldung'), ('${B}', '${benutzerB}', 'anmeldung')`,
    );
    db = new Datenbank(appUrl, { max: 1 });
  });

  afterAll(async () => {
    await db.close();
    await owner.end();
    await testDb.drop();
  });

  describe("Lesen", () => {
    it("Kunde A sieht in jeder Tabelle nur die eigenen Zeilen", async () => {
      const [kunden, benutzer, sitzungen, audit] = await db.withKunde(A, (t) =>
        Promise.all([
          t.selectFrom("kunde").selectAll().execute(),
          t.selectFrom("benutzer").selectAll().execute(),
          t.selectFrom("sitzung").selectAll().execute(),
          t.selectFrom("audit_log").selectAll().execute(),
        ]),
      );
      expect(kunden.map((r) => r.id)).toEqual([A]);
      expect(benutzer.map((r) => r.id)).toEqual([benutzerA]);
      expect(sitzungen.map((r) => r.kunde_id)).toEqual([A]);
      expect(audit.map((r) => r.kunde_id)).toEqual([A]);
    });

    it("liest fremde Zeilen auch bei gezielter Abfrage nach Kunden-ID oder ID nicht", async () => {
      const rows = await db.withKunde(A, (t) =>
        t
          .selectFrom("benutzer")
          .selectAll()
          .where((eb) => eb.or([eb("kunde_id", "=", B), eb("id", "=", benutzerB)]))
          .execute(),
      );
      expect(rows).toEqual([]);
    });

    it("ohne Mandant liefern alle Tabellen nichts (fail secure)", async () => {
      for (const table of ["kunde", "benutzer", "sitzung", "audit_log"] as const) {
        expect(await db.kysely.selectFrom(table).selectAll().execute()).toEqual([]);
      }
    });

    it("der Mandant gilt nur für eine Transaktion und bleibt nicht an der Verbindung hängen", async () => {
      await db.withKunde(A, (t) => t.selectFrom("benutzer").selectAll().execute());
      // Pool mit genau einer Verbindung: dieselbe Verbindung wie eben.
      expect(await db.kysely.selectFrom("benutzer").selectAll().execute()).toEqual([]);
    });

    it("lehnt eine Kunden-ID ab, die keine UUID ist", () => {
      expect(() => db.withKunde("x' OR '1'='1", async () => 1)).toThrow("Ungültige Kunden-ID");
    });
  });

  describe("Schreiben", () => {
    it("Kunde A kann keinen Benutzer für Kunde B anlegen", async () => {
      await expect(
        db.withKunde(A, (t) =>
          t
            .insertInto("benutzer")
            .values({ kunde_id: B, email: "x@example.test", name: "X", passwort_hash: "h" })
            .execute(),
        ),
      ).rejects.toMatchObject(rls);
    });

    it("Kunde A ändert und löscht keine Zeilen von Kunde B", async () => {
      const upd = await db.withKunde(A, (t) =>
        t.updateTable("benutzer").set({ name: "gehackt" }).where("id", "=", benutzerB).executeTakeFirst(),
      ); // prettier-ignore
      const del = await db.withKunde(A, (t) =>
        t.deleteFrom("benutzer").where("id", "=", benutzerB).executeTakeFirst(),
      );
      const updKunde = await db.withKunde(A, (t) =>
        t.updateTable("kunde").set({ name: "gehackt" }).where("id", "=", B).executeTakeFirst(),
      );
      expect([upd.numUpdatedRows, del.numDeletedRows, updKunde.numUpdatedRows]).toEqual([
        0n,
        0n,
        0n,
      ]);
      const { rows } = await owner.query("SELECT name FROM benutzer WHERE id = $1", [benutzerB]);
      expect(rows).toEqual([{ name: "Benutzer B" }]);
    });

    it("Kunde A kann eine eigene Zeile nicht zu Kunde B verschieben", async () => {
      await expect(
        db.withKunde(A, (t) =>
          t.updateTable("benutzer").set({ kunde_id: B }).where("id", "=", benutzerA).execute(),
        ),
      ).rejects.toMatchObject(rls);
    });

    it("Kunde A kann eine Sitzung nicht für Kunde B oder einen Benutzer von B anlegen", async () => {
      const neu = (kunde_id: string, benutzer_id: string) =>
        db.withKunde(A, (t) =>
          t
            .insertInto("sitzung")
            .values({
              kunde_id,
              benutzer_id,
              token_hash: hash(`${kunde_id}${benutzer_id}`),
              laeuft_ab_am: new Date(Date.now() + 3_600_000),
              phase: "full",
              csrf_token: "csrf",
              zuletzt_gesehen_am: new Date(),
              totp_pending_enc: null,
            })
            .execute(),
        );
      await expect(neu(B, benutzerB)).rejects.toMatchObject(rls);
      // Eigener Mandant, aber fremder Benutzer: der zusammengesetzte Fremdschlüssel verhindert es.
      await expect(neu(A, benutzerB)).rejects.toMatchObject(fk);
    });

    it("Audit-Log: Anhängen nur für den eigenen Kunden, kein Ändern, kein Löschen", async () => {
      const eintrag = (kunde_id: string) =>
        db.withKunde(A, (t) =>
          t.insertInto("audit_log").values({ kunde_id, aktion: "test" }).execute(),
        );
      await eintrag(A);
      await expect(eintrag(B)).rejects.toMatchObject(rls);
      await expect(
        db.withKunde(A, (t) => t.updateTable("audit_log").set({ aktion: "x" }).execute()),
      ).rejects.toMatchObject(rls);
      await expect(
        db.withKunde(A, (t) => t.deleteFrom("audit_log").execute()),
      ).rejects.toMatchObject(rls);
    });

    it("die Anwendungsrolle legt keine Kunden an und löscht keine", async () => {
      await expect(
        db.withKunde(A, (t) => t.insertInto("kunde").values({ name: "Neu" }).execute()),
      ).rejects.toMatchObject(rls);
      await expect(db.withKunde(A, (t) => t.deleteFrom("kunde").execute())).rejects.toMatchObject(
        rls,
      );
    });
  });

  describe("Anmeldefunktionen (ohne Mandant)", () => {
    it("finden genau einen Benutzer per E-Mail, unabhängig von der Schreibweise", async () => {
      const b = await db.findeBenutzerFuerAnmeldung("B@Example.test");
      expect(b).toMatchObject({ id: benutzerB, kunde_id: B, passwort_hash: "hash-b" });
      expect(await db.findeBenutzerFuerAnmeldung("unbekannt@example.test")).toBeUndefined();
    });

    it("lösen nur gültige Sitzungen auf", async () => {
      expect(await db.loeseSitzungAuf(hash("token-a"))).toMatchObject({
        kunde_id: A,
        benutzer_id: benutzerA,
      });
      expect(await db.loeseSitzungAuf(hash("unbekannt"))).toBeUndefined();

      await owner.query("UPDATE sitzung SET widerrufen_am = now() WHERE token_hash = $1", [
        hash("token-b"),
      ]);
      expect(await db.loeseSitzungAuf(hash("token-b"))).toBeUndefined();

      await owner.query(
        "INSERT INTO sitzung (kunde_id, benutzer_id, token_hash, erstellt_am, laeuft_ab_am, phase, csrf_token) VALUES ($1, $2, $3, now() - interval '2 hours', now() - interval '1 hour', 'full', 'csrf')",
        [A, benutzerA, hash("abgelaufen")],
      ); // prettier-ignore
      expect(await db.loeseSitzungAuf(hash("abgelaufen"))).toBeUndefined();
    });

    it("geben keine Daten über Tabellen heraus, nur über ihre festen Spalten", async () => {
      const spalten = Object.keys((await db.findeBenutzerFuerAnmeldung("a@example.test"))!);
      expect(spalten.sort()).toEqual(["aktiv", "id", "kunde_id", "passwort_hash"]);
    });
  });

  describe("Anwendungsrolle und Schema-Regeln", () => {
    it("hat weder Superuser- noch BYPASSRLS-Rechte und darf nichts anlegen", async () => {
      const { rows } = await owner.query(
        "SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'stammbuch_app'",
      );
      expect(rows).toEqual([
        { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false },
      ]);

      await expect(
        db.withKunde(A, (t) => sql`CREATE TABLE evil (id int)`.execute(t)),
      ).rejects.toMatchObject(rls);
    });

    it("Setzen von row_security = off gibt keine fremden Zeilen frei", async () => {
      const c = new pg.Client({ connectionString: appUrl });
      await c.connect();
      try {
        await c.query("SET app.kunde_id = '" + A + "'");
        await c.query("SET row_security = off");
        // Mit row_security = off meldet Postgres einen Fehler statt Zeilen zu liefern, wenn RLS greifen würde.
        await expect(c.query("SELECT * FROM benutzer")).rejects.toMatchObject(rls);
      } finally {
        await c.end();
      }
    });

    it("kann die Migrationstabelle nicht lesen", async () => {
      await expect(
        db.withKunde(A, (t) => sql`SELECT * FROM schema_migrations`.execute(t)),
      ).rejects.toMatchObject(rls);
    });

    it("nur die erwarteten SECURITY-DEFINER-Funktionen führen an RLS vorbei", async () => {
      const { rows } = await owner.query<{ proname: string }>(
        `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND prosecdef ORDER BY 1`,
      );
      // Neue Funktion hier nur mit Begründung in der Migration und im README (Abschnitt "Wege an RLS vorbei").
      expect(rows.map((r) => r.proname)).toEqual([
        "auth_aufraeumen",
        "auth_ereignis_anhaengen",
        "auth_sperre_lesen",
        "auth_sperre_loeschen",
        "auth_sperre_setzen",
        "auth_sperre_sichern",
        "benutzer_fuer_anmeldung",
        "benutzer_fuer_mfa_reset",
        "chef_anmeldungen",
        "chef_konto",
        "chef_konto_aendern",
        "chef_sicherheit",
        "chef_sitzung_beenden",
        "chef_sitzungen",
        "einladung_annehmen",
        "einladung_einloesen",
        "einladung_fehlversuch",
        "einladung_pruefen",
        "kalender_abgelaufene_events",
        "kalender_einladung_aufloesen",
        "kalender_event_loeschen",
        "kunde_aendern",
        "kunde_anlegen",
        "kunde_anlegen", // zweite Signatur mit Lizenzbeginn und Modulen (Migration 202611092115)
        "kunde_benutzer_fuer_chef",
        "kunde_id_fuer_slug",
        "kunden_auflisten",
        "kunden_vertrag",
        "mail_anhang_fuer_worker",
        "mail_gesendet_seit",
        "mail_kampagne_fuer_worker",
        "mail_konten_zur_rotation",
        "mail_konten_zur_rotation_chef",
        "mail_konto_fuer_worker",
        "mail_konto_geheimnis_ersetzen",
        "mail_konto_geheimnis_ersetzen_chef",
        "mail_zustellung_abschliessen",
        "mail_zustellung_uebernehmen",
        "mail_zustellungen_faellig",
        "passwort_reset_anlegen",
        "passwort_reset_einloesen",
        "passwort_reset_pruefen",
        "plattform_protokoll_anhaengen",
        "plattform_protokoll_lesen",
        "plattform_protokoll_vom_worker",
        "registrierung_einloesen",
        "rotation_stand_festhalten",
        "rotation_stand_festhalten_chef",
        "rotation_stand_lesen",
        "sitzung_aufloesen",
        "totp_geheimnis_ersetzen",
        "totp_geheimnis_ersetzen_chef",
        "totp_zur_rotation",
        "totp_zur_rotation_chef",
      ]);
    });

    // Begründete Ausnahmen vom Mandantenbezug: Zähler und Ereignisse, die vor der Mandantenwahl gebraucht werden
    // (Migration 202611041103), das Protokoll des Chef-Admins, das keinem Kunden gehört (Migration 202611041801),
    // und der Stand der Schlüsselrotation, der alle Kunden betrifft (Migration 202611051300).
    // Neue Einträge hier nur mit Begründung im PR.
    const ohneMandant = [
      "auth_sperre",
      "auth_ereignis",
      "plattform_protokoll",
      "schluesselrotation_stand",
    ];

    it("jede Tabelle hat kunde_id (oder ist kunde, oder eine begründete Ausnahme) und aktive RLS; Geldspalten sind nie Fliesskomma", async () => {
      const { rows: tabellen } = await owner.query<{ tablename: string; rowsecurity: boolean; hat_kunde_id: boolean }>(`
        SELECT t.tablename, c.relrowsecurity AS rowsecurity,
               EXISTS (SELECT FROM information_schema.columns i
                       WHERE i.table_schema = 'public' AND i.table_name = t.tablename AND i.column_name = 'kunde_id') AS hat_kunde_id
        FROM pg_tables t JOIN pg_class c ON c.oid = format('public.%I', t.tablename)::regclass
        WHERE t.schemaname = 'public' AND t.tablename <> 'schema_migrations'
      `); // prettier-ignore
      expect(tabellen.length).toBeGreaterThanOrEqual(7);
      expect(tabellen.filter((t) => !t.rowsecurity).map((t) => t.tablename)).toEqual([]);
      expect(
        tabellen
          .filter((t) => !t.hat_kunde_id && t.tablename !== "kunde" && !ohneMandant.includes(t.tablename))
          .map((t) => t.tablename),
      ).toEqual([]);
      // Die Ausnahmen sind wirklich gesperrt: keine Richtlinie, keine Tabellenrechte für die Anwendungsrolle.
      const { rows: offen } = await owner.query(
        `SELECT 'policy' AS art, tablename FROM pg_policies WHERE tablename = ANY($1)
         UNION ALL
         SELECT 'grant', table_name FROM information_schema.role_table_grants
         WHERE grantee = 'stammbuch_app' AND table_name = ANY($1)`,
        [ohneMandant],
      );
      expect(offen).toEqual([]);

      const { rows: gleitkomma } = await owner.query(`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type IN ('real', 'double precision', 'money')
      `);
      expect(gleitkomma).toEqual([]);
    }); // prettier-ignore
  });
});
