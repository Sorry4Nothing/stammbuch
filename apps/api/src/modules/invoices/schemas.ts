import { z } from "zod";
import { MAX_QUANTITY_MILLI, MAX_UNIT_CENTS } from "./money.js";

/**
 * Eingabeschemas an der Vertrauensgrenze (SR-20). Alle Objekte sind strikt: unbekannte Felder
 * werden abgelehnt, nichts wird ungeprüft übernommen (SR-72). Längen begrenzen die Payload-Grösse.
 */
const text = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) => z.string().trim().max(max);

export const addressSchema = z.strictObject({
  name: text(70),
  street: optText(70).optional(),
  buildingNumber: optText(16).optional(),
  postalCode: text(16),
  town: text(35),
  country: z.string().regex(/^[A-Z]{2}$/),
});

/** Kontonummer des Kontenplans; ob sie im Kontenplan des Mandanten existiert, prüft der Service. */
const accountCode = z.string().regex(/^\d{4,6}$/);

export const lineInputSchema = z.strictObject({
  description: text(500),
  quantityMilli: z.number().int().min(1).max(MAX_QUANTITY_MILLI),
  unitCents: z.number().int().min(-MAX_UNIT_CENTS).max(MAX_UNIT_CENTS),
  /** Weglassen = Standardsatz des Mandanten (bei MwSt-pflichtiger Rechnung). */
  vatRateBp: z.number().int().min(0).max(2500).optional(),
  /** Erlöskonto der Position; weglassen = Standardkonto des Mandanten (#67). */
  accountCode: accountCode.optional(),
});

const isoDate = z.iso.date();

export const invoiceInputSchema = z.strictObject({
  customerId: optText(64).optional(),
  debtor: addressSchema,
  currency: z.enum(["CHF", "EUR"]).default("CHF"),
  issueDate: isoDate.optional(),
  dueDate: isoDate.optional(),
  vatMode: z.enum(["none", "exclusive"]).optional(),
  roundTo5: z.boolean().optional(),
  subject: optText(200).default(""),
  notes: optText(2000).default(""),
  lines: z.array(lineInputSchema).min(1).max(200),
});
export type InvoiceInput = z.infer<typeof invoiceInputSchema>;
export type LineInput = z.infer<typeof lineInputSchema>;

export const updateInvoiceSchema = invoiceInputSchema.extend({
  /** Zwingend: optimistisches Sperren gegen paralleles Bearbeiten. */
  version: z.number().int().min(1),
});

export const paymentInputSchema = z.strictObject({
  /** Negativ = Rückbuchung. */
  amountCents: z
    .number()
    .int()
    .refine((n) => n !== 0)
    .refine((n) => Math.abs(n) <= 99_999_999_999),
  paidOn: isoDate,
});

export const creditInputSchema = z.strictObject({
  /** Positive Beträge; die Gutschrift negiert sie selbst. */
  lines: z
    .array(lineInputSchema.extend({ unitCents: z.number().int().min(1).max(MAX_UNIT_CENTS) }))
    .min(1)
    .max(200),
  subject: optText(200).optional(),
});

