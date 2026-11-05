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
});
