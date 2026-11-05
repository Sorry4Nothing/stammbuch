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

export const customerCreateSchema = z.object({
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
});
export type CustomerResponse = z.infer<typeof customerResponseSchema>;

export const chefAccountResponseSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
});
export const chefAccountUpdateSchema = z.object({ displayName: z.string().trim().min(1).max(120) });

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
