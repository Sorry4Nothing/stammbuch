import { Datenbank } from "@stammbuch/db";
import { createTestDatabase, withCredentials } from "@stammbuch/db/testing";
import pg from "pg";
import { inject } from "vitest";
import { createPostgresStore, createTenantResolver } from "../modules/people/postgres.js";

declare module "vitest" {
  export interface ProvidedContext {
    store: "memory" | "postgres";
    adminUrl: string;
    templateDb: string;
    appPassword: string;
  }
}

export const KUNDE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const KUNDE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Eigene Datenbank aus der migrierten Vorlage; zwei Kunden mit Kennung "verein-a" / "verein-b". */
export async function openTestDatabase() {
  const testDb = await createTestDatabase(inject("adminUrl"), inject("templateDb"));
  const owner = new pg.Client({ connectionString: testDb.adminUrl });
  await owner.connect();
  await owner.query(
    `INSERT INTO kunde (id, name, slug) VALUES ($1, 'Verein A', 'verein-a'), ($2, 'Verein B', 'verein-b')`,
    [KUNDE_A, KUNDE_B],
  );
  const appUrl = withCredentials(testDb.adminUrl, "stammbuch_app", inject("appPassword"));
  const db = new Datenbank(appUrl, { max: 8 });
  return {
    db,
    /** DATABASE_URL der Anwendungsrolle. */
    appUrl,
    /** Eigentümer-Verbindung: umgeht RLS, nur für Fixtures und Prüfungen. */
    owner,
    store: createPostgresStore(db),
    resolveTenant: createTenantResolver(db),
    /** Leert die Personen-Tabellen, die Kunden bleiben. */
    async reset() {
      await owner.query(
        "TRUNCATE registrierung_offen, gruppe_mitgliedschaft, mitglied_nummernkreis, firma_duplikat_ausnahme, mitglied, gruppe, firma",
      );
    },
    async close() {
      await db.close();
      await owner.end();
      await testDb.drop();
    },
  };
}
