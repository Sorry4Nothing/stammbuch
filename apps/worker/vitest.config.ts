import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Startet für die Integrationstests einen flüchtigen Postgres-Container (oder nutzt TEST_DATABASE_URL).
    globalSetup: ["../../packages/db/test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
