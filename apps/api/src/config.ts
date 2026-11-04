import { z } from "zod";

const boolFromString = z.enum(["true", "false"]).transform((v) => v === "true");

/** Umgebungsvariablen der API. Ungültige Werte brechen den Start ab (fail secure, SR-54). */
const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Lokal nur Loopback; im Container setzt das Dockerfile HOST=0.0.0.0.
  HOST: z.string().min(1).default("127.0.0.1"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  TRUST_PROXY: boolFromString.default(false),
  // Verbindung als Rolle stammbuch_app (nie Eigentümer, SR-10). Der Server startet ohne sie nicht.
  DATABASE_URL: z.string().min(1).optional(),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env);
}
