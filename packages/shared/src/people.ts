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

export const kanaele = ["email", "post"] as const;
const kanal = z.enum(kanaele);

const MIN_DATE = "1900-01-01";
const MAX_DATE = "2100-12-31";
const isoDate = z.iso
  .date()
  .refine((d) => d >= MIN_DATE && d <= MAX_DATE, "Datum ausserhalb des gültigen Bereichs");
/** Geburtsdatum: nicht in der Zukunft. */
const birthDate = isoDate.refine(
  (d) => d <= new Date().toISOString().slice(0, 10),
  "Datum liegt in der Zukunft",
);

const personFields = {
  anrede: anrede.optional(),
  vorname: text(60),
  nachname: text(80),
  email: emailSchema.optional(),
  telefon: phoneSchema.optional(),
  mobil: phoneSchema.optional(),
  adresse: addressSchema.optional(),
  notiz: text(500).optional(),
  geburtsdatum: birthDate.optional(),
  eintritt: isoDate.optional(),
  kanal: kanal.optional(),
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
  geburtsdatum: nullable(birthDate),
  eintritt: nullable(isoDate),
  kanal: nullable(kanal),
  funktion: nullable(text(80)),
  firmaId: id.optional(),
});
export type MemberUpdate = z.infer<typeof memberUpdateSchema>;

export const memberDtoSchema = z.object({
  id,
  mitgliedsnr: z.string(),
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
  geburtsdatum: z.string().nullable(),
  eintritt: z.string().nullable(),
  kanal: kanal.nullable(),
  funktion: z.string().nullable(),
  firmaId: id.nullable(),
  firmaName: z.string().nullable(),
  gruppeId: id.nullable(),
  gruppeSeit: z.iso.datetime().nullable(),
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

/** `total`: Gesamtzahl der Treffer des Filters, unabhängig von Seite und Cursor. */
export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable(), total: z.number().int() });

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

export const gruppeInputSchema = z.object({
  name: text(80),
  /** `null` löscht die Beschreibung; fehlt das Feld, bleibt sie unverändert. */
  beschreibung: nullable(text(300)),
});
/** Teiländerung: mindestens ein Feld. */
export const gruppeUpdateSchema = z
  .object({ name: text(80).optional(), beschreibung: nullable(text(300)) })
  .refine((g) => g.name !== undefined || g.beschreibung !== undefined, {
    message: "Mindestens ein Feld ist nötig.",
  });
export const gruppeDtoSchema = z.object({
  id,
  name: z.string(),
  mitglieder: z.number().int(),
  beschreibung: z.string().nullable(),
  erstelltAm: z.iso.datetime(),
  geaendertAm: z.iso.datetime(),
  /** Namen der Adresslisten, die die Gruppe nutzen. */
  adresslisten: z.array(z.string()),
});
export type GruppeDto = z.infer<typeof gruppeDtoSchema>;

// Firmenregister

export const firmaQuellen = ["manuell", "selbst"] as const;

export const firmaCreateSchema = z.object({
  name: text(120),
  uid: uidSchema.optional(),
  mwstNr: mwstNrSchema.optional(),
  adresse: addressSchema,
  email: emailSchema.optional(),
  telefon: phoneSchema.optional(),
  kontaktperson: text(120).optional(),
  rechnungsEmail: emailSchema.optional(),
  notiz: text(500).optional(),
});
export type FirmaCreate = z.infer<typeof firmaCreateSchema>;

export const firmaUpdateSchema = z.object({
  name: text(120).optional(),
  uid: nullable(uidSchema),
  mwstNr: nullable(mwstNrSchema),
  adresse: addressSchema.optional(),
  email: nullable(emailSchema),
  telefon: nullable(phoneSchema),
  kontaktperson: nullable(text(120)),
  rechnungsEmail: nullable(emailSchema),
  notiz: nullable(text(500)),
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
  kontaktperson: z.string().nullable(),
  status: z.enum(firmaStatuses),
  zusammengefuehrtMit: id.nullable(),
  erstelltAm: z.iso.datetime(),
  rechnungsEmail: z.string().nullable(),
  notiz: z.string().nullable(),
  quelle: z.enum(firmaQuellen),
  /** Anzahl aktiver Firmenmitglieder. */
  mitglieder: z.number().int(),
});
export type FirmaDto = z.infer<typeof firmaDtoSchema>;

export const firmaListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(50),
  cursor: z.string().max(400).optional(),
  q: z.string().trim().max(100).optional(),
  status: z.enum(firmaStatuses).optional(),
  quelle: z.enum(firmaQuellen).optional(),
});

export const duplicateCandidateSchema = z.object({
  firma: firmaDtoSchema,
  score: z.number().min(0).max(1),
  gruende: z.array(z.enum(["uid", "mwst", "name", "name_aehnlich", "adresse"])),
});
export type DuplicateCandidate = z.infer<typeof duplicateCandidateSchema>;

export const firmaMergeSchema = z.object({ quelleId: id });

// Duplikate über das ganze Firmenregister. Die Kennung eines Paars ist `<idA>_<idB>` (idA < idB).
export const duplikatFelder = [
  "name",
  "uid",
  "mwstNr",
  "strasse",
  "plzOrt",
  "email",
  "telefon",
] as const;
export const duplikatIdSchema = z.string().regex(/^[0-9a-f-]{36}_[0-9a-f-]{36}$/);

const duplikatEintragSchema = z.object({
  id,
  name: z.string(),
  /** Anzahl aktiver Firmenmitglieder. */
  mitglieder: z.number().int(),
  felder: z.partialRecord(z.enum(duplikatFelder), z.string()),
});
export const duplikatDtoSchema = z.object({
  id: duplikatIdSchema,
  art: z.literal("firma"),
  a: duplikatEintragSchema,
  b: duplikatEintragSchema,
  trefferBei: z.array(z.enum(["name", "uid", "mwst"])),
  /** 0 bis 100. */
  aehnlichkeit: z.number().int().min(0).max(100),
  status: z.enum(["offen", "kein_duplikat"]),
});
export type DuplikatDto = z.infer<typeof duplikatDtoSchema>;

/** Je Feld: Wert der behaltenen (`behalten`) oder der entfernten Firma (`entfernen`) übernehmen. */
export const duplikatMergeSchema = z.object({
  behaltenId: id,
  werte: z.partialRecord(z.enum(duplikatFelder), z.enum(["behalten", "entfernen"])),
});
export type DuplikatMerge = z.infer<typeof duplikatMergeSchema>;

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
/** `referenz`: Zufallscode für Rückfragen, auch bei bereits bekannter E-Mail (keine Nutzer-Enumeration). */
export const registrationAcceptedSchema = z.object({
  status: z.literal("bestaetigung_gesendet"),
  referenz: z.string(),
});

export const publicFirmaOptionSchema = z.object({ id, name: z.string(), ort: z.string() });
export const publicFirmaSearchSchema = z.object({ q: z.string().trim().min(2).max(60) });
