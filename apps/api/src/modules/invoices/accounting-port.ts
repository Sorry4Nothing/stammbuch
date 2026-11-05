import type { AccountingService, Ctx } from "../accounting/service.js";
import { BillingError, type Invoice, type Payment } from "./domain.js";
import type { AccountingPort } from "./repository.js";

/** Gleiche Form wie die Personen-ID der Buchhaltung (`personId` in accounting/schemas.ts). */
const PERSON_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface AccountingPortOptions {
  /** Konto der flüssigen Mittel (10xx), auf dem eingehende Zahlungen verbucht werden. */
  bankAccountCode?: string;
  /** Erlöskonto der Positionen normaler Rechnungen (Standardkontenplan: 3400 Erlös aus Dienstleistungen). */
  revenueAccountCode?: string;
  /** Erlöskonto der Positionen von Sammelrechnungen, also Mitgliederbeiträgen (3000). */
  membershipAccountCode?: string;
  /** Konto der geschuldeten Mehrwertsteuer (2200). */
  vatAccountCode?: string;
}

/**
 * Bucht Rechnungen und Zahlungen in der Buchhaltung (#8, #55).
 *
 * Versenden (`invoiceBooked`): Soll Debitoren der Person (= Kundennummer der Rechnung), Haben Erlöskonto und Haben
 * Mehrwertsteuer; Buchungsdatum ist das Rechnungsdatum, der offene Posten trägt die Rechnungsnummer als
 * Referenz und die Fälligkeit der Rechnung. Eine Gutschrift bucht spiegelbildlich (Haben Debitoren) und wird dem
 * offenen Posten der Rechnung zugeordnet. Kontenzuordnung: Sammelrechnungen (Mitgliederbeiträge) gehen auf 3000,
 * alle anderen Rechnungen auf 3400; die Rappenrundung ist Teil des Erlöses. Je Beleg ein Erlöskonto: eine feinere
 * Zuordnung je Position ist später möglich, `accountOf` ist die einzige Stelle.
 *
 * Zahlung (`paymentRecorded`): Soll Bank, Haben Debitoren der Person. Gibt es einen offenen Posten mit der
 * Rechnungsnummer als Referenz, wird die Zahlung bis zu dessen Restbetrag zugeordnet; ein Überschuss bleibt als
 * Guthaben auf dem Debitorenkonto stehen.
 *
 * Die Umsetzung läuft im Service der Buchhaltung und damit in derselben Transaktion wie die Rechnung, wenn dieser
 * auf einem transaktionsgebundenen Speicher aufgebaut ist (`createPostgresStoreOn`). Fehler der Buchhaltung
 * (`DomainError`, z. B. gesperrte Periode) und `BillingError` brechen den Vorgang ab; der Aufrufer rollt zurück.
 */
export function createAccountingPort(
  accounting: AccountingService,
  ctx: Ctx,
  options: AccountingPortOptions = {},
): AccountingPort {
  const bankAccountCode = options.bankAccountCode ?? "1020";
  const revenueAccountCode = options.revenueAccountCode ?? "3400";
  const membershipAccountCode = options.membershipAccountCode ?? "3000";
  const vatAccountCode = options.vatAccountCode ?? "2200";

  // shortcut: ein Erlöskonto je Beleg, nicht je Position; Konto an der Position später hier je Position auflösen.
  const accountOf = (invoice: Invoice): string =>
    invoice.collectiveRunId ? membershipAccountCode : revenueAccountCode;

  function personOf(invoice: Invoice, what: string): string {
    const personId = invoice.customerId;
    if (!personId || !PERSON_ID.test(personId)) {
      throw new BillingError(
        422,
        `Die Rechnung hat keine buchbare Kundennummer; ${what} kann nicht gebucht werden.`,
      );
    }
    return personId;
  }

  /** Erlös (Netto samt Rappenrundung) und Mehrwertsteuer als Gegenzeilen; die Summe ist der Betrag des Belegs. */
  function counterLinesOf(invoice: Invoice) {
    const total = Math.abs(invoice.totals.totalCents);
    const vat = Math.abs(invoice.totals.vatCents);
    return [
      { accountCode: accountOf(invoice), amount: total - vat },
      ...(vat > 0 ? [{ accountCode: vatAccountCode, amount: vat }] : []),
    ];
  }

  async function openItemOf(personId: string, reference: string) {
    const items = await accounting.listOpenItems(
      ctx,
      { personId, onlyOpen: true },
      { offset: 0, limit: 200 },
    );
    return items.find((i) => i.reference === reference && i.remaining > 0);
  }

  return {
    async invoiceBooked(invoice: Invoice, original?: Invoice) {
      const reference = invoice.number;
      if (!reference) throw new BillingError(409, "Nur nummerierte Belege werden gebucht.");
      const personId = personOf(invoice, "der Beleg");
      if (invoice.currency !== "CHF") {
        throw new BillingError(
          422,
          "Die Buchhaltung führt nur CHF; der Beleg kann nicht gebucht werden.",
        );
      }
      // Ein Beleg über 0.00 begründet keine Forderung.
      if (invoice.totals.totalCents === 0) return;

      const isInvoice = invoice.kind === "invoice";
      const { result } = await accounting.postReceivable(ctx, {
        idempotencyKey: `invoice-booked:${invoice.id}`,
        kind: invoice.kind,
        personId,
        reference,
        bookingDate: invoice.issueDate,
        ...(isInvoice ? { dueDate: invoice.dueDate } : {}),
        counterLines: counterLinesOf(invoice),
      });

      // Gutschrift: dem offenen Posten der Rechnung zuordnen, soweit dort noch etwas offen ist.
      if (!isInvoice && original?.number && result.credit) {
        const item = await openItemOf(personId, original.number);
        if (!item) return;
        await accounting.allocate(ctx, {
          idempotencyKey: `credit-note-allocation:${invoice.id}`,
          creditId: result.credit.id,
          allocations: [
            { openItemId: item.id, amount: Math.min(result.credit.amount, item.remaining) },
          ],
        });
      }
    },

    async paymentRecorded(invoice: Invoice, payment: Payment) {
      const personId = personOf(invoice, "Zahlung");
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
      const item = await openItemOf(personId, reference);
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
