import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.pg.test.ts", "node_modules"],
        },
      },
      {
        // Echte Datenbank: eigener Wegwerf-Container, siehe packages/db/README.md (Tests).
        test: {
          name: "db",
          include: ["src/**/*.pg.test.ts"],
          globalSetup: ["./test/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
