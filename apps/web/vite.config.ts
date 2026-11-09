import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => {
  const target = loadEnv(mode, ".", "API_").API_PROXY_TARGET ?? "http://127.0.0.1:3000";
  return {
    plugins: [react()],
    server: {
      // Wie in der Produktion (Proxy, gleiche Origin) erreicht die Oberfläche die API unter /auth und /api.
      // API_PROXY_TARGET überschreibt das Ziel, wenn die API nicht auf 127.0.0.1:3000 läuft.
      proxy: {
        "^/(auth|api|public|calendar/public)/": target,
        "^/invoices": target,
        "^/(mail)/": target,
      },
    },
    test: {
      // Höchstens 4 Worker-Prozesse: Unter Windows scheitert bei zu vielen gleichzeitigen Starts einzelner Worker (Exit 3221226505 / 3221225794), Issue #63.
      maxWorkers: 4,
      environment: "jsdom",
      setupFiles: ["./src/test-setup.ts"],
    },
  };
});
