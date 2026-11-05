import { z } from "zod";
import { addressSchema, emailSchema, mwstNrSchema, phoneSchema, text, uidSchema } from "./swiss.js";

/** Personen-, Gruppen- und Firmenregister: Eingabe- und Ausgabeschemas (SR-20, SR-72, SR-74). */

export const memberTypes = ["einzel", "firma"] as const;
export const memberStatuses = ["aktiv", "archiviert"] as const;
export const firmaStatuses = [
  "ausstehend",
  "freigegeben",
  "abgelehnt",
  "zusammengefuehrt",
] as const;

const id = z.uuid();
const anrede = z.enum(["frau", "herr", "divers"]);

const personFields = {
  anrede: anrede.optional(),
  vorname: text(60),
  nachname: text(80),
  email: emailSchema.optional(),
  telefon: phoneSchema.optional(),
  mobil: phoneSchema.optional(),
  adresse: addressSchema.optional(),
  notiz: text(500).optional(),
};

/** Einzelmitglied oder Firmenmitglied (= Kontaktperson einer Firma aus dem Register). */
export const memberCreateSchema = z.discriminatedUnion("typ", [
  z.object({ typ: z.literal("einzel"), ...personFields }),
  z.object({
    typ: z.literal("firma"),
    firmaId: id,
    funktion: text(80).optional(),
    ...personFields,
  }),
]);
export type MemberCreate = z.infer<typeof memberCreateSchema>;

/** Änderung: `typ` ist nicht änderbar. `null` löscht ein optionales Feld. */
const nullable = <T extends z.ZodType>(s: T) => s.nullable().optional();
export const memberUpdateSchema = z.object({
  anrede: nullable(anrede),
  vorname: text(60).optional(),
  nachname: text(80).optional(),
  email: nullable(emailSchema),
  telefon: nullable(phoneSchema),
  mobil: nullable(phoneSchema),
  adresse: nullable(addressSchema),
  notiz: nullable(text(500)),
  funktion: nullable(text(80)),
  firmaId: id.optional(),
});
export type MemberUpdate = z.infer<typeof memberUpdateSchema>;

export const memberDtoSchema = z.object({
  id,
  typ: z.enum(memberTypes),
  status: z.enum(memberStatuses),
  anrede: anrede.nullable(),
  vorname: z.string(),
  nachname: z.string(),
  email: z.string().nullable(),
  telefon: z.string().nullable(),
  mobil: z.string().nullable(),
  adresse: addressSchema.nullable(),
  notiz: z.string().nullable(),
  funktion: z.string().nullable(),
  firmaId: id.nullable(),
  firmaName: z.string().nullable(),
  gruppeId: id.nullable(),
  erstelltAm: z.iso.datetime(),
  geaendertAm: z.iso.datetime(),
});
export type MemberDto = z.infer<typeof memberDtoSchema>;

export const LIST_LIMIT_MAX = 200;
const boolQuery = z.enum(["true", "false"]).transform((v) => v === "true");
export const memberListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(50),
  cursor: z.string().max(400).optional(),
  q: z.string().trim().max(100).optional(),
  typ: z.enum(memberTypes).optional(),
  status: z.enum(memberStatuses).default("aktiv"),
  gruppeId: id.optional(),
  firmaId: id.optional(),
  ohneGruppe: boolQuery.optional(),
});
export type MemberListQuery = z.infer<typeof memberListQuerySchema>;

export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const BULK_MAX = 500;
export const bulkActionSchema = z
  .object({
    ids: z.array(id).min(1).max(BULK_MAX),
    aktion: z.enum(["archivieren", "wiederherstellen", "gruppe_zuweisen", "gruppe_entfernen"]),
    gruppeId: id.optional(),
  })
  .refine((b) => b.aktion !== "gruppe_zuweisen" || b.gruppeId !== undefined, {
    message: "gruppeId fehlt",
    path: ["gruppeId"],
  });
export type BulkAction = z.infer<typeof bulkActionSchema>;

export const bulkResultSchema = z.object({
  ok: z.number().int(),
  fehler: z.array(z.object({ id, grund: z.enum(["NICHT_GEFUNDEN", "KONFLIKT"]) })),
});
export type BulkResult = z.infer<typeof bulkResultSchema>;

// Gruppen

export const gruppeInputSchema = z.object({ name: text(80) });
export const gruppeDtoSchema = z.object({
  id,
  name: z.string(),
  mitglieder: z.number().int(),
});
export type GruppeDto = z.infer<typeof gruppeDtoSchema>;

// Firmenregister

export const firmaCreateSchema = z.object({
  name: text(120),
  uid: uidSchema.optional(),
  mwstNr: mwstNrSchema.optional(),
  adresse: addressSchema,
  email: emailSchema.optional(),
  telefon: phoneSchema.optional(),
});
export type FirmaCreate = z.infer<typeof firmaCreateSchema>;

export const firmaUpdateSchema = z.object({
  name: text(120).optional(),
  uid: nullable(uidSchema),
  mwstNr: nullable(mwstNrSchema),
  adresse: addressSchema.optional(),
  email: nullable(emailSchema),
  telefon: nullable(phoneSchema),
});
export type FirmaUpdate = z.infer<typeof firmaUpdateSchema>;

export const firmaDtoSchema = z.object({
  id,
  name: z.string(),
  uid: z.string().nullable(),
  mwstNr: z.string().nullable(),
  adresse: addressSchema,
  email: z.string().nullable(),
  telefon: z.string().nullable(),
  status: z.enum(firmaStatuses),
  zusammengefuehrtMit: id.nullable(),
  erstelltAm: z.iso.datetime(),
});
export type FirmaDto = z.infer<typeof firmaDtoSchema>;

export const firmaListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(50),
  cursor: z.string().max(400).optional(),
  q: z.string().trim().max(100).optional(),
  status: z.enum(firmaStatuses).optional(),
});

export const duplicateCandidateSchema = z.object({
  firma: firmaDtoSchema,
  score: z.number().min(0).max(1),
  gruende: z.array(z.enum(["uid", "mwst", "name", "name_aehnlich", "adresse"])),
});
export type DuplicateCandidate = z.infer<typeof duplicateCandidateSchema>;

export const firmaMergeSchema = z.object({ quelleId: id });

// Öffentliche Registrierung (ohne Login). Honeypot `website` muss leer bleiben, `formToken` kommt
// vom Formular-Endpunkt und beweist eine Mindestwartezeit.
const botGuard = { website: z.string().max(200).optional(), formToken: z.string().max(200) };

export const publicPersonRegistrationSchema = z.object({
  ...botGuard,
  mitglied: memberCreateSchema.and(z.object({ email: emailSchema })),
});
export const publicFirmaRegistrationSchema = z.object({
  ...botGuard,
  firma: firmaCreateSchema.and(z.object({ email: emailSchema })),
});
export const registrationConfirmSchema = z.object({ token: z.string().min(20).max(100) });
export const registrationAcceptedSchema = z.object({ status: z.literal("bestaetigung_gesendet") });

export const publicFirmaOptionSchema = z.object({ id, name: z.string(), ort: z.string() });
export const publicFirmaSearchSchema = z.object({ q: z.string().trim().min(2).max(60) });
