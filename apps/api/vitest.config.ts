import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Startet für die Integrationstests (*.int.test.ts) einen eigenen Wegwerf-Container.
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
