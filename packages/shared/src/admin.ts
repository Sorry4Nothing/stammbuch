import { z } from "zod";

const isoDate = z.iso.date();

export const customerStatusSchema = z.enum(["active", "suspended", "ended"]);

export const customerCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** Erste Person des Kunden (wird Admin des Kunden). Sie erhält die Einladung. */
  contactEmail: z
    .email()
    .max(254)
    .transform((s) => s.toLowerCase()),
  licenceValidUntil: isoDate,
});
export const customerUpdateSchema = z
  .object({ name: z.string().trim().min(1).max(120), licenceValidUntil: isoDate })
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
});

/** Vertragsdaten eines Kunden. Enthält bewusst keine Daten aus dem Betrieb des Kunden. */
export const customerResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
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
