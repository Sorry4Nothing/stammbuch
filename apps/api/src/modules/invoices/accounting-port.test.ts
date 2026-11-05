import { describe, expect, it } from "vitest";
import { DomainError } from "../accounting/domain.js";
import { createMemoryStore } from "../accounting/repository.js";
import { AccountingService } from "../accounting/service.js";
import { createAccountingPort } from "./accounting-port.js";
import {
  MemoryInvoiceRepository,
  MemoryReminderRepository,
  MemorySettingsRepository,
} from "./memory.js";
import { OTHER_TENANT, TENANT, invoiceInput, settingsInput } from "./test-fixtures.js";
import { InvoiceService } from "./service.js";

// Forderung beim Versenden (#55) mit der Buchhaltung im Speicher. Dieselben Fälle laufen gegen PostgreSQL in
// accounting.pg.test.ts.
const USER = "u1";
const NOW = new Date("2026-11-04T10:00:00Z");
const page = { offset: 0, limit: 100 };

function setup() {
  const store = createMemoryStore();
  const accounting = new AccountingService(store, () => NOW);
  const repos = {
    invoices: new MemoryInvoiceRepository(),
    reminders: new MemoryReminderRepository(),
    settings: new MemorySettingsRepository(),
  };
  const serviceFor = (tenantId: string) =>
    new InvoiceService({
      ...repos,
      accounting: createAccountingPort(accounting, { tenantId, userId: USER }),
      now: () => NOW,
    });
  const ctx = (tenantId: string) => ({ tenantId, userId: USER });
  return { accounting, serviceFor, ctx };
}

async function prepared(over = {}) {
  const s = setup();
  const service = s.serviceFor(TENANT);
  await service.saveSettings(TENANT, settingsInput(over));
  const send = async (input = {}) => {
    const d = await service.createDraft(TENANT, invoiceInput({ customerId: "K1", ...input }));
    return service.send(TENANT, d.invoice.id, USER);
  };
  const item = async (reference: string) =>
    (
      await s.accounting.listOpenItems(
        s.ctx(TENANT),
        { personId: "K1", onlyOpen: false, asOf: "2026-11-04" },
        page,
      )
    ).find((i) => i.reference === reference);
  const credits = () => s.accounting.openCredits(s.ctx(TENANT), { personId: "K1" });
  const balances = async (tenant = TENANT) =>
    Object.fromEntries(
      (await s.accounting.trialBalance(s.ctx(tenant), {})).rows
        .filter((r) => r.debit || r.credit)
        .map((r) => [r.code, [r.debit, r.credit]]),
    );
  return { ...s, service, send, item, credits, balances };
}

