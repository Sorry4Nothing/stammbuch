import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    // Wie in der Produktion (Proxy, gleiche Origin) erreicht die Oberfläche die API unter /auth.
    // API_PROXY_TARGET überschreibt das Ziel, wenn die API nicht auf 127.0.0.1:3000 läuft.
    proxy: {
      "^/auth/": loadEnv(mode, ".", "API_").API_PROXY_TARGET ?? "http://127.0.0.1:3000",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
}));
