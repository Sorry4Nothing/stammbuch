import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

export const migrationNamePattern = /^\d{12}_[a-z][a-z0-9]*_[a-z0-9_]+\.sql$/;
export const defaultMigrationsDir = new URL("../migrations/", import.meta.url);

// Beliebiger fester Wert, nur damit nie zwei Migrationsläufe gleichzeitig laufen.
const LOCK_KEY = 7_340_111;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Wendet alle noch nicht angewendeten SQL-Migrationen in Namensreihenfolge an.
 * Jede Migration läuft mit ihrem Eintrag in `schema_migrations` in einer Transaktion.
 * Eine bereits angewendete Datei, die sich geändert hat oder fehlt, bricht den Lauf ab.
 * Muss mit der Eigentümer-Verbindung laufen (DATABASE_ADMIN_URL), nicht mit der Anwendungsrolle.
 * Gibt die neu angewendeten Namen zurück.
 */
export async function migrate(
  connectionString: string,
  dir: URL = defaultMigrationsDir,
): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const invalid = files.filter((f) => !migrationNamePattern.test(f));
  if (invalid.length > 0) throw new Error(`Ungültiger Migrationsname: ${invalid.join(", ")}`);

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      angewendet_am timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations",
    );
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    const missing = [...applied.keys()].filter((n) => !files.includes(n));
    if (missing.length > 0) throw new Error(`Angewendete Migration fehlt: ${missing.join(", ")}`);

    const done: string[] = [];
    for (const name of files) {
      const sql = await readFile(new URL(name, dir), "utf8");
      const checksum = sha256(sql);
      const known = applied.get(name);
      if (known !== undefined) {
        if (known !== checksum) throw new Error(`Migration nachträglich geändert: ${name}`);
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
          name,
          checksum,
        ]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration fehlgeschlagen: ${name}`, { cause: err });
      }
      done.push(name);
    }
    return done;
  } finally {
    await client.end();
  }
}

/**
 * Erlaubt der Anwendungsrolle die Anmeldung mit diesem Passwort (Betrieb/Entwicklung).
 * Das Passwort kommt aus der Umgebung, nie aus einer Migration (SR-30).
 */
export async function setAppRolePassword(adminConnectionString: string, password: string) {
  const client = new pg.Client({ connectionString: adminConnectionString });
  await client.connect();
  try {
    // ALTER ROLE nimmt keine Parameter; der Wert wird als Literal escaped.
    await client.query(`ALTER ROLE stammbuch_app LOGIN PASSWORD ${client.escapeLiteral(password)}`);
  } finally {
    await client.end();
  }
}
