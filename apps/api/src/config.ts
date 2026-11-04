import { z } from "zod";

const boolFromString = z.enum(["true", "false"]).transform((v) => v === "true");

/** Geheimnis aus der Umgebung: base64, mindestens 32 Byte (SR-30). */
const secret = z
  .string()
  .transform((v) => Buffer.from(v, "base64"))
  .refine((b) => b.length >= 32, "mindestens 32 Byte, base64-kodiert (openssl rand -base64 32)");

/** Umgebungsvariablen der API. Ungültige Werte brechen den Start ab (fail secure, SR-54). */
const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    // Verbindung als Rolle stammbuch_app (nie als Eigentümer, sonst greift die Mandantentrennung nicht).
    DATABASE_URL: z
      .string()
      .optional()
      .transform((v) => v || undefined),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    // Lokal nur Loopback; im Container setzt das Dockerfile HOST=0.0.0.0.
    HOST: z.string().min(1).default("127.0.0.1"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
    TRUST_PROXY: boolFromString.default(false),
    // Signiert Formular-Tokens der öffentlichen Registrierung. Gleicher Wert in jeder Instanz.
    FORM_SECRET: secret.optional(),
  })
  // Fail secure (SR-54): in Produktion nie ohne Datenbank starten.
  .refine((c) => c.NODE_ENV !== "production" || c.DATABASE_URL, {
    message: "DATABASE_URL fehlt (in Produktion Pflicht)",
    path: ["DATABASE_URL"],
  });

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema
    .refine((c) => !c.DATABASE_URL || c.FORM_SECRET, {
      message: "FORM_SECRET fehlt (nötig, sobald DATABASE_URL gesetzt ist)",
      path: ["FORM_SECRET"],
    })
    .parse(env);
}
