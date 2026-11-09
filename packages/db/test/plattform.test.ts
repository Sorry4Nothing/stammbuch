import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { RawBuilder } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { Datenbank } from "../src/index.js";
import { createTestDatabase, withCredentials } from "./helpers.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const P = "33333333-3333-4333-8333-333333333333"; // Anbieter
const userA = "aaaaaaaa-0000-4000-8000-000000000001";
const userB = "bbbbbbbb-0000-4000-8000-000000000001";
const chef = "cccccccc-0000-4000-8000-000000000001";
const chefInaktiv = "cccccccc-0000-4000-8000-000000000002";
const hash = (s: string) => createHash("sha256").update(s).digest();

const denied = { code: "42501" };

describe("Platform: Tabellen, Rechte und Funktionen", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let owner: pg.Client;
  let db: Datenbank;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject("adminUrl"), inject("templateDb"));
    owner = new pg.Client({ connectionString: testDb.adminUrl });
    await owner.connect();
    await owner.query(
      `INSERT INTO kunde (id, name) VALUES ($1, 'Kunde A'), ($2, 'Kunde B'), ($3, 'Anbieter')`,
      [A, B, P],
    );
    await owner.query(
      `INSERT INTO benutzer (id, kunde_id, email, name, passwort_hash, rolle, aktiv) VALUES
        ($1, $4, 'a@example.test', 'A', 'h', 'user', true),
        ($2, $5, 'b@example.test', 'B', 'h', 'user', true),
        ($3, $6, 'chef@example.test', 'Chef', 'h', 'chief_admin', true),
        ('${chefInaktiv}', $6, 'alt@example.test', 'Alt', 'h', 'chief_admin', false)`,
      [userA, userB, chef, A, B, P],
    ); // prettier-ignore
    db = new Datenbank(withCredentials(testDb.adminUrl, "stammbuch_app", inject("appPassword")), {
      max: 2,
    });
  });

  afterAll(async () => {
    await db.close();
    await owner.end();
    await testDb.drop();
  });

  describe("Vertragsdaten am Kunden", () => {
    it("neue Kunden sind aktiv, die Lizenz gilt ohne Angabe nur bis heute", async () => {
      const { rows } = await owner.query<{ status: string; ok: boolean }>(
        "SELECT status, lizenz_gueltig_bis = CURRENT_DATE AS ok FROM kunde WHERE id = $1",
        [A],
      );
      expect(rows).toEqual([{ status: "active", ok: true }]);
    });

    it("die Anwendungsrolle ändert weder Status noch Lizenz noch legt sie Kunden an", async () => {
      for (const spalte of ["status", "lizenz_gueltig_bis", "beendet_am"]) {
        await expect(
          db.withKunde(A, (t) =>
            sql`UPDATE kunde SET ${sql.id(spalte)} = ${sql.id(spalte)} WHERE id = ${A}::uuid`.execute(
              t,
            ),
          ),
        ).rejects.toMatchObject(denied);
      }
      await expect(
        db.withKunde(A, (t) => sql`INSERT INTO kunde (name) VALUES ('Neu')`.execute(t)),
      ).rejects.toMatchObject(denied);
    });

    it("beendet_am gehört zum Status ended", async () => {
      await expect(
        owner.query("UPDATE kunde SET status = 'ended' WHERE id = $1", [B]),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("Benutzer: Kundenrolle und Einladungsstatus", () => {
    it("Eingeladene sind nie aktiv", async () => {
      await expect(
        owner.query(
          `INSERT INTO benutzer (kunde_id, email, name, passwort_hash, status, aktiv) VALUES ($1, 'x@example.test', 'X', '!', 'invited', true)`,
          [A],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("Kunde A setzt Kundenrolle und Status im eigenen Kunden, aber nie die Anbieterrolle", async () => {
      await db.withKunde(A, (t) =>
        t
          .insertInto("benutzer")
          .values({ kunde_id: A, email: "neu@example.test", name: "Neu", passwort_hash: "!", aktiv: false, kunden_rolle: "admin", status: "invited" })
          .execute(),
      ); // prettier-ignore
      const rolle = await db.withKunde(A, (t) =>
        t.updateTable("benutzer").set({ kunden_rolle: "user" }).where("email", "=", "neu@example.test").returning("kunden_rolle").executeTakeFirst(),
      ); // prettier-ignore
      expect(rolle?.kunden_rolle).toBe("user");
      await expect(
        db.withKunde(A, (t) =>
          sql`UPDATE benutzer SET rolle = 'chief_admin' WHERE id = ${userA}::uuid`.execute(t),
        ),
      ).rejects.toMatchObject(denied);
      await expect(
        db.withKunde(A, (t) =>
          sql`UPDATE benutzer SET status = 'active', aktiv = true WHERE email = 'neu@example.test'`.execute(
            t,
          ),
        ),
      ).rejects.toMatchObject(denied);
    });

    it("Entfernen eines Benutzers lässt sein Protokoll bestehen (SET NULL statt CASCADE)", async () => {
      await owner.query(`INSERT INTO audit_log (kunde_id, benutzer_id, aktion) VALUES ($1, $2, 'user.add')`, [B, userB]);
      await db.withKunde(B, (t) => t.deleteFrom("benutzer").where("id", "=", userB).execute());
      const { rows } = await owner.query("SELECT benutzer_id FROM audit_log WHERE kunde_id = $1 AND aktion = 'user.add'", [B]);
      expect(rows).toEqual([{ benutzer_id: null }]);
    }); // prettier-ignore
  });

  describe("Einladung, Organisation, Logo (RLS)", () => {
    it("Kunde A sieht und schreibt nur eigene Zeilen", async () => {
      const neu = (kunde_id: string, token: string) =>
        db.withKunde(A, (t) =>
          t.insertInto("einladung").values({ kunde_id, email: "i@example.test", rolle: "admin", benutzer_id: null, token_hash: hash(token), laeuft_ab_am: new Date(Date.now() + 86_400_000) }).execute(),
        ); // prettier-ignore
      await neu(A, "t-a");
      await expect(neu(B, "t-b")).rejects.toMatchObject(denied);
      await owner.query(
        `INSERT INTO einladung (kunde_id, email, rolle, token_hash, laeuft_ab_am) VALUES ($1, 'b@example.test', 'user', $2, now() + interval '1 day')`,
        [B, hash("fremd")],
      );
      const gesehen = await db.withKunde(A, (t) =>
        t.selectFrom("einladung").select("kunde_id").execute(),
      );
      expect(gesehen).toEqual([{ kunde_id: A }]);
      expect(await db.kysely.selectFrom("einladung").selectAll().execute()).toEqual([]);
    });

    it("Einladungen sind für die Anwendungsrolle nicht änderbar", async () => {
      await expect(
        db.withKunde(A, (t) => sql`UPDATE einladung SET eingeloest_am = now()`.execute(t)),
      ).rejects.toMatchObject(denied);
      await expect(
        db.withKunde(A, (t) => sql`DELETE FROM einladung`.execute(t)),
      ).rejects.toMatchObject(denied);
    });

    it("Organisation und Logo sind je Kunde getrennt; das Logo ist begrenzt", async () => {
      await db.withKunde(A, async (t) => {
        await t.insertInto("organisation").values({ kunde_id: A, daten: JSON.stringify({ master: { name: "A" } }), aktualisiert_am: new Date() }).execute();
        await t.insertInto("logo").values({ kunde_id: A, mime: "image/png", bytes: Buffer.from([1, 2, 3]), aktualisiert_am: new Date() }).execute();
      }); // prettier-ignore
      await expect(
        db.withKunde(A, (t) => t.insertInto("organisation").values({ kunde_id: B, daten: "{}", aktualisiert_am: new Date() }).execute()),
      ).rejects.toMatchObject(denied);
      expect(await db.withKunde(B, (t) => t.selectFrom("organisation").selectAll().execute())).toEqual([]);
      expect(await db.withKunde(B, (t) => t.selectFrom("logo").selectAll().execute())).toEqual([]);
      await expect(
        db.withKunde(B, (t) => t.insertInto("logo").values({ kunde_id: B, mime: "image/png", bytes: Buffer.alloc(524_289), aktualisiert_am: new Date() }).execute()),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        db.withKunde(B, (t) => t.insertInto("logo").values({ kunde_id: B, mime: "image/svg+xml" as "image/png", bytes: Buffer.from([1]), aktualisiert_am: new Date() }).execute()),
      ).rejects.toMatchObject({ code: "23514" });
    }); // prettier-ignore
  });

  describe("Funktionen des Chef-Admins", () => {
    const call = <T>(query: RawBuilder<T>) => query.execute(db.kysely);

    it("chef_konto liefert nur aktive Chef-Admins", async () => {
      expect((await call(sql`SELECT * FROM chef_konto(${chef}::uuid)`)).rows).toEqual([
        { id: chef, email: "chef@example.test", name: "Chef" },
      ]);
      for (const nicht of [userA, chefInaktiv]) {
        expect((await call(sql`SELECT * FROM chef_konto(${nicht}::uuid)`)).rows).toEqual([]);
      }
    });

    it("Kunden anlegen, ändern und auflisten verlangt einen aktiven Chef-Admin", async () => {
      const neu = "44444444-4444-4444-8444-444444444444";
      for (const nicht of [userA, chefInaktiv]) {
        await expect(
          call(sql`SELECT kunde_anlegen(${nicht}::uuid, ${neu}::uuid, 'Neu', '2030-01-01'::date, now(), 'neu')`),
        ).rejects.toMatchObject(denied);
        await expect(
          call(sql`SELECT * FROM kunde_aendern(${nicht}::uuid, ${A}::uuid, 'X', 'suspended', NULL, NULL, NULL)`),
        ).rejects.toMatchObject(denied);
        const liste = await call(sql`SELECT * FROM kunden_auflisten(${nicht}::uuid, NULL, NULL, 10, 0)`);
        expect(liste.rows.every((r) => (r as { id: string | null }).id === null)).toBe(true);
        expect(Number((liste.rows[0] as { gesamt: string }).gesamt)).toBe(0);
      }
      const { rows: unveraendert } = await owner.query("SELECT status FROM kunde WHERE id = $1", [A]);
      expect(unveraendert).toEqual([{ status: "active" }]);

      await call(sql`SELECT kunde_anlegen(${chef}::uuid, ${neu}::uuid, 'Zürich Neu', '2030-01-01'::date, now(), 'zuerich-neu')`);
      const geaendert = await call(
        sql<{ status: string; lizenz_gueltig_bis: string }>`SELECT * FROM kunde_aendern(${chef}::uuid, ${neu}::uuid, NULL, 'suspended', '2031-06-30'::date, NULL, NULL)`,
      );
      expect(geaendert.rows).toMatchObject([{ status: "suspended", lizenz_gueltig_bis: "2031-06-30" }]);
      const beendet = await call(sql`SELECT * FROM kunde_aendern(${chef}::uuid, ${neu}::uuid, NULL, 'ended', NULL, now(), NULL)`);
      expect(beendet.rows).toHaveLength(1);

      const alle = await call(sql<{ gesamt: string }>`SELECT * FROM kunden_auflisten(${chef}::uuid, NULL, NULL, 2, 0)`);
      expect(alle.rows).toHaveLength(2);
      expect(Number(alle.rows[0]!.gesamt)).toBe(4);
      const gefiltert = await call(sql<{ name: string }>`SELECT * FROM kunden_auflisten(${chef}::uuid, 'ended', ${"%zürich%"}, 10, 0)`);
      expect(gefiltert.rows.map((r) => r.name)).toEqual(["Zürich Neu"]);
      const leereSeite = await call(sql<{ id: string | null; gesamt: string }>`SELECT * FROM kunden_auflisten(${chef}::uuid, NULL, NULL, 10, 100)`);
      expect(leereSeite.rows).toEqual([{ id: null, name: null, slug: null, status: null, lizenz_gueltig_bis: null, erstellt_am: null, beendet_am: null, gesamt: "4" }]);
    }); // prettier-ignore

    describe("Chef-Admin-Schnittstellen (Issue #115)", () => {
      const nicht = [userA, chefInaktiv];
      const inP = (n: number) => `77777777-7777-4777-8777-00000000000${n}`;

      it("Lizenznummer vergibt die Datenbank fortlaufend, Beginn und Module nur über die Funktion", async () => {
        const id = "88888888-8888-4888-8888-888888888881";
        await expect(
          call(sql`SELECT kunde_anlegen(${userA}::uuid, ${id}::uuid, 'L1', '2030-01-01'::date, now(), 'l1', '2026-01-01'::date, ARRAY['mail']::text[])`),
        ).rejects.toMatchObject(denied);
        await call(sql`SELECT kunde_anlegen(${chef}::uuid, ${id}::uuid, 'L1', '2030-01-01'::date, now(), 'l1', '2026-01-01'::date, ARRAY['mail','kalender']::text[])`);
        const nr = await owner.query<{ lizenz_nr: string }>("SELECT lizenz_nr FROM kunde ORDER BY lizenz_nr");
        expect(nr.rows.map((r) => r.lizenz_nr)).toEqual([...new Set(nr.rows.map((r) => r.lizenz_nr))]);
        expect(nr.rows.every((r) => /^L-\d{4}$/.test(r.lizenz_nr))).toBe(true);

        const v = await call(sql<{ id: string; lizenz_nr: string; lizenz_beginn: string; module: string[] }>`SELECT * FROM kunden_vertrag(${chef}::uuid, ARRAY[${id}]::uuid[])`);
        expect(v.rows).toMatchObject([{ id, lizenz_beginn: "2026-01-01", module: ["mail", "kalender"] }]);
        expect(v.rows[0]!.lizenz_nr).toMatch(/^L-\d{4}$/);

        // Die alte Signatur (ohne Beginn und Module) vergibt ebenfalls eine Nummer; Beginn und Module sind dann NULL.
        const alt = "88888888-8888-4888-8888-888888888882";
        await call(sql`SELECT kunde_anlegen(${chef}::uuid, ${alt}::uuid, 'L0', '2030-01-01'::date, now(), 'l0')`);
        const a = await call(sql<{ lizenz_nr: string; lizenz_beginn: string | null; module: string[] | null }>`SELECT * FROM kunden_vertrag(${chef}::uuid, ARRAY[${alt}]::uuid[])`);
        expect(a.rows[0]!.lizenz_nr).toMatch(/^L-\d{4}$/);
        expect(a.rows[0]).toMatchObject({ lizenz_beginn: null, module: null });
      }); // prettier-ignore

      it("kunden_vertrag zählt aktive Benutzer ohne Chef-Admins und liefert ohne Chef-Admin nichts", async () => {
        const mit = await call(sql<{ id: string; benutzer_anzahl: string }>`SELECT * FROM kunden_vertrag(${chef}::uuid, ARRAY[${A}, ${B}, ${P}]::uuid[])`);
        const anzahl = Object.fromEntries(mit.rows.map((r) => [r.id, Number(r.benutzer_anzahl)]));
        const inB = await owner.query<{ n: string }>("SELECT count(*) AS n FROM benutzer WHERE kunde_id = $1 AND rolle = 'user' AND aktiv", [B]);
        expect(anzahl).toEqual({ [A]: 1, [B]: Number(inB.rows[0]!.n), [P]: 0 });
        for (const n of nicht) {
          expect((await call(sql`SELECT * FROM kunden_vertrag(${n}::uuid, ARRAY[${A}]::uuid[])`)).rows).toEqual([]);
        }
      }); // prettier-ignore

      it("die Anwendungsrolle kann Nummer, Beginn und Module weder setzen noch ändern; nur bekannte Module", async () => {
        for (const spalte of ["lizenz_nr", "lizenz_beginn", "module"]) {
          await expect(
            db.withKunde(A, (t) => sql`UPDATE kunde SET ${sql.id(spalte)} = ${sql.id(spalte)} WHERE id = ${A}::uuid`.execute(t)),
          ).rejects.toMatchObject(denied);
        }
        await expect(
          owner.query("UPDATE kunde SET module = ARRAY['personen'] WHERE id = $1", [A]),
        ).rejects.toMatchObject({ code: "23514" });
        await expect(
          owner.query("UPDATE kunde SET lizenz_nr = (SELECT lizenz_nr FROM kunde WHERE id = $2) WHERE id = $1", [A, B]),
        ).rejects.toMatchObject({ code: "23505" });
        // Die Anwendung liest Nummer, Beginn und Module des eigenen Kunden direkt.
        const eigene = await db.withKunde(A, (t) => t.selectFrom("kunde").select(["lizenz_nr", "module"]).execute());
        expect(eigene).toHaveLength(1);
        expect(eigene[0]!.lizenz_nr).toMatch(/^L-\d{4}$/);
      }); // prettier-ignore

      it("kunde_benutzer_fuer_chef zeigt aktive Benutzer eines Kunden mit Stand des zweiten Faktors und letzter Anmeldung", async () => {
        await owner.query(
          `INSERT INTO benutzer (id, kunde_id, email, name, passwort_hash, rolle, aktiv, status) VALUES
             ($1, $3, 'zwei@example.test', 'Zwei', 'h', 'user', true, 'active'),
             ($2, $3, 'eingeladen-115@example.test', 'Eingeladen', '!', 'user', false, 'invited')`,
          [inP(1), inP(2), A],
        );
        await owner.query(
          "UPDATE benutzer SET totp_secret_enc = 'v1.x', totp_letzter_zaehler = 1, totp_eingerichtet_am = now() WHERE id = $1",
          [inP(1)],
        );
        await owner.query(
          `INSERT INTO audit_log (kunde_id, benutzer_id, zeitpunkt, aktion) VALUES
             ($1, $2, '2026-11-01T08:00:00Z', 'mfa_success'),
             ($1, $2, '2026-11-03T08:00:00Z', 'recovery_used'),
             ($1, $2, '2026-11-09T08:00:00Z', 'password_changed')`,
          [A, inP(1)],
        );
        const rows = await call(sql<{ id: string; name: string; totp_eingerichtet: boolean; letzte_anmeldung: Date | null }>`SELECT * FROM kunde_benutzer_fuer_chef(${chef}::uuid, ${A}::uuid)`);
        expect(rows.rows.map((r) => [r.name, r.totp_eingerichtet, r.letzte_anmeldung?.toISOString() ?? null])).toEqual([
          ["A", false, null],
          ["Zwei", true, "2026-11-03T08:00:00.000Z"],
        ]);
        // Nur diese fünf Spalten, nie Hash oder Geheimnis.
        expect(Object.keys(rows.rows[0]!).sort()).toEqual(["email", "id", "letzte_anmeldung", "name", "totp_eingerichtet"]);
        // Der andere Kunde bleibt getrennt; ohne Chef-Admin gibt es keine Zeilen.
        const b = await call(sql<{ name: string }>`SELECT * FROM kunde_benutzer_fuer_chef(${chef}::uuid, ${B}::uuid)`);
        const inB = await owner.query<{ name: string }>("SELECT name FROM benutzer WHERE kunde_id = $1 AND rolle = 'user' AND aktiv ORDER BY lower(name), id", [B]);
        expect(b.rows.map((r) => r.name)).toEqual(inB.rows.map((r) => r.name));
        expect(b.rows.map((r) => r.name)).not.toContain("Zwei");
        for (const n of nicht) {
          expect((await call(sql`SELECT * FROM kunde_benutzer_fuer_chef(${n}::uuid, ${A}::uuid)`)).rows).toEqual([]);
        }
      }); // prettier-ignore

      it("Sicherheitsstand, Sitzungen und Anmeldungen des eigenen Kontos; fremde Konten und Nicht-Chefs sehen und ändern nichts", async () => {
        const token = hash("chef-aktuell");
        const andere = hash("chef-andere");
        const fremd = hash("fremd");
        await owner.query(
          "UPDATE benutzer SET totp_secret_enc = 'v1.x', totp_letzter_zaehler = 1, totp_eingerichtet_am = '2026-09-01T09:00:00Z' WHERE id = $1",
          [chef],
        );
        await owner.query(
          `INSERT INTO wiederherstellungscode (kunde_id, benutzer_id, code_hmac) VALUES
             ($1, $2, repeat('a', 64)), ($1, $2, repeat('b', 64)), ($1, $2, repeat('c', 64))`,
          [P, chef],
        );
        await owner.query(
          `INSERT INTO sitzung (kunde_id, benutzer_id, token_hash, erstellt_am, laeuft_ab_am, phase, csrf_token) VALUES
             ($1, $2, $3, now() - interval '1 hour', now() + interval '1 hour', 'full', 'c1'),
             ($1, $2, $4, now() - interval '2 hours', now() + interval '1 hour', 'full', 'c2'),
             ($1, $2, $5, now() - interval '3 hours', now() + interval '1 hour', 'pending', 'c3'),
             ($1, $2, $6, now() - interval '4 hours', now() - interval '1 minute', 'full', 'c4'),
             ($7, $8, $9, now(), now() + interval '1 hour', 'full', 'c5')`,
          [P, chef, token, andere, hash("pending"), hash("abgelaufen"), A, userA, fremd],
        );
        await owner.query(
          `INSERT INTO audit_log (kunde_id, benutzer_id, objekt_id, zeitpunkt, aktion, details) VALUES
             ($1, $2, NULL, '2026-11-01T08:00:00Z', 'mfa_success', '{"ergebnis":"success"}'),
             ($1, NULL, $3::text, '2026-11-02T08:00:00Z', 'login_failure', '{"ergebnis":"failure"}'),
             ($1, $2, NULL, '2026-11-03T08:00:00Z', 'password_changed', '{}'),
             ($1, $2, NULL, '2026-11-04T08:00:00Z', 'name_changed', '{}'),
             ($1, NULL, NULL, '2026-11-05T08:00:00Z', 'login_failure', '{}')`,
          [P, chef, chef],
        );

        const s = await call(sql<{ totp_eingerichtet_am: Date; codes_unbenutzt: string; passwort_geaendert_am: Date }>`SELECT * FROM chef_sicherheit(${chef}::uuid)`);
        expect(s.rows).toHaveLength(1);
        expect(s.rows[0]!.totp_eingerichtet_am.toISOString()).toBe("2026-09-01T09:00:00.000Z");
        expect(Number(s.rows[0]!.codes_unbenutzt)).toBe(3);
        expect(s.rows[0]!.passwort_geaendert_am.toISOString()).toBe("2026-11-03T08:00:00.000Z");

        const liste = await call(sql<{ id: string; aktuell: boolean }>`SELECT * FROM chef_sitzungen(${chef}::uuid, ${token}::bytea)`);
        // Offene Sitzungen in voller Stufe: die aktuelle zuerst (neuer), dann die andere; nichts Fremdes, nichts Abgelaufenes.
        expect(liste.rows.map((r) => r.aktuell)).toEqual([true, false]);
        const ohneToken = await call(sql<{ aktuell: boolean | null }>`SELECT * FROM chef_sitzungen(${chef}::uuid, NULL::bytea)`);
        expect(ohneToken.rows.map((r) => r.aktuell)).toEqual([null, null]);

        const logins = await call(sql<{ zeitpunkt: Date; aktion: string }>`SELECT * FROM chef_anmeldungen(${chef}::uuid, 10)`);
        expect(logins.rows.map((r) => r.aktion)).toEqual(["login_failure", "mfa_success"]);

        // Beenden: nie die aktuelle, nie eine fremde, nur als Chef-Admin.
        const [aktuell, andereSitzung] = liste.rows;
        expect((await call(sql<{ chef_sitzung_beenden: boolean }>`SELECT chef_sitzung_beenden(${chef}::uuid, ${aktuell!.id}::uuid, ${token}::bytea)`)).rows[0]!.chef_sitzung_beenden).toBe(false);
        const fremdId = (await owner.query<{ id: string }>("SELECT id FROM sitzung WHERE benutzer_id = $1", [userA])).rows[0]!.id;
        expect((await call(sql<{ chef_sitzung_beenden: boolean }>`SELECT chef_sitzung_beenden(${chef}::uuid, ${fremdId}::uuid, ${token}::bytea)`)).rows[0]!.chef_sitzung_beenden).toBe(false);
        for (const n of nicht) {
          expect((await call(sql<{ chef_sitzung_beenden: boolean }>`SELECT chef_sitzung_beenden(${n}::uuid, ${andereSitzung!.id}::uuid, ${token}::bytea)`)).rows[0]!.chef_sitzung_beenden).toBe(false);
          expect((await call(sql`SELECT * FROM chef_sitzungen(${n}::uuid, ${token}::bytea)`)).rows).toEqual([]);
          expect((await call(sql`SELECT * FROM chef_sicherheit(${n}::uuid)`)).rows).toEqual([]);
          expect((await call(sql`SELECT * FROM chef_anmeldungen(${n}::uuid, 10)`)).rows).toEqual([]);
        }
        expect((await owner.query("SELECT 1 FROM sitzung WHERE widerrufen_am IS NOT NULL")).rowCount).toBe(0);
        expect((await call(sql<{ chef_sitzung_beenden: boolean }>`SELECT chef_sitzung_beenden(${chef}::uuid, ${andereSitzung!.id}::uuid, ${token}::bytea)`)).rows[0]!.chef_sitzung_beenden).toBe(true);
        expect((await call(sql`SELECT * FROM chef_sitzungen(${chef}::uuid, ${token}::bytea)`)).rows).toHaveLength(1);
        // Zweites Beenden derselben Sitzung ändert nichts mehr.
        expect((await call(sql<{ chef_sitzung_beenden: boolean }>`SELECT chef_sitzung_beenden(${chef}::uuid, ${andereSitzung!.id}::uuid, ${token}::bytea)`)).rows[0]!.chef_sitzung_beenden).toBe(false);
      }); // prettier-ignore
    });

    it("das Konto des Chef-Admins ändert nur er selbst", async () => {
      expect(
        (await call(sql`SELECT * FROM chef_konto_aendern(${userA}::uuid, 'Hacker')`)).rows,
      ).toEqual([]);
      expect(
        (await call(sql`SELECT * FROM chef_konto_aendern(${chef}::uuid, 'Neuer Name')`)).rows,
      ).toEqual([{ id: chef, email: "chef@example.test", name: "Neuer Name" }]);
    });

    it("Plattformprotokoll: nur anhängen durch den Chef-Admin, Tabelle selbst gesperrt", async () => {
      const id = (n: number) => `55555555-5555-4555-8555-00000000000${n}`;
      await expect(
        call(sql`SELECT plattform_protokoll_anhaengen(${userA}::uuid, ${id(1)}::uuid, now(), 'a@example.test', 'customer.create', 'X')`),
      ).rejects.toMatchObject(denied);
      for (const [n, aktion] of [[1, "customer.create"], [2, "customer.suspend"]] as const) {
        await call(sql`SELECT plattform_protokoll_anhaengen(${chef}::uuid, ${id(n)}::uuid, now() + ${n} * interval '1 minute', 'chef@example.test', ${aktion}, 'Kunde_A')`);
      }
      const alle = await call(sql<{ aktion: string; gesamt: string }>`SELECT * FROM plattform_protokoll_lesen(NULL, NULL, NULL, NULL, NULL, 10, 0)`);
      expect(alle.rows.map((r) => r.aktion)).toEqual(["customer.suspend", "customer.create"]);
      const treffer = await call(sql<{ aktion: string }>`SELECT * FROM plattform_protokoll_lesen(NULL, NULL, NULL, NULL, ${"%kunde\\_a%"}, 10, 0)`);
      expect(treffer.rows).toHaveLength(2);
      const keiner = await call(sql<{ aktion: string }>`SELECT * FROM plattform_protokoll_lesen(NULL, NULL, NULL, NULL, ${"%kunde%a%b%"}, 10, 0)`);
      expect(keiner.rows.filter((r) => r.aktion !== null)).toEqual([]);
      await expect(db.withKunde(A, (t) => sql`SELECT * FROM plattform_protokoll`.execute(t))).rejects.toMatchObject(denied);
      await expect(db.withKunde(A, (t) => sql`DELETE FROM plattform_protokoll`.execute(t))).rejects.toMatchObject(denied);
    }); // prettier-ignore

    it("Slug: gesetzt beim Anlegen, eindeutig, nur über die Funktionen änderbar", async () => {
      const x = "55555555-5555-4555-8555-555555555555";
      const y = "66666666-6666-4666-8666-666666666666";
      await call(sql`SELECT kunde_anlegen(${chef}::uuid, ${x}::uuid, 'Slug X', '2030-01-01'::date, now(), 'slug-x')`);
      const gleich = call(sql`SELECT kunde_anlegen(${chef}::uuid, ${y}::uuid, 'Slug Y', '2030-01-01'::date, now(), 'slug-x')`);
      await expect(gleich).rejects.toMatchObject({ code: "23505", constraint: "kunde_slug_key" });
      await call(sql`SELECT kunde_anlegen(${chef}::uuid, ${y}::uuid, 'Slug Y', '2030-01-01'::date, now(), 'slug-y')`);
      // Format erzwingt der CHECK, Kollision beim Ändern der UNIQUE-Constraint, NULL lässt den Slug stehen.
      await expect(
        call(sql`SELECT * FROM kunde_aendern(${chef}::uuid, ${y}::uuid, NULL, NULL, NULL, NULL, 'Ungültig')`),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        call(sql`SELECT * FROM kunde_aendern(${chef}::uuid, ${y}::uuid, NULL, NULL, NULL, NULL, 'slug-x')`),
      ).rejects.toMatchObject({ code: "23505" });
      await call(sql`SELECT * FROM kunde_aendern(${chef}::uuid, ${y}::uuid, 'Neuer Name', NULL, NULL, NULL, NULL)`);
      const neu = await call(sql<{ slug: string }>`SELECT * FROM kunde_aendern(${chef}::uuid, ${y}::uuid, NULL, NULL, NULL, NULL, 'slug-z')`);
      expect(neu.rows).toMatchObject([{ slug: "slug-z", name: "Neuer Name" }]);
      const liste = await call(sql<{ slug: string }>`SELECT * FROM kunden_auflisten(${chef}::uuid, NULL, NULL, 10, 0)`);
      expect(liste.rows.map((r) => r.slug)).toEqual(expect.arrayContaining(["slug-x", "slug-z", "zuerich-neu", null]));
      // Nicht-Chef: verweigert, Slug bleibt.
      await expect(
        call(sql`SELECT * FROM kunde_aendern(${userA}::uuid, ${y}::uuid, NULL, NULL, NULL, NULL, 'gekapert')`),
      ).rejects.toMatchObject(denied);
      // Die Anwendungsrolle ändert den Slug nicht direkt; sie löst ihn auf.
      await expect(
        db.withKunde(x, (t) => t.updateTable("kunde").set({ slug: "direkt" }).execute()),
      ).rejects.toMatchObject(denied);
      const id = await call(sql<{ id: string }>`SELECT kunde_id_fuer_slug('slug-z') AS id`);
      expect(id.rows).toEqual([{ id: y }]);
    }); // prettier-ignore
  });

  describe("einladung_einloesen", () => {
    const einloesen = (token: string, jetzt: Date) =>
      sql<{
        kunde_id: string;
        email: string;
        rolle: string;
      }>`SELECT * FROM einladung_einloesen(${hash(token)}::bytea, ${jetzt}::timestamptz)`.execute(
        db.kysely,
      );

    it("löst genau einmal ein, nicht abgelaufen", async () => {
      const jetzt = new Date();
      expect((await einloesen("t-a", jetzt)).rows).toMatchObject([{ kunde_id: A, email: "i@example.test", rolle: "admin" }]);
      expect((await einloesen("t-a", jetzt)).rows).toEqual([]);
    }); // prettier-ignore

    it("lehnt abgelaufene und unbekannte Tokens ab", async () => {
      expect((await einloesen("fremd", new Date(Date.now() + 2 * 86_400_000))).rows).toEqual([]);
      expect((await einloesen("gibt-es-nicht", new Date())).rows).toEqual([]);
      // Unveränderte Einladung ist danach noch einlösbar.
      expect((await einloesen("fremd", new Date())).rows).toHaveLength(1);
    });
  });
  describe("einladung_pruefen und einladung_annehmen", () => {
    const neu = (token: string, email: string, o: { rolle?: string; benutzer?: string | null; kunde?: string; tage?: number } = {}) =>
      owner.query(
        `INSERT INTO einladung (kunde_id, email, rolle, benutzer_id, token_hash, laeuft_ab_am)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)`,
        [o.kunde ?? A, email, o.rolle ?? "admin", o.benutzer ?? null, hash(token), String(o.tage ?? 1)],
      ); // prettier-ignore
    const annehmen = (token: string, jetzt = new Date(), pw = "p2:$argon2id$test") =>
      sql<{ benutzer_id: string; kunde_id: string; rolle: string }>`
        SELECT * FROM einladung_annehmen(${hash(token)}::bytea, ${jetzt}::timestamptz, ${pw})`.execute(
        db.kysely,
      );
    const pruefen = (token: string, jetzt = new Date()) =>
      sql<{ email: string; kunde_id: string }>`
        SELECT * FROM einladung_pruefen(${hash(token)}::bytea, ${jetzt}::timestamptz)`.execute(
        db.kysely,
      );
    const eingeloest = async (token: string) =>
      (
        await owner.query("SELECT eingeloest_am FROM einladung WHERE token_hash = $1", [
          hash(token),
        ])
      ).rows[0].eingeloest_am !== null;

    it("prüfen verbraucht nichts; annehmen legt den ersten Admin aktiv im Kunden der Einladung an, genau einmal", async () => {
      await neu("n-1", "erster@example.test");
      expect((await pruefen("n-1")).rows).toEqual([{ email: "erster@example.test", kunde_id: A }]);
      expect(await eingeloest("n-1")).toBe(false);

      const r = await annehmen("n-1");
      expect(r.rows).toMatchObject([{ kunde_id: A, rolle: "admin" }]);
      const { rows } = await owner.query(
        "SELECT kunde_id, name, passwort_hash, aktiv, status, kunden_rolle, rolle FROM benutzer WHERE email = 'erster@example.test'",
      );
      expect(rows).toEqual([{ kunde_id: A, name: "erster", passwort_hash: "p2:$argon2id$test", aktiv: true, status: "active", kunden_rolle: "admin", rolle: "user" }]); // prettier-ignore
      expect(await eingeloest("n-1")).toBe(true);
      expect((await annehmen("n-1")).rows).toEqual([]);
      expect((await pruefen("n-1")).rows).toEqual([]);
    });

    it("gibt einen eingeladenen Benutzer frei und nimmt die Kundenrolle aus der Einladung", async () => {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO benutzer (kunde_id, email, name, passwort_hash, aktiv, status, kunden_rolle)
         VALUES ($1, 'eingeladen@example.test', 'Eingeladen', '!', false, 'invited', 'user') RETURNING id`,
        [A],
      );
      await neu("n-2", "eingeladen@example.test", { rolle: "admin", benutzer: rows[0]!.id });
      expect((await annehmen("n-2")).rows).toMatchObject([
        { benutzer_id: rows[0]!.id, rolle: "admin" },
      ]);
      expect(
        (
          await owner.query(
            "SELECT name, passwort_hash, aktiv, status, kunden_rolle FROM benutzer WHERE id = $1",
            [rows[0]!.id],
          )
        ).rows,
      ).toEqual([
        {
          name: "Eingeladen",
          passwort_hash: "p2:$argon2id$test",
          aktiv: true,
          status: "active",
          kunden_rolle: "admin",
        },
      ]);
    });

    it("alles oder nichts: vergebene Adresse oder aktives Konto lässt die Einladung unverbraucht und das Konto unberührt", async () => {
      await neu("n-3", "a@example.test"); // Adresse von userA
      await neu("n-4", "a@example.test", { benutzer: userA }); // Verweis auf ein aktives Konto
      await neu("n-5", "chef@example.test", { kunde: P, benutzer: chef }); // Chef-Admin
      for (const t of ["n-3", "n-4", "n-5"]) {
        expect((await annehmen(t, new Date(), "uebernommen")).rows).toEqual([]);
        expect((await pruefen(t)).rows).toEqual([]);
        expect(await eingeloest(t)).toBe(false);
      }
      expect(
        (
          await owner.query("SELECT passwort_hash FROM benutzer WHERE id IN ($1, $2)", [
            userA,
            chef,
          ])
        ).rows,
      ).toEqual([{ passwort_hash: "h" }, { passwort_hash: "h" }]);
    });

    it("abgelaufen, unbekannt und gesperrter Kunde liefern nichts", async () => {
      await neu("n-6", "spaet@example.test");
      expect((await annehmen("n-6", new Date(Date.now() + 2 * 86_400_000))).rows).toEqual([]);
      expect((await annehmen("gibt-es-nicht")).rows).toEqual([]);
      await neu("n-7", "gesperrt@example.test", { kunde: P });
      await owner.query("UPDATE kunde SET status = 'suspended' WHERE id = $1", [P]);
      expect((await annehmen("n-7")).rows).toEqual([]);
      expect((await pruefen("n-7")).rows).toEqual([]);
      await owner.query("UPDATE kunde SET status = 'active' WHERE id = $1", [P]);
      expect((await annehmen("n-7")).rows).toHaveLength(1);
      expect(await eingeloest("n-6")).toBe(false);
    });

    it("gleichzeitiges Einlösen: genau einer gewinnt", async () => {
      await neu("n-8", "rennen@example.test");
      const res = await Promise.all([annehmen("n-8"), annehmen("n-8")]);
      expect(res.map((r) => r.rows.length).sort()).toEqual([0, 1]);
      expect(
        (await owner.query("SELECT 1 FROM benutzer WHERE email = 'rennen@example.test'")).rows,
      ).toHaveLength(1);
    });
  });
});
