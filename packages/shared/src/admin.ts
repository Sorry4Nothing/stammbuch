import { z } from "zod";

const isoDate = z.iso.date();

export const customerStatusSchema = z.enum(["active", "suspended", "ended"]);

/** Öffentliche Kennung (`/public/<slug>/…`). Muss zum CHECK in `kunde.slug` passen. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Kennungen, die nie an Kunden gehen, damit sie nicht mit festen Pfaden kollidieren. */
export const RESERVED_SLUGS: readonly string[] = [
  "admin",
  "api",
  "assets",
  "auth",
  "health",
  "public",
  "static",
  "www",
];
export const slugSchema = z
  .string()
  .regex(SLUG_PATTERN)
  .refine((s) => !RESERVED_SLUGS.includes(s));

/** Vorschlag aus dem Kundennamen: Umlaute umschreiben, Akzente weg, Rest zu `-`, höchstens 63 Zeichen. */
export function slugFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 63)
    .replace(/^-+|-+$/g, "");
  return slug || "kunde";
}

/** n-ter Versuch bei Kollision: 1 ist der Grundname, danach `-2`, `-3`, … (Länge bleibt ≤ 63). */
export function slugCandidate(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  return `${base.slice(0, 63 - suffix.length).replace(/-+$/, "")}${suffix}`;
}

/** Module, die der Anbieter pro Lizenz freischaltet. Personen, Rechnungen, Buchhaltung und Auswertungen gehören immer dazu. */
export const LICENCE_MODULES = ["sammelrechnung", "mail", "kalender"] as const;
export const licenceModuleSchema = z.enum(LICENCE_MODULES);
export type LicenceModule = z.infer<typeof licenceModuleSchema>;
const licenceModulesSchema = z
  .array(licenceModuleSchema)
  .max(LICENCE_MODULES.length)
  .refine((m) => new Set(m).size === m.length);

export const customerCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    /** Optional: überschreibt den Vorschlag aus dem Namen. */
    slug: slugSchema.optional(),
    /** Erste Person des Kunden (wird Admin des Kunden). Sie erhält die Einladung. */
    contactEmail: z
      .email()
      .max(254)
      .transform((s) => s.toLowerCase()),
    /** Optional: Name des ersten Admins, sonst der Teil der Adresse vor dem @. */
    contactName: z.string().trim().min(1).max(120).optional(),
    licenceValidUntil: isoDate,
    /** Optional: Beginn der Lizenz, nicht nach dem Ende. Ohne Angabe: Tag der Anlage. */
    licenceStart: isoDate.optional(),
    /** Optional: freigeschaltete Module. Ohne Angabe: keines. */
    modules: licenceModulesSchema.optional(),
  })
  .refine((v) => !v.licenceStart || v.licenceStart <= v.licenceValidUntil, {
    path: ["licenceStart"],
  });
export const customerUpdateSchema = z
  .object({ name: z.string().trim().min(1).max(120), licenceValidUntil: isoDate, slug: slugSchema })
  .partial()
  .refine((v) => Object.keys(v).length > 0);
export const customerListQuerySchema = z.object({
  status: customerStatusSchema.optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export const resendInvitationSchema = z.object({
  contactEmail: z
    .email()
    .max(254)
    .transform((s) => s.toLowerCase()),
  contactName: z.string().trim().min(1).max(120).optional(),
});

/** Vertragsdaten eines Kunden. Enthält bewusst keine Daten aus dem Betrieb des Kunden. */
export const customerResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** `null` bei Kunden, die vor der automatischen Vergabe angelegt wurden. */
  slug: z.string().nullable(),
  status: customerStatusSchema,
  licenceValidUntil: z.string(),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
  invitation: z
    .object({ email: z.string(), status: z.enum(["pending", "accepted", "expired"]) })
    .nullable(),
  /** Fortlaufende Lizenznummer (L-0001); `null` bei Altkunden. */
  licenceNumber: z.string().nullable(),
  /** Beginn der Lizenz (JJJJ-MM-TT); `null`, wenn der Vertrag ihn nicht kennt. */
  licenceStart: z.string().nullable(),
  /** Freigeschaltete Module; `null`, wenn der Vertrag sie nicht kennt (Altkunden). */
  modules: z.array(licenceModuleSchema).nullable(),
  /** Anzahl aktiver Benutzer des Kunden (nur die Zahl, nie Namen). */
  userCount: z.number().int().min(0),
});
export type CustomerResponse = z.infer<typeof customerResponseSchema>;

/**
 * Benutzer eines Kunden aus Sicht des Anbieters: nur was der Support braucht (Name, E-Mail, Stand des zweiten
 * Faktors, letzte Anmeldung). Nie Hashes, Geheimnisse, Codes oder Kundendaten.
 */
export const customerUserResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  totp: z.enum(["set", "missing"]),
  lastLogin: z.string().nullable(),
});
export type CustomerUserResponse = z.infer<typeof customerUserResponseSchema>;

export const chefAccountResponseSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
});
export const chefAccountUpdateSchema = z.object({ displayName: z.string().trim().min(1).max(120) });

/**
 * Sicherheitsstand des eigenen Kontos (Design 10.6). Nur Zeitpunkte und Zahlen, nie Geheimnisse oder Codes.
 * `null`: der Zeitpunkt ist nicht bekannt (z. B. Passwort seit der Einrichtung nie geändert).
 */
export const chefSecurityResponseSchema = z.object({
  passwordChangedAt: z.string().nullable(),
  totpSetUpAt: z.string().nullable(),
  recoveryCodes: z.object({ unused: z.number().int().min(0), total: z.number().int().min(1) }),
  /** Offene Sitzungen, neueste zuerst. `current`: die Sitzung dieser Anfrage. */
  sessions: z.array(
    z.object({
      id: z.uuid(),
      since: z.string(),
      current: z.boolean(),
      /** Kurze Gerätebezeichnung («Firefox auf Windows»); `null`: unbekannt. */
      device: z.string().nullable(),
    }),
  ),
  /** Letzte Anmeldungen und Fehlversuche, neueste zuerst. `method`: Code der Art. */
  logins: z.array(
    z.object({
      id: z.string(),
      at: z.string(),
      method: z.enum(["totp", "recovery", "setup", "password_failed", "code_failed"]),
      success: z.boolean(),
    }),
  ),
});
export type ChefSecurityResponse = z.infer<typeof chefSecurityResponseSchema>;

/** Ergebnis eines Rotationslaufs. `failed` sind IDs unlesbarer Objekte, nie Schlüssel oder Klartext. */
export const rotationOutcomeSchema = z.object({
  rotated: z.number().int().min(0),
  failed: z.array(z.uuid()),
  aborted: z.boolean(),
});
/** `null`: für diese Art ist kein Schlüsselring konfiguriert. */
export const rotationRunResponseSchema = z.object({
  mail: rotationOutcomeSchema.nullable(),
  totp: rotationOutcomeSchema.nullable(),
});
export const rotationStatusSchema = z.object({
  configured: z.boolean(),
  lastRunAt: z.string().nullable(),
  unreadable: z.array(z.uuid()),
});
export const rotationStatusResponseSchema = z.object({
  mail: rotationStatusSchema,
  totp: rotationStatusSchema,
});
