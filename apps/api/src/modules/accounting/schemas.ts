import { z } from "zod";
import { MAX_AMOUNT, MAX_LINES, TAX_RATES_BP, isIsoDate } from "./domain.js";

/**
 * Eingabeschemas der Buchhaltung. `strictObject` weist unbekannte Felder ab (SR-72), alle
 * Texte und Listen sind in der Länge begrenzt (SR-20, SR-71). Beträge sind ganze Rappen.
 */
export const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);
export const isoDate = z.string().refine(isIsoDate);
export const amount = z.number().int().positive().max(MAX_AMOUNT);
export const accountCode = z.string().regex(/^\d{4,6}$/);
export const personId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const uuid = z.uuid();
export const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const reference = z.string().trim().min(1).max(60);
const description = z.string().trim().min(1).max(200);
const reason = z.string().trim().min(3).max(150);

export const entryLineInput = z.strictObject({
  accountCode,
  side: z.enum(["debit", "credit"]),
  amount,
  personId: personId.optional(),
});

export const manualEntryInput = z.strictObject({
  idempotencyKey,
  bookingDate: isoDate,
  description,
  lines: z.array(entryLineInput).min(2).max(MAX_LINES),
});
export type ManualEntryInput = z.infer<typeof manualEntryInput>;

const counterLine = z.strictObject({ accountCode, amount });

export const receivableInput = z
  .strictObject({
    idempotencyKey,
    kind: z.enum(["invoice", "credit_note"]),
    personId,
    reference,
    bookingDate: isoDate,
    dueDate: isoDate.optional(),
    description: description.optional(),
    /** Gegenkonten: Erlös, Erlösminderung und Mehrwertsteuer als eigene Zeilen. */
    counterLines: z.array(counterLine).min(1).max(50),
  })
  .refine((v) => (v.kind === "invoice" ? !!v.dueDate && v.dueDate >= v.bookingDate : !v.dueDate));
export type ReceivableInput = z.infer<typeof receivableInput>;

export const paymentInput = z.strictObject({
  idempotencyKey,
  personId,
  bankAccountCode: accountCode,
  valueDate: isoDate,
  amount,
  reference,
});
export type PaymentInput = z.infer<typeof paymentInput>;

export const reverseEntryInput = z.strictObject({ idempotencyKey, bookingDate: isoDate, reason });
export type ReverseEntryInput = z.infer<typeof reverseEntryInput>;

/** `paymentKey`: Idempotenzschlüssel der ursprünglichen Zahlungsbuchung (`bookPayment`). */
export const returnPaymentInput = z.strictObject({
  idempotencyKey,
  paymentKey: idempotencyKey,
  bookingDate: isoDate,
  reason,
});
export type ReturnPaymentInput = z.infer<typeof returnPaymentInput>;

export const allocateInput = z.strictObject({
  idempotencyKey,
  creditId: uuid,
  allocations: z
    .array(z.strictObject({ openItemId: uuid, amount }))
    .min(1)
    .max(50),
});
export type AllocateInput = z.infer<typeof allocateInput>;

export const idempotentOnly = z.strictObject({ idempotencyKey });
export const reopenPeriodInput = z.strictObject({ reason });
const accountName = z.string().trim().min(2).max(100);
export const renameAccountInput = z.strictObject({ name: accountName });
/** Steuersatz in Basispunkten (8.1 %, 2.6 %, 3.8 %); `null` entfernt ihn. */
const taxRateBp = z.union([
  z.literal(TAX_RATES_BP[0]),
  z.literal(TAX_RATES_BP[1]),
  z.literal(TAX_RATES_BP[2]),
]);
/** Konto ändern: Bezeichnung und/oder Steuersatz, mindestens eines von beiden. */
export const updateAccountInput = z
  .strictObject({ name: accountName.optional(), taxRateBp: taxRateBp.nullable().optional() })
  .refine((v) => v.name !== undefined || v.taxRateBp !== undefined);
export type UpdateAccountInput = z.infer<typeof updateAccountInput>;
export const createAccountInput = z.strictObject({
  code: accountCode,
  name: accountName,
  type: z.enum(["asset", "liability", "equity", "revenue", "expense"]),
  taxRateBp: taxRateBp.optional(),
});
export type CreateAccountInput = z.infer<typeof createAccountInput>;

export const pageQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