describe("Versenden bucht die Forderung", () => {
  it("Soll Debitoren, Haben Erlös und Mehrwertsteuer; offener Posten mit Rechnungsnummer und Fälligkeit", async () => {
    const t = await prepared();
    const v = await t.send();
    expect(v.invoice.totals.totalCents).toBe(26594);
    expect(v.invoice.number).toBe("RE-2026-0001");

    const entries = await t.accounting.listEntries(t.ctx(TENANT), {}, page);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "invoice", bookingDate: "2026-11-01" });
    expect(entries[0]?.lines).toEqual([
      { accountCode: "1100", side: "debit", amount: 26594, personId: "K1" },
      { accountCode: "3400", side: "credit", amount: 25500 },
      { accountCode: "2200", side: "credit", amount: 1094 },
    ]);
    expect(await t.item("RE-2026-0001")).toMatchObject({
      amount: 26594,
      remaining: 26594,
      status: "open",
      documentDate: "2026-11-01",
      dueDate: v.invoice.dueDate,
    });
    expect((await t.accounting.reconcileDebtors(t.ctx(TENANT))).difference).toBe(0);
  });

  it("Sammelrechnung bucht auf die Mitgliederbeiträge", async () => {
    const t = await prepared({ defaultVatMode: "none", defaultVatRateBp: 0 });
    await t.service.setFeatures(TENANT, { collectiveInvoicing: true });
    const run = await t.service.runCollective(TENANT, {
      runId: "lauf-2026",
      period: "Beitrag 2026",
      vatMode: "none",
      items: [
        {
          memberId: "m1",
          payerKey: "K1",
          payer: invoiceInput().debtor,
          description: "Beitrag Erika",
          amountCents: 6000,
        },
        {
          memberId: "m2",
          payerKey: "K1",
          payer: invoiceInput().debtor,
          description: "Beitrag Max",
          amountCents: 4000,
        },
      ],
    });
    await t.service.send(TENANT, run.created[0]!, USER);
    expect(await t.balances()).toEqual({ "1100": [10000, 0], "3000": [0, 10000] });
  });

  it("Rappenrundung geht in den Erlös; offener Posten entspricht dem Rechnungsbetrag", async () => {
    const line = (unitCents: number) => [
      { description: "Pos", quantityMilli: 1000, unitCents, vatRateBp: 0 },
    ];
    const t = await prepared({ roundTo5: true });
    await t.send({ lines: line(1003) }); // 10.03 -> 10.05
    await t.send({ lines: line(1002) }); // 10.02 -> 10.00
    expect(await t.item("RE-2026-0001")).toMatchObject({ amount: 1005 });
    expect(await t.item("RE-2026-0002")).toMatchObject({ amount: 1000 });
    expect(await t.balances()).toEqual({ "1100": [2005, 0], "3400": [0, 2005] });
  });

  it("ohne Kundennummer oder in Fremdwährung wird nicht versendet", async () => {
    const t = await prepared();
    for (const over of [{ customerId: undefined }, { customerId: "K 1!" }, { currency: "EUR" }]) {
      const d = await t.service.createDraft(TENANT, invoiceInput(over as never));
      await expect(t.service.send(TENANT, d.invoice.id, USER)).rejects.toMatchObject({
        statusCode: 422,
      });
      expect((await t.service.get(TENANT, d.invoice.id)).invoice.status).toBe("draft");
    }
    expect(await t.accounting.listEntries(t.ctx(TENANT), {}, page)).toEqual([]);
  });

  it("gesperrte Periode bricht das Versenden ab: Entwurf bleibt, nichts gebucht", async () => {
    const t = await prepared();
    await t.accounting.closePeriod(t.ctx(TENANT), "2026-10");
    const d = await t.service.createDraft(
      TENANT,
      invoiceInput({ customerId: "K1", issueDate: "2026-10-15" }),
    );
    const err = await t.service.send(TENANT, d.invoice.id, USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ code: "PERIOD_CLOSED" });
    const after = (await t.service.get(TENANT, d.invoice.id)).invoice;
    expect(after).toMatchObject({ status: "draft", number: null });
    expect(await t.accounting.listEntries(t.ctx(TENANT), {}, page)).toEqual([]);
  });

  it("abgelehnte Buchung (unbekanntes Erlöskonto) bricht ab", async () => {
    const s = setup();
    const service = new InvoiceService({
      invoices: new MemoryInvoiceRepository(),
      reminders: new MemoryReminderRepository(),
      settings: new MemorySettingsRepository(),
      accounting: createAccountingPort(
        s.accounting,
        { tenantId: TENANT, userId: USER },
        { revenueAccountCode: "3999" },
      ),
      now: () => NOW,
    });
    await service.saveSettings(TENANT, settingsInput());
    const d = await service.createDraft(TENANT, invoiceInput({ customerId: "K1" }));
    await expect(service.send(TENANT, d.invoice.id, USER)).rejects.toBeInstanceOf(DomainError);
    expect((await service.get(TENANT, d.invoice.id)).invoice.status).toBe("draft");
  });
});