export const listQuerySchema = z.strictObject({
  status: z.enum(["draft", "sent", "paid", "cancelled"]).optional(),
  kind: z.enum(["invoice", "credit_note"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export const idParamSchema = z.strictObject({ id: z.uuid() });
export const reminderParamSchema = z.strictObject({
  id: z.uuid(),
  level: z.coerce.number().int().min(1).max(10),
});

export const openItemsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const dunningQuerySchema = z.strictObject({ asOf: isoDate.optional() });
export const issueReminderSchema = z.strictObject({ asOf: isoDate.optional() });

const dunningLevelSchema = z.strictObject({
  level: z.number().int().min(1).max(10),
  title: text(60),
  waitDays: z.number().int().min(0).max(365),
  graceDays: z.number().int().min(1).max(365),
  feeCents: z.number().int().min(0).max(100_000),
});

export const settingsInputSchema = z.strictObject({
  creditor: addressSchema.extend({ country: z.enum(["CH", "LI"]) }),
  iban: z.string().trim().min(15).max(34),
  vatNumber: optText(40).nullable().default(null),
  contactLines: z.array(text(120)).max(4).default([]),
  numberPrefix: z
    .string()
    .regex(/^[A-Z]{1,6}$/)
    .default("RE"),
  creditNotePrefix: z
    .string()
    .regex(/^[A-Z]{1,6}$/)
    .default("GS"),
  referencePrefix: z
    .string()
    .regex(/^\d{0,10}$/)
    .default(""),
  paymentTermDays: z.number().int().min(0).max(365).default(30),
  defaultVatMode: z.enum(["none", "exclusive"]).default("exclusive"),
  defaultVatRateBp: z.number().int().min(0).max(2500).default(810),
  roundTo5: z.boolean().default(false),
  /** Standard-Erlöskonto für Positionen ohne eigenes Konto; weglassen = 3400. */
  defaultRevenueAccount: accountCode.nullable().default(null),
  dunning: z.strictObject({ levels: z.array(dunningLevelSchema).min(1).max(5) }).optional(),
});
export type SettingsInput = z.infer<typeof settingsInputSchema>;

/** Betrieb: nur die Lizenzverwaltung schaltet Module pro Kunde. */
export const featuresInputSchema = z.strictObject({ collectiveInvoicing: z.boolean() });

export const collectiveInputSchema = z.strictObject({
  /** Vom Aufrufer vergebene Lauf-ID: ein wiederholter Aufruf legt nichts doppelt an. */
  runId: z.uuid(),
  period: text(60),
  issueDate: isoDate.optional(),
  dueDate: isoDate.optional(),
  vatMode: z.enum(["none", "exclusive"]).default("none"),
  items: z
    .array(
      z.strictObject({
        memberId: text(64),
        /** Rechnungsempfänger; mehrere Mitglieder mit gleichem Schlüssel landen auf einer Rechnung. */
        payerKey: text(64),
        payer: addressSchema,
        description: text(300),
        amountCents: z.number().int().min(1).max(MAX_UNIT_CENTS),
      }),
    )
    .min(1)
    .max(5000),
});
export type CollectiveInput = z.infer<typeof collectiveInputSchema>;

// --- E-Mail, Storno, Export, Mahnstufen, Sammelrechnung nach Gruppen (#109) -------------------

/** Storno: Grund und Bemerkung landen auf der Gutschrift (Betreff bzw. Notiz) und damit im Verlauf. */
export const cancelInputSchema = z.strictObject({
  reason: optText(120).default(""),
  remark: optText(1000).default(""),
});

/** Versand eines Belegs per E-Mail. Der Text kommt vom Aufrufer (Vorlage der Oberfläche), der Server setzt keinen ein. */
export const emailInputSchema = z.strictObject({
  to: z.email().max(254),
  subject: text(200),
  message: optText(5000).default(""),
});

/** Ohne `ids` alle Rechnungen (ohne Gutschriften), sonst genau diese. */
export const exportInputSchema = z.strictObject({
  ids: z.array(z.uuid()).min(1).max(5000).optional(),
});

export const dunningSettingsSchema = z.strictObject({
  levels: z.array(dunningLevelSchema).min(1).max(5),
});

export const collectiveConfigSchema = z.strictObject({
  year: z.number().int().min(2000).max(2100),
  issueDate: isoDate,
  termDays: z.number().int().min(0).max(365),
  text: text(300),
  delivery: z.enum(["email-or-print", "email", "print"]),
  skipLeft: z.boolean(),
  skipNoFee: z.boolean(),
  groupIds: z.array(z.uuid()).max(500),
});

export const collectiveGroupRunSchema = z.strictObject({
  /** Vom Aufrufer vergebene Lauf-ID: ein wiederholter Aufruf legt nichts doppelt an. */
  runId: z.uuid(),
  config: collectiveConfigSchema,
  /** Vorab eine Musterrechnung (Entwurf der ersten Person) an diese Adresse senden; scheitert das, läuft nichts. */
  testMailTo: z.email().max(254).optional(),
  /** Mailtext der Rechnungen; `{number}` und `{amount}` ersetzt der Server je Rechnung. */
  mail: z.strictObject({ subject: text(200), message: optText(5000).default("") }).optional(),
});

export const groupFeeParamSchema = z.strictObject({ id: z.uuid() });
export const groupFeeSchema = z.strictObject({
  /** `null` entfernt den Beitrag (Gruppe ohne Beitrag). Bruttobetrag je Person in Rappen. */
  feeCents: z.number().int().min(1).max(MAX_UNIT_CENTS).nullable(),
});
