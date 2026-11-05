import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));
// Tests laufen gegen den Quelltext des DB-Pakets, ohne dass es vorher gebaut sein muss.
const resolve = {
  alias: [
    { find: /^@stammbuch\/db$/, replacement: src("../db/src/index.ts") },
    { find: /^@stammbuch\/db\/testing$/, replacement: src("../db/test/helpers.ts") },
  ],
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: { name: "memory", include: ["src/**/*.test.ts"], exclude: ["src/**/*.pg.test.ts"] },
      },
      {
        // Gegen PostgreSQL: startet einen eigenen, flüchtigen Container (siehe packages/db/test/global-setup.ts).
        resolve,
        test: {
          name: "postgres",
          include: ["src/**/*.pg.test.ts"],
          globalSetup: ["../db/test/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
