import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));
// Tests laufen gegen den Quelltext des DB-Pakets, ohne dass es vorher gebaut sein muss.
const resolve = {
  alias: [
    { find: /^@stammbuch\/db$/, replacement: src("../../packages/db/src/index.ts") },
    { find: /^@stammbuch\/db\/testing$/, replacement: src("../../packages/db/test/helpers.ts") },
  ],
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: {
          name: "memory",
          include: ["src/**/*.test.ts"],
          exclude: [
            "src/**/*.pg.test.ts",
            "src/**/*.int.test.ts",
            "src/**/*.postgres.test.ts",
            "src/**/postgres.test.ts",
          ],
          // Die Rechnungs-Integrationstests starten eigene Datenbank-Container (invoices/test-pg.ts).
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        // Dieselbe Dienst-Testsuite gegen PostgreSQL plus die Datenbank-Tests. Startet einen
        // eigenen, flüchtigen Container (siehe packages/db/test/global-setup.ts).
        resolve,
        test: {
          name: "postgres",
          include: [
            "src/modules/people/people.test.ts",
            "src/**/*.pg.test.ts",
            "src/**/*.int.test.ts",
            "src/**/*.postgres.test.ts",
            "src/**/postgres.test.ts",
          ],
          globalSetup: ["../../packages/db/test/global-setup.ts"],
          provide: { store: "postgres" },
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
