import { z } from "zod";
import { SecretBox, keyRingFromEnv } from "./crypto.js";
import { createMemoryRepositories } from "./memory.js";
import type { ConnectionFactory } from "./ports.js";
import type { ProcessorConfig } from "./processor.js";
import type { MailRepositories } from "./repositories.js";
import type { MailServiceConfig } from "./service.js";
import { createConnectionFactory } from "./transport.js";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");

/** Umgebungsvariablen des Mail-Moduls (API und Worker). */
const envSchema = z.object({
  /** "id:base64,id2:base64" mit je 32 Byte (z.B. `openssl rand -base64 32`). Fehlt sie, ist Mail aus. */
  MAIL_ENCRYPTION_KEYS: z.string().min(1).optional(),
  MAIL_ENCRYPTION_KEY_ID: z.string().min(1).optional(),
  // Nur Entwicklung: interne Mailserver erlauben (SSRF-Schutz aus). In Produktion verboten.
  MAIL_ALLOW_PRIVATE_HOSTS: bool.default(false),
  MAIL_RATE_PER_TENANT_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  MAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
  MAIL_MAX_ATTACHMENT_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(10 * 1024 * 1024),
  MAIL_MAX_RECIPIENTS: z.coerce.number().int().min(1).default(5000),
  NODE_ENV: z.string().optional(),
});

export interface MailRuntime {
  box: SecretBox;
  connections: ConnectionFactory;
  repos: MailRepositories;
  service: Partial<MailServiceConfig>;
  processor: Partial<ProcessorConfig>;
}

/**
 * Baut die Mail-Laufzeit aus der Umgebung. Gibt `null` zurück, wenn kein Schlüssel konfiguriert
 * ist (Mail bleibt aus statt mit schwachen Standardwerten zu laufen). Ungültige Werte werfen.
 * Persistenz: bis die Datenbank (#3) angebunden ist, In-Memory (Daten gehen beim Neustart verloren
 * und sind nicht zwischen API und Worker geteilt); `repos` austauschen, sobald SQL-Repositories da sind.
 */
export function createMailRuntime(
  env: NodeJS.ProcessEnv = process.env,
  repos: MailRepositories = createMemoryRepositories(),
): MailRuntime | null {
  // Leere Werte (z.B. aus einer .env-Vorlage) gelten als nicht gesetzt.
  const e = envSchema.parse({
    ...env,
    MAIL_ENCRYPTION_KEYS: env["MAIL_ENCRYPTION_KEYS"] || undefined,
    MAIL_ENCRYPTION_KEY_ID: env["MAIL_ENCRYPTION_KEY_ID"] || undefined,
  });
  if (!e.MAIL_ENCRYPTION_KEYS) return null;
  if (e.MAIL_ALLOW_PRIVATE_HOSTS && e.NODE_ENV === "production") {
    throw new Error("MAIL_ALLOW_PRIVATE_HOSTS ist in Produktion nicht erlaubt");
  }
  const ids = Object.keys(keyRingFromEnv(e.MAIL_ENCRYPTION_KEYS, "x").keys);
  const currentKeyId = e.MAIL_ENCRYPTION_KEY_ID ?? ids[ids.length - 1] ?? "";
  return {
    box: new SecretBox(keyRingFromEnv(e.MAIL_ENCRYPTION_KEYS, currentKeyId)),
    connections: createConnectionFactory({ allowPrivateHosts: e.MAIL_ALLOW_PRIVATE_HOSTS }),
    repos,
    service: {
      maxAttachmentBytes: e.MAIL_MAX_ATTACHMENT_BYTES,
      maxRecipients: e.MAIL_MAX_RECIPIENTS,
    },
    processor: {
      perTenantPerMinute: e.MAIL_RATE_PER_TENANT_PER_MINUTE,
      maxAttempts: e.MAIL_MAX_ATTEMPTS,
    },
  };
}
