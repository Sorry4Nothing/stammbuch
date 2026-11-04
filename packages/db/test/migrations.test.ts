import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migrationNamePattern } from "../src/migrate.js";

const migrationsDir = new URL("../migrations/", import.meta.url);

describe("Migrationen", () => {
  const files = readdirSync(migrationsDir);

  it("folgen der Namenskonvention <YYYYMMDDHHmm>_<modul>_<name>.sql", () => {
    const invalid = files.filter((f) => !migrationNamePattern.test(f));
    expect(invalid).toEqual([]);
  });
});
