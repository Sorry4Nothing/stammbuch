import { z } from "zod";

const boolFromString = z.enum(["true", "false"]).transform((v) => v === "true");

/** Umgebungsvariablen der API. Ungültige Werte brechen den Start ab (fail secure, SR-54). */
const envSchema = z.object({
  // Verbindung der Rolle stammbuch_app (nie der Eigentümer, SR-10). Ohne Wert startet die API nicht (SR-54).
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Lokal nur Loopback; im Container setzt das Dockerfile HOST=0.0.0.0.
  HOST: z.string().min(1).default("127.0.0.1"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  TRUST_PROXY: boolFromString.default(false),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env);
}
