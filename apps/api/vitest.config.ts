import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests laden @stammbuch/db aus dem Quelltext, ohne vorherigen Build des Pakets.
    alias: {
      "@stammbuch/db": fileURLToPath(new URL("../../packages/db/src/index.ts", import.meta.url)),
    },
  },
  test: {
    // Startet einen flüchtigen Postgres-Container mit migrierter Vorlage (wie packages/db/test).
    globalSetup: ["../../packages/db/test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
