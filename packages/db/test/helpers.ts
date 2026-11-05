import { randomBytes } from "node:crypto";
import pg from "pg";

export function withDatabaseName(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export function withCredentials(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

/** Legt aus der migrierten Vorlage (ohne Angabe: leer) eine frische Datenbank an. `drop` räumt sie wieder auf. */
export async function createTestDatabase(adminUrl: string, templateDb?: string) {
  const name = `stammbuch_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}${templateDb ? ` TEMPLATE ${templateDb}` : ""}`);
  } finally {
    await admin.end();
  }
  return {
    name,
    adminUrl: withDatabaseName(adminUrl, name),
    async drop() {
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
export { startTestContainer, removeOrphanedContainers } from "./container.js";
