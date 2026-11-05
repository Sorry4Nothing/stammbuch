import type { AccountingService, Ctx } from "../accounting/service.js";
import { BillingError, type Invoice, type Payment } from "./domain.js";
import type { AccountingPort } from "./repository.js";

/** Gleiche Form wie die Personen-ID der Buchhaltung (`personId` in accounting/schemas.ts). */
const PERSON_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface AccountingPortOptions {
  /** Konto der flüssigen Mittel (10xx), auf dem eingehende Zahlungen verbucht werden. */
  bankAccountCode?: string;
}

/**
 * Bucht erfasste Zahlungen in der Buchhaltung (#8): Soll Bank, Haben Debitoren der Person (= Kundennummer der
 * Rechnung). Gibt es in der Buchhaltung einen offenen Posten mit der Rechnungsnummer als Referenz, wird die
 * Zahlung bis zu dessen Restbetrag zugeordnet; ein Überschuss bleibt als Guthaben auf dem Debitorenkonto stehen.
 * Ohne solchen Posten (Rechnung wurde nicht in der Buchhaltung gebucht) bleibt die ganze Zahlung Guthaben.
 *
 * Die Umsetzung läuft im Service der Buchhaltung und damit in derselben Transaktion wie die Rechnung, wenn dieser
 * auf einem transaktionsgebundenen Speicher aufgebaut ist (`createPostgresStoreOn`). Fehler der Buchhaltung
 * (`DomainError`, z. B. gesperrte Periode) und `BillingError` brechen den Vorgang ab; der Aufrufer rollt zurück.
 *
 * Offen: `invoiceBooked` ist nicht umgesetzt und wirft, bis die Verbuchung versendeter Rechnungen (Kontenzuordnung
 * der Positionen) entschieden ist; das Modul wird dafür nirgends eingehängt.
 */
export function createAccountingPort(
  accounting: AccountingService,
  ctx: Ctx,
  options: AccountingPortOptions = {},
): AccountingPort {
  const bankAccountCode = options.bankAccountCode ?? "1020";
  return {
    invoiceBooked: () =>
      Promise.reject(new Error("Verbuchung von Rechnungen ist nicht umgesetzt.")),

    async paymentRecorded(invoice: Invoice, payment: Payment) {
      const personId = invoice.customerId;
      if (!personId || !PERSON_ID.test(personId)) {
        throw new BillingError(
          422,
          "Die Rechnung hat keine buchbare Kundennummer; Zahlung kann nicht gebucht werden.",
        );
      }
      if (!Number.isSafeInteger(payment.amountCents) || payment.amountCents <= 0) {
        throw new BillingError(422, "Rückbuchungen sind in der Buchhaltung nicht umgesetzt.");
      }
      const reference = invoice.number ?? invoice.id;
      // Der Schlüssel macht eine Wiederholung derselben Zahlung folgenlos (Buchhaltung liefert das erste Ergebnis).
      const { result } = await accounting.bookPayment(ctx, {
        idempotencyKey: `invoice-payment:${payment.id}`,
        personId,
        bankAccountCode,
        valueDate: payment.paidOn,
        amount: payment.amountCents,
        reference,
      });
      const items = await accounting.listOpenItems(
        ctx,
        { personId, onlyOpen: true },
        { offset: 0, limit: 200 },
      );
      const item = items.find((i) => i.reference === reference && i.remaining > 0);
      if (!item) return;
      await accounting.allocate(ctx, {
        idempotencyKey: `invoice-payment-allocation:${payment.id}`,
        creditId: result.credit.id,
        allocations: [
          { openItemId: item.id, amount: Math.min(payment.amountCents, item.remaining) },
        ],
      });
    },
  };
}
