import type { Database } from "@stammbuch/db";
import { type Transaction, sql } from "kysely";
import { AccountingService } from "../accounting/service.js";
import { DomainError } from "../accounting/domain.js";
import { createPostgresStoreOn } from "../accounting/postgres-store.js";
import { createAccountingPort } from "./accounting-port.js";
import { BillingError } from "./domain.js";
import { createPgRepositoriesOn } from "./pg-repository.js";
import { InvoiceService } from "./service.js";

export interface BankPayment {
  /** Negativ = Rückbuchung einer früheren Zahlung (Rücklastschrift, Bankstorno, #68). */
  amountRappen: number;
  currency: string;
  /** Buchungsdatum der Bank (ISO), wird zum Zahlungsdatum der Rechnung. */
  bookingDate: string;
}

export type PaymentOutcome =
  | "ASSIGNED"
  /** Rechnung existiert für diesen Kunden nicht. */
  | "NOT_FOUND"
  /** Gutschrift, Entwurf, bezahlt oder storniert: nichts mehr offen. */
  | "NOT_OPEN"
  | "CURRENCY_MISMATCH"
  /** Nur mit `expectOpenRappen`: der offene Betrag ist nicht mehr der erwartete. */
  | "AMOUNT_CHANGED"
  /** Rechnung oder Buchhaltung lehnt die Zahlung ab (z. B. gesperrte Periode, Konflikt). */
  | "REJECTED";

/**
 * Zahlungs-Port des Rechnungsmoduls für den CAMT-Import: erfasst eine Bankzahlung auf einer Rechnung und bucht sie
 * in der Buchhaltung, beides auf der übergebenen Transaktion des Kunden (kein eigenes Commit). Der Aufrufer
 * entscheidet über Commit oder Rollback; bei `REJECTED` können Teile bereits geschrieben sein und müssen verworfen
 * werden (Savepoint oder Rollback).
 *
 * Teilzahlung: die Rechnung bleibt versendet, der Rest bleibt offen. Überzahlung: die Rechnung gilt als bezahlt,
 * der Überschuss bleibt in der Buchhaltung als nicht zugeordnetes Guthaben. Mit `expectOpenRappen` (automatische
 * Zuordnung) wird nur gebucht, wenn genau dieser Betrag offen ist.
 */
export async function recordBankPayment(
  trx: Transaction<Database>,
  who: { tenantId: string; userId: string },
  invoiceId: string,
  payment: BankPayment,
  options: { expectOpenRappen?: number } = {},
): Promise<PaymentOutcome> {
  const { tenantId, userId } = who;
  // Immer zuerst die Buchhaltungssperre, dann die Rechnungszeile: gleiche Reihenfolge in allen parallelen
  // Importen, damit sie sich nicht gegenseitig blockieren (Deadlock).
  await sql`SELECT buchhaltung_sperre(${tenantId}::uuid)`.execute(trx);
  const accounting = new AccountingService(createPostgresStoreOn(trx));
  const service = new InvoiceService(
    {
      ...createPgRepositoriesOn(trx, tenantId),
      accounting: createAccountingPort(accounting, { tenantId, userId }),
    },
    true, // bereits in einer Transaktion
  );
  try {
    const current = await service.get(tenantId, invoiceId);
    const { invoice } = current;
    // Zahlungen gehen nur auf offene Rechnungen. Eine Rückbuchung trifft meist eine bezahlte; ob genau diese
    // Zahlung noch zurückzubuchen ist, prüft `recordPayment`.
    const returning = payment.amountRappen < 0;
    if (
      invoice.kind !== "invoice" ||
      (returning
        ? invoice.status !== "sent" && invoice.status !== "paid"
        : invoice.status !== "sent" || current.openCents <= 0)
    ) {
      return "NOT_OPEN";
    }
    if (invoice.currency !== payment.currency) return "CURRENCY_MISMATCH";
    if (
      !returning &&
      options.expectOpenRappen !== undefined &&
      current.openCents !== options.expectOpenRappen
    ) {
      return "AMOUNT_CHANGED";
    }
    await service.recordPayment(
      tenantId,
      invoiceId,
      { amountCents: payment.amountRappen, paidOn: payment.bookingDate },
      userId,
    );
    return "ASSIGNED";
  } catch (err) {
    if (err instanceof BillingError) return err.statusCode === 404 ? "NOT_FOUND" : "REJECTED";
    if (err instanceof DomainError) return "REJECTED";
    throw err;
  }
}
