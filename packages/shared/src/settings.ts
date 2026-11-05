import { z } from "zod";

/** Einzeiliger, getrimmter Text mit Längengrenze. Leer erlaubt, wenn `required` fehlt. */
const text = (max: number, required = false) => {
  const s = z.string().trim().max(max);
  return required ? s.min(1) : s.default("");
};
const emailOrEmpty = z.union([z.literal(""), z.email().max(254)]).default("");

/** IBAN-Prüfsumme nach ISO 7064 (mod 97). */
function ibanChecksumOk(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const ch of digits) rest = (rest * 10 + Number(ch)) % 97;
  return rest === 1;
}

/** Schweizer/liechtensteinische IBAN (Leerzeichen erlaubt, Ausgabe ohne). */
export const swissIbanSchema = z
  .string()
  .transform((s) => s.replace(/\s+/g, "").toUpperCase())
  .pipe(z.string().regex(/^(CH|LI)\d{2}\d{5}[0-9A-Z]{12}$/))
  .refine(ibanChecksumOk);

/** QR-IBAN: Institut-ID (Stellen 5 bis 9) liegt zwischen 30000 und 31999. */
const qrIbanSchema = swissIbanSchema.refine((iban) => {
  const iid = Number(iban.slice(4, 9));
  return iid >= 30000 && iid <= 31999;
});

export const organisationSectionSchemas = {
  master: z.object({
    name: text(120, true),
    street: text(120),
    zip: text(10),
    city: text(80),
    country: z.string().trim().toUpperCase().length(2).default("CH"),
    uid: z.union([z.literal(""), z.string().regex(/^CHE-\d{3}\.\d{3}\.\d{3}$/)]).default(""),
    vatNumber: text(40),
    email: emailOrEmpty,
    phone: text(40),
    website: z.union([z.literal(""), z.httpUrl().max(200)]).default(""),
  }),
  sender: z.object({
    name: text(120),
    email: emailOrEmpty,
    replyTo: emailOrEmpty,
    footer: text(500),
  }),
  bank: z.object({
    bankName: text(120),
    iban: z.union([z.literal(""), swissIbanSchema]).default(""),
    qrIban: z.union([z.literal(""), qrIbanSchema]).default(""),
    bic: z
      .union([
        z.literal(""),
        z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9]{8}([A-Z0-9]{3})?$/),
      ])
      .default(""),
  }),
  "fiscal-year": z.object({
    /** Das Geschäftsjahr beginnt am 1. dieses Monats. */
    startMonth: z.number().int().min(1).max(12),
  }),
  modules: z.object({
    sammelrechnung: z.boolean(),
    mail: z.boolean(),
    kalender: z.boolean(),
  }),
} as const;

export type OrganisationSection = keyof typeof organisationSectionSchemas;
export const organisationSectionParamSchema = z.object({
  section: z.enum(["master", "sender", "bank", "fiscal-year", "modules"]),
});

export const organisationResponseSchema = z.object({
  master: organisationSectionSchemas.master,
  sender: organisationSectionSchemas.sender,
  bank: organisationSectionSchemas.bank,
  "fiscal-year": organisationSectionSchemas["fiscal-year"],
  modules: organisationSectionSchemas.modules,
  logo: z.object({ mime: z.string(), size: z.number(), updatedAt: z.string() }).nullable(),
});
export type OrganisationResponse = z.infer<typeof organisationResponseSchema>;

export const roleSchema = z.enum(["admin", "user"]);
export type Role = z.infer<typeof roleSchema>;

export const userCreateSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((s) => s.toLowerCase()),
  name: text(120, true),
  role: roleSchema,
});
export const userRoleSchema = z.object({ role: roleSchema });
export const idParamSchema = z.object({ id: z.uuid() });
export const userResponseSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  role: roleSchema,
  status: z.enum(["invited", "active"]),
  createdAt: z.string(),
});
export type UserResponse = z.infer<typeof userResponseSchema>;

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const auditFilterSchema = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  actor: z.string().trim().max(254).optional(),
  action: z.string().trim().max(80).optional(),
  q: z.string().trim().max(100).optional(),
});
export const auditQuerySchema = auditFilterSchema.extend(pageQuerySchema.shape);
export const auditEntryResponseSchema = z.object({
  // Kundenprotokoll: fortlaufende Nummer der Datenbank, Plattformprotokoll: UUID. Der Client nutzt sie nur als Schlüssel.
  id: z.string(),
  at: z.string(),
  actor: z.string(),
  action: z.string(),
  target: z.string(),
});
export type AuditEntryResponse = z.infer<typeof auditEntryResponseSchema>;

/** Zustand der Lizenz. `readOnly` und `blocked` sind abgeleitet und gelten für alle Schreibzugriffe. */
export const licenceResponseSchema = z.object({
  state: z.enum(["active", "expired", "suspended", "ended"]),
  validUntil: z.string(),
  readOnly: z.boolean(),
  blocked: z.boolean(),
});
export type LicenceResponse = z.infer<typeof licenceResponseSchema>;
