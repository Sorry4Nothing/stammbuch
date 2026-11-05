import type { Datenbank } from "@stammbuch/db";
import { sql } from "kysely";
import { createPostgresStoreOn } from "../accounting/postgres-store.js";
import { AccountingService } from "../accounting/service.js";
import { createAccountingPort } from "./accounting-port.js";
import { BillingError } from "./domain.js";
import { createPgRepositories, createPgRepositoriesOn } from "./pg-repository.js";
import type { AccountingPort } from "./repository.js";
import type { ServiceDeps } from "./service.js";

/** Fail secure: ohne Handelnden keine Buchung, die niemandem zugeordnet wäre. */
const noActor = (): Promise<never> =>
  Promise.reject(new BillingError(401, "Anmeldung erforderlich."));
const portWithoutActor: AccountingPort = {
  invoiceBooked: noActor,
  paymentRecorded: noActor,
  assertRevenueAccounts: noActor,
};

/**
 * Produktivverdrahtung mit Buchhaltung (#55): Rechnung und Buchung laufen in einer Transaktion des Kunden. Versenden,
 * Zahlung, Rückbuchung, Storno und Gutschrift buchen in die Buchhaltung; scheitert die Buchung (gesperrte Periode, unbekanntes
 * Konto, fehlende Kundennummer), wird alles zurückgerollt, auch die Rechnungsnummer.
 */
export function createPgDeps(
  db: Datenbank,
): Pick<ServiceDeps, "invoices" | "reminders" | "settings" | "transaction"> {
  const { invoices, reminders, settings } = createPgRepositories(db);
  return {
    invoices,
    reminders,
    settings,
    transaction: (tenantId, fn, userId) =>
      db.withKunde(tenantId, async (trx) => {
        // Reihenfolge wie beim CAMT-Import: zuerst die Buchhaltungssperre, dann Rechnungszeilen (kein Deadlock).
        if (userId) await sql`SELECT buchhaltung_sperre(${tenantId}::uuid)`.execute(trx);
        const accounting = new AccountingService(createPostgresStoreOn(trx));
        return fn({
          ...createPgRepositoriesOn(trx, tenantId),
          accounting: userId
            ? createAccountingPort(accounting, { tenantId, userId })
            : portWithoutActor,
        });
      }),
  };
}