describe("Zahlungen schliessen den offenen Posten", () => {
  const pay = (t: Awaited<ReturnType<typeof prepared>>, id: string, amountCents: number) =>
    t.service.recordPayment(TENANT, id, { amountCents, paidOn: "2026-11-03" }, USER);

  it("Zahlung in zwei Teilen: Restposten, dann bezahlt, kein Guthaben", async () => {
    const t = await prepared();
    const v = await t.send();
    await pay(t, v.invoice.id, 10000);
    expect(await t.item("RE-2026-0001")).toMatchObject({
      allocated: 10000,
      remaining: 16594,
      status: "partial",
    });
    await pay(t, v.invoice.id, 16594);
    expect(await t.item("RE-2026-0001")).toMatchObject({ remaining: 0, status: "paid" });
    expect(await t.credits()).toEqual([]);
    expect((await t.accounting.reconcileDebtors(t.ctx(TENANT))).difference).toBe(0);
    expect(await t.balances()).toMatchObject({ "1020": [26594, 0], "1100": [26594, 26594] });
  });

  it("Überzahlung: Posten bezahlt, Überschuss bleibt als Guthaben", async () => {
    const t = await prepared();
    const v = await t.send();
    await pay(t, v.invoice.id, 30000);
    expect(await t.item("RE-2026-0001")).toMatchObject({ remaining: 0, status: "paid" });
    expect(await t.credits()).toMatchObject([{ amount: 30000, available: 3406 }]);
    expect((await t.accounting.reconcileDebtors(t.ctx(TENANT))).difference).toBe(0);
  });

  it("Storno und Teilgutschrift gleichen den offenen Posten aus", async () => {
    const t = await prepared();
    const a = await t.send();
    const b = await t.send();
    await t.service.cancel(TENANT, a.invoice.id, USER);
    expect(await t.item("RE-2026-0001")).toMatchObject({ remaining: 0, status: "paid" });

    await t.service.credit(
      TENANT,
      b.invoice.id,
      [{ description: "Kulanz", quantityMilli: 1000, unitCents: 5000, vatRateBp: 0 }],
      undefined,
      USER,
    );
    expect(await t.item("RE-2026-0002")).toMatchObject({ allocated: 5000, remaining: 21594 });
    expect(await t.credits()).toEqual([]);
    expect((await t.accounting.reconcileDebtors(t.ctx(TENANT))).difference).toBe(0);
    // Erlös 25500 + 25500 - 25500 (Storno) - 5000 (Gutschrift ohne MwSt)
    const bal = await t.balances();
    expect(bal["3400"]).toEqual([30500, 51000]);
    expect(bal["2200"]).toEqual([1094, 2188]);
  });

  it("Mandantentrennung: Buchungen und Posten eines Mandanten sind für den anderen unsichtbar", async () => {
    const t = await prepared();
    await t.send();
    const other = t.serviceFor(OTHER_TENANT);
    await other.saveSettings(OTHER_TENANT, settingsInput());
    const d = await other.createDraft(OTHER_TENANT, invoiceInput({ customerId: "K1" }));
    // Der Mandant B sieht die Rechnung von A nicht, versenden scheitert mit 404 und bucht nichts.
    const foreign = (await t.service.list(TENANT, { limit: 10, offset: 0 })).items[0]!;
    await expect(other.send(OTHER_TENANT, foreign.invoice.id, USER)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(await t.accounting.listEntries(t.ctx(OTHER_TENANT), {}, page)).toEqual([]);
    await other.send(OTHER_TENANT, d.invoice.id, USER);
    expect(await t.balances(OTHER_TENANT)).toMatchObject({ "1100": [26594, 0] });
    expect((await t.balances())["1100"]).toEqual([26594, 0]);
    expect(
      await t.accounting.listOpenItems(
        t.ctx(OTHER_TENANT),
        { personId: "K1", onlyOpen: true },
        page,
      ),
    ).toHaveLength(1);
  });
});
