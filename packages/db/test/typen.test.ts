import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { sql } from "kysely";
import { Datenbank } from "../src/index.js";
import { createTestDatabase, withCredentials } from "./helpers.js";

describe("Typabbildung der Verbindung", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let db: Datenbank;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject("adminUrl"), inject("templateDb"));
    db = new Datenbank(withCredentials(testDb.adminUrl, "stammbuch_app", inject("appPassword")));
  });
  afterAll(async () => {
    await db.close();
    await testDb.drop();
  });

  it("liefert date als String ohne Zeitzonen-Verschiebung, timestamptz als Date", async () => {
    const { rows } = await sql<{ d: string; t: Date }>`
      SELECT '2026-01-01'::date AS d, '2026-01-01T00:00:00Z'::timestamptz AS t`.execute(db.kysely);
    expect(rows[0]!.d).toBe("2026-01-01");
    expect(rows[0]!.t).toBeInstanceOf(Date);
  });
});
