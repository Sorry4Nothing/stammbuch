import { Datenbank } from "@stammbuch/db";
import pg from "pg";
import { inject } from "vitest";
import { createTestDatabase, withCredentials } from "../../../../../packages/db/test/helpers.js";
import { createPostgresStore } from "./postgres-store.js";
import type { AccountingStore } from "./repository.js";

// Bereitgestellt von packages/db/test/global-setup.ts (flüchtiger Postgres-Container, migrierte Vorlage).
declare module "vitest" {
  export interface ProvidedContext {
    adminUrl: string;
    templateDb: string;
    appPassword: string;
  }
}

export const KUNDE_A = "11111111-1111-4111-8111-111111111111";
export const KUNDE_B = "22222222-2222-4222-8222-222222222222";

const cleanups: (() => Promise<void>)[] = [];

/** Räumt alle in dieser Testdatei angelegten Datenbanken auf (`afterAll(closeAll)`). */
export async function closeAll() {
  await Promise.all(cleanups.splice(0).map((c) => c()));
}

/** Frische, migrierte Datenbank mit den Kunden A und B. Tests laufen als Anwendungsrolle, Fixtures als Eigentümer. */
export async function createDatabase(kunden: string[] = [KUNDE_A, KUNDE_B]) {
  const t = await createTestDatabase(inject("adminUrl"), inject("templateDb"));
  const owner = new pg.Client({ connectionString: t.adminUrl });
  await owner.connect();
  for (const id of kunden) {
    await owner.query("INSERT INTO kunde (id, name) VALUES ($1, $2)", [
      id,
      `Kunde ${id.slice(0, 2)}`,
    ]);
  }
  const db = new Datenbank(withCredentials(t.adminUrl, "stammbuch_app", inject("appPassword")));
  cleanups.push(async () => {
    await db.close();
    await owner.end();
    await t.drop();
  });
  return { db, owner };
}

/**
 * PostgreSQL-Speicher auf einer eigenen frischen Datenbank. Die Datenbank entsteht beim ersten Zugriff,
 * damit `makeStore` synchron bleibt wie beim Memory-Speicher.
 */
export function postgresStore(kunden?: string[]): AccountingStore {
  const ready = createDatabase(kunden).then(({ db }) => createPostgresStore(db));
  return { transaction: async (tenant, fn) => (await ready).transaction(tenant, fn) };
}
