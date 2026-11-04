import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { migrate } from "../src/migrate.js";
import { createTestDatabase } from "./helpers.js";

describe("Migrationsrunner", () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let dir: URL;
  const file = (name: string, sql: string) => writeFile(new URL(name, dir), sql);

  beforeAll(async () => {
    db = await createTestDatabase(inject("adminUrl"));
    dir = pathToFileURL(join(await mkdtemp(join(tmpdir(), "stammbuch-mig-")), "/"));
  });
  afterAll(() => db.drop());

  const tables = async () => {
    const c = new pg.Client({ connectionString: db.adminUrl });
    await c.connect();
    const { rows } = await c.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE tablename LIKE 'probe_%' ORDER BY 1",
    );
    await c.end();
    return rows.map((r) => r.tablename);
  };

  it("wendet neue Migrationen der Reihe nach an und überspringt angewendete", async () => {
    await file("202601010000_test_b.sql", "CREATE TABLE probe_b (id int);");
    await file("202601010001_test_a.sql", "CREATE TABLE probe_a (id int);");
    expect(await migrate(db.adminUrl, dir)).toEqual([
      "202601010000_test_b.sql",
      "202601010001_test_a.sql",
    ]);
    expect(await migrate(db.adminUrl, dir)).toEqual([]);
    expect(await tables()).toEqual(["probe_a", "probe_b"]);
  });

  it("rollt eine fehlerhafte Migration vollständig zurück", async () => {
    await file("202601010002_test_kaputt.sql", "CREATE TABLE probe_c (id int); SELECT 1/0;");
    await expect(migrate(db.adminUrl, dir)).rejects.toThrow("202601010002_test_kaputt.sql");
    expect(await tables()).toEqual(["probe_a", "probe_b"]);
  });

  it("bricht ab, wenn eine angewendete Migration nachträglich geändert wurde", async () => {
    await file("202601010002_test_kaputt.sql", "CREATE TABLE probe_c (id int);");
    await migrate(db.adminUrl, dir);
    await file("202601010002_test_kaputt.sql", "CREATE TABLE probe_c (id int, x int);");
    await expect(migrate(db.adminUrl, dir)).rejects.toThrow("nachträglich geändert");
  });

  it("verweigert ungültige Dateinamen", async () => {
    await file("falscher_name.sql", "SELECT 1;");
    await expect(migrate(db.adminUrl, dir)).rejects.toThrow("Ungültiger Migrationsname");
  });
});
