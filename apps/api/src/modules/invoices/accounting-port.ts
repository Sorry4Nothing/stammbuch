import type { AccountingService, Ctx } from "../accounting/service.js";
import {
  BillingError,
  DEFAULT_REVENUE_ACCOUNT,
  type Invoice,
  type InvoiceLine,
  MEMBERSHIP_REVENUE_ACCOUNT,
  type Payment,
} from "./domain.js";
import { lineNetCents } from "./money.js";
import type { AccountingPort } from "./repository.js";

/** Gleiche Form wie die Personen-ID der Buchhaltung (`personId` in accounting/schemas.ts). */
const PERSON_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface AccountingPortOptions {
  /** Konto der flüssigen Mittel (10xx), auf dem eingehende Zahlungen verbucht werden. */
  bankAccountCode?: string;
  /**
   * Erlöskonto für Positionen ohne eigenes Konto in normalen Rechnungen. Beim Versenden schreibt der Service das
   * Standardkonto des Mandanten in jede Position; diese Regel greift nur für Belege, die vor #67 versendet wurden
   * (Standardkontenplan: 3400 Erlös aus Dienstleistungen).
   */
  revenueAccountCode?: string;
  /** Wie `revenueAccountCode`, für Positionen von Sammelrechnungen, also Mitgliederbeiträge (3000). */
  membershipAccountCode?: string;
  /** Konto der geschuldeten Mehrwertsteuer (2200). */
  vatAccountCode?: string;
}

/**
 * Bucht Rechnungen und Zahlungen in der Buchhaltung (#8, #55, #67, #68).
 *
 * Versenden (`invoiceBooked`): Soll Debitoren der Person (= Kundennummer der Rechnung), Haben Erlöskonto(en) und Haben
 * Mehrwertsteuer; Buchungsdatum ist das Rechnungsdatum, der offene Posten trägt die Rechnungsnummer als
 * Referenz und die Fälligkeit der Rechnung. Eine Gutschrift bucht spiegelbildlich (Haben Debitoren) und wird dem
 * offenen Posten der Rechnung zugeordnet.
 *
 * Erlöskonto je Position (#67): jede Position bucht auf ihr Konto (`InvoiceLine.accountCode`), das Netto wird je Konto
 * summiert. Die Mehrwertsteuer (alle Sätze) steht gesammelt auf 2200, so wie sie der Beleg ausweist. Die Rappenrundung
 * des Belegs (höchstens wenige Rappen) wird dem Konto mit dem grössten Nettobetrag zugeschlagen, bei Gleichstand dem
 * ersten in der Reihenfolge der Positionen; so ist die Summe der Gegenzeilen immer der Belegbetrag und die Buchung
 * ausgeglichen. Positionen ohne Konto (Belege vor #67) folgen der früheren Regel: Sammelrechnung 3000, sonst 3400.
 *
 * Zahlung (`paymentRecorded`): Soll Bank, Haben Debitoren der Person. Gibt es einen offenen Posten mit der
 * Rechnungsnummer als Referenz, wird die Zahlung bis zu dessen Restbetrag zugeordnet; ein Überschuss bleibt als
 * Guthaben auf dem Debitorenkonto stehen. Eine Rückbuchung (negativer Betrag, #68) storniert die frühere Zahlung
 * spiegelbildlich (Soll Debitoren, Haben Bank), hebt deren Zuordnungen auf und öffnet den Posten wieder.
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
  const revenueAccountCode = options.revenueAccountCode ?? DEFAULT_REVENUE_ACCOUNT;
  const membershipAccountCode = options.membershipAccountCode ?? MEMBERSHIP_REVENUE_ACCOUNT;
  const vatAccountCode = options.vatAccountCode ?? "2200";

  const accountOf = (invoice: Invoice, line: InvoiceLine): string =>
    line.accountCode ?? (invoice.collectiveRunId ? membershipAccountCode : revenueAccountCode);

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

  /** Erlös je Konto (Netto samt Rappenrundung) und Mehrwertsteuer als Gegenzeilen; die Summe ist der Betrag des Belegs. */
  function counterLinesOf(invoice: Invoice) {
    const total = Math.abs(invoice.totals.totalCents);
    const vat = Math.abs(invoice.totals.vatCents);
    // Map behält die Reihenfolge der ersten Verwendung; Beträge sind positiv (Gutschriften buchen spiegelbildlich).
    const revenue = new Map<string, number>();
    for (const l of invoice.lines) {
      const code = accountOf(invoice, l);
      const net = Math.abs(lineNetCents(l.quantityMilli, l.unitCents));
      revenue.set(code, (revenue.get(code) ?? 0) + net);
    }
    const rounding = total - vat - [...revenue.values()].reduce((s, v) => s + v, 0);
    if (rounding !== 0) {
      let target: [string, number] | undefined;
      for (const e of revenue) if (!target || e[1] > target[1]) target = e;
      if (!target) throw new BillingError(422, "Der Beleg hat keine Positionen.");
      revenue.set(target[0], target[1] + rounding);
    }
    const lines = [...revenue].filter(([, amount]) => amount !== 0);
    if (lines.some(([, amount]) => amount < 0)) {
      throw new BillingError(
        422,
        "Die Rappenrundung lässt sich nicht auf die Erlöskonten verteilen.",
      );
    }
    return [
      ...lines.map(([accountCode, amount]) => ({ accountCode, amount })),
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

    async paymentRecorded(invoice: Invoice, payment: Payment, returned?: Payment) {
      const personId = personOf(invoice, "Zahlung");
      if (!Number.isSafeInteger(payment.amountCents) || payment.amountCents === 0) {
        throw new BillingError(422, "Ungültiger Zahlungsbetrag.");
      }
      const reference = invoice.number ?? invoice.id;
      if (payment.amountCents < 0) {
        if (returned?.amountCents !== -payment.amountCents) {
          throw new BillingError(422, "Die Rückbuchung gehört zu keiner erfassten Zahlung.");
        }
        // Schlüssel je Rückbuchung: eine Wiederholung bleibt folgenlos; die Zahlung lässt sich nur einmal zurückbuchen.
        await accounting.returnPayment(ctx, {
          idempotencyKey: `invoice-payment-return:${payment.id}`,
          paymentKey: `invoice-payment:${returned.id}`,
          bookingDate: payment.paidOn,
          reason: `Rückbuchung Zahlung ${reference}`,
        });
        return;
      }
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

    async entriesByKeys(keys: readonly string[]) {
      const [entries, chart] = await Promise.all([
        accounting.entriesByKeys(ctx, keys),
        accounting.listAccounts(ctx),
      ]);
      const names = new Map(chart.map((a) => [a.code, a.name]));
      return entries.map((e) => ({
        id: e.id,
        number: e.number,
        bookingDate: e.bookingDate,
        kind: e.kind,
        description: e.description,
        reversalOf: e.reversalOf,
        createdAt: e.createdAt,
        lines: e.lines.map((l) => ({
          accountCode: l.accountCode,
          accountName: names.get(l.accountCode) ?? "",
          side: l.side,
          amountCents: l.amount,
        })),
      }));
    },

    async assertRevenueAccounts(codes: readonly string[]) {
      const chart = await accounting.listAccounts(ctx);
      for (const code of codes) {
        const account = chart.find((a) => a.code === code);
        if (!account?.active || account.type !== "revenue") {
          throw new BillingError(422, `Konto ${code} ist kein aktives Erlöskonto im Kontenplan.`);
        }
      }
    },
  };
}
