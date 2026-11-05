import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Höchstens 4 Worker-Prozesse: Unter Windows scheitert bei zu vielen gleichzeitigen Starts einzelner Worker (Exit 3221226505 / 3221225794), Issue #63.
    maxWorkers: 4,
    // Startet für die Integrationstests einen flüchtigen Postgres-Container (oder nutzt TEST_DATABASE_URL).
    globalSetup: ["../../packages/db/test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
