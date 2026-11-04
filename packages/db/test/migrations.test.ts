import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationsDir = new URL("../migrations/", import.meta.url);
const namePattern = /^\d{12}_[a-z][a-z0-9]*_[a-z0-9_]+\.sql$/;

describe("Migrationen", () => {
  const files = readdirSync(migrationsDir).filter((f) => f !== ".gitkeep");

  it("folgen der Namenskonvention <YYYYMMDDHHmm>_<modul>_<name>.sql", () => {
    const invalid = files.filter((f) => !namePattern.test(f));
    expect(invalid).toEqual([]);
  });
});
