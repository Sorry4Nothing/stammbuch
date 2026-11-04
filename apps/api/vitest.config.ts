import { defineConfig } from "vitest/config";

export default defineConfig({
  // Die PostgreSQL-Tests (*.pg.test.ts) starten einen Docker-Container und legen je Test eine Datenbank an.
  test: { testTimeout: 30_000, hookTimeout: 120_000 },
});
