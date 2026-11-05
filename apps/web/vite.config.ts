import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    // Höchstens 4 Worker-Prozesse: Unter Windows scheitert bei zu vielen gleichzeitigen Starts einzelner Worker (Exit 3221226505 / 3221225794), Issue #63.
    maxWorkers: 4,
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
