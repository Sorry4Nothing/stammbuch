import { z } from "zod";

const hours = (n: number) => n * 3_600_000;

/** Umgebungsvariablen des Auth-Moduls. Fehlende oder schwache Secrets brechen den Start ab (SR-30, SR-54). */
const authEnvSchema = z.object({
  // "id:geheimnis,id2:geheimnis2". Das erste ist aktuell, die übrigen nur zum Prüfen alter Hashes.
  AUTH_PEPPERS: z
    .string()
    .transform((v) => v.split(",").map((p) => p.trim()))
    .pipe(
      z
        .array(z.string().regex(/^[a-z0-9]{1,16}:\S{32,}$/))
        .min(1)
        .refine((a) => new Set(a.map((p) => p.split(":")[0])).size === a.length),
    )
    .transform((a) =>
      a.map((p) => {
        const i = p.indexOf(":");
        return { id: p.slice(0, i), secret: p.slice(i + 1) };
      }),
    ),
  // 32 Byte, base64. Erzeugen: openssl rand -base64 32
  AUTH_TOTP_KEY: z
    .string()
    .transform((v) => Buffer.from(v, "base64"))
    .refine((b) => b.length === 32, "AUTH_TOTP_KEY muss 32 Byte (base64) sein"),
  // Einzige erlaubte Origin der Oberfläche (CSRF-Prüfung, SR-70).
  APP_ORIGIN: z.url(),
  AUTH_ISSUER: z.string().min(1).default("Stammbuch"),
  // Engeres Limit pro IP für die Auth-Routen (SR-04); die Konto-Sperre kommt zusätzlich.
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  AUTH_SESSION_ABSOLUTE_HOURS: z.coerce.number().min(0.1).default(12),
  AUTH_SESSION_IDLE_HOURS: z.coerce.number().min(0.05).default(2),
});

export interface AuthConfig {
  peppers: { id: string; secret: string }[];
  totpKey: Buffer;
  appOrigin: string;
  issuer: string;
  rateLimitMax: number;
  sessionAbsoluteMs: number;
  sessionIdleMs: number;
  /** Zeit zwischen Passwort und zweitem Faktor. */
  pendingMs: number;
  /** Argon2id-Parameter; nie unter dem SR-01-Minimum (siehe password.ts). */
  argon2?: { memoryCost: number; timeCost: number; parallelism: number };
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const e = authEnvSchema.parse(env);
  return {
    peppers: e.AUTH_PEPPERS,
    totpKey: e.AUTH_TOTP_KEY,
    appOrigin: new URL(e.APP_ORIGIN).origin,
    issuer: e.AUTH_ISSUER,
    rateLimitMax: e.AUTH_RATE_LIMIT_MAX,
    sessionAbsoluteMs: hours(e.AUTH_SESSION_ABSOLUTE_HOURS),
    sessionIdleMs: hours(e.AUTH_SESSION_IDLE_HOURS),
    pendingMs: 10 * 60_000,
  };
}
