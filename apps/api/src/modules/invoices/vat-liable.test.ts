import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../accounting/repository.js";
import { AccountingService } from "../accounting/service.js";
import { createAccountingPort } from "./accounting-port.js";
import { BillingError } from "./domain.js";
import {
  MemoryInvoiceRepository,
  MemoryReminderRepository,
  MemorySettingsRepository,
} from "./memory.js";
import { deriveBillingSettings, syncBillingSettings } from "./org-sync.js";
import { InvoiceService } from "./service.js";
import { TENANT, invoiceInput, orgFixture, settingsInput } from "./test-fixtures.js";

// Mehrwertsteuer ausschalten (#205): der Server erzwingt die Organisationseinstellung «Mehrwertsteuerpflichtig».
const USER = "u1";
const NOW = new Date("2026-11-04T10:00:00Z");
const VAT_NUMBER = "CHE-123.456.789 MWST";
const exempt = () => orgFixture({ vatLiable: false, vatNumber: VAT_NUMBER });
const liable = () => orgFixture({ vatLiable: true, vatNumber: VAT_NUMBER });

function setup() {
  const accounting = new AccountingService(createMemoryStore(), () => NOW);
  const repos = {
    invoices: new MemoryInvoiceRepository(),
    reminders: new MemoryReminderRepository(),
    settings: new MemorySettingsRepository(),
  };
  const service = new InvoiceService({
    ...repos,
    accounting: createAccountingPort(accounting, { tenantId: TENANT, userId: USER }),
    now: () => NOW,
  });
  const sync = (org = liable()) => syncBillingSettings(repos.settings, TENANT, org);
  const sendNew = async (input = {}) => {
    const d = await service.createDraft(TENANT, invoiceInput({ customerId: "K1", ...input }));
    return service.send(TENANT, d.invoice.id, USER);
  };
  const balances = async () =>
    Object.fromEntries(
      (await accounting.trialBalance({ tenantId: TENANT, userId: USER }, {})).rows
        .filter((r) => r.debit || r.credit)
        .map((r) => [r.code, [r.debit, r.credit]]),
    );
  return { service, repos, sync, sendNew, balances };
}

const lines = [{ description: "Beitrag", quantityMilli: 1000, unitCents: 10000 }];
const rejects = async (p: Promise<unknown>, status: number) => {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BillingError);
  expect((error as BillingError).statusCode).toBe(status);
};

describe("Steuerpflicht aus der Organisation ableiten", () => {
  it("nicht pflichtig: Modus «ohne» und keine MwSt-Nummer", () => {
    expect(deriveBillingSettings(TENANT, exempt(), null)).toMatchObject({
      vatLiable: false,
      defaultVatMode: "none",
      vatNumber: null,
    });
  });

  it("pflichtig, auch wenn das Feld fehlt (ältere Organisation): Modus «exklusiv» und Nummer", () => {
    const old = liable();
    delete (old.master as Partial<typeof old.master>).vatLiable;
    expect(deriveBillingSettings(TENANT, old, null)).toMatchObject({
      vatLiable: true,
      defaultVatMode: "exclusive",
      vatNumber: VAT_NUMBER,
    });
  });

  it("ein eigener Standardmodus bleibt, solange der Mandant pflichtig bleibt", () => {
    const existing = deriveBillingSettings(TENANT, liable(), null)!;
    existing.defaultVatMode = "none";
    expect(deriveBillingSettings(TENANT, liable(), existing)?.defaultVatMode).toBe("none");
  });

  it("der Wechsel zurück zu «pflichtig» stellt «exklusiv» wieder her", () => {
    const off = deriveBillingSettings(TENANT, exempt(), null)!;
    expect(deriveBillingSettings(TENANT, liable(), off)).toMatchObject({
      vatLiable: true,
      defaultVatMode: "exclusive",
    });
  });

  it("gilt auch bei unvollständiger Adresse sofort, ohne die Adresse zu ändern", async () => {
    const { repos, sync } = setup();
    await sync();
    const incomplete = { ...exempt(), master: { ...exempt().master, zip: "" } };
    expect(await sync(incomplete)).toBe(false);
    expect(await repos.settings.get(TENANT)).toMatchObject({
      vatLiable: false,
      defaultVatMode: "none",
      vatNumber: null,
      creditor: { postalCode: "8000" },
    });
  });
});

describe("Belege eines nicht pflichtigen Mandanten tragen nie MwSt", () => {
  it("neue Rechnung ohne Angabe: Modus «ohne», Total gleich Zwischentotal, keine Buchung auf 2200", async () => {
    const t = setup();
    await t.sync(exempt());
    const v = await t.sendNew({ lines });
    expect(v.invoice.vatMode).toBe("none");
    expect(v.invoice.totals).toMatchObject({ netCents: 10000, vatCents: 0, totalCents: 10000 });
    expect(v.invoice.totals.vatBuckets).toEqual([{ rateBp: 0, netCents: 10000, vatCents: 0 }]);
    expect(await t.balances()).toEqual({ "1100": [10000, 0], "3400": [0, 10000] });
  });

  it("lehnt «exklusiv» und Sätze über 0 ab (422), im Entwurf wie beim Ändern", async () => {
    const t = setup();
    await t.sync(exempt());
    await rejects(t.service.createDraft(TENANT, invoiceInput({ vatMode: "exclusive" })), 422);
    await rejects(
      t.service.createDraft(TENANT, invoiceInput({ lines: [{ ...lines[0]!, vatRateBp: 810 }] })),
      422,
    );
    const draft = await t.service.createDraft(TENANT, invoiceInput({ lines }));
    await rejects(
      t.service.updateDraft(
        TENANT,
        draft.invoice.id,
        invoiceInput({ vatMode: "exclusive", lines }),
        draft.invoice.version,
      ),
      422,
    );
  });

  it("Sammelrechnung: Lauf mit «exklusiv» abgelehnt, Standard «ohne» geht", async () => {
    const t = setup();
    await t.sync(exempt());
    await t.service.setFeatures(TENANT, { collectiveInvoicing: true });
    const item = (n: number) => ({
      memberId: `m${n}`,
      payerKey: `K${n}`,
      payer: invoiceInput().debtor,
      description: "Beitrag",
      amountCents: 6000,
    });
    const run = { period: "Beitrag 2026", items: [item(1)] };
    await rejects(
      t.service.runCollective(TENANT, { ...run, runId: "lauf-1", vatMode: "exclusive" }),
      422,
    );
    const ok = await t.service.runCollective(TENANT, { ...run, runId: "lauf-2", vatMode: "none" });
    const view = await t.service.get(TENANT, ok.created[0]!);
    expect(view.invoice).toMatchObject({ vatMode: "none", totals: { vatCents: 0 } });
  });

  it("die Rechnungseinstellungen lassen sich nicht auf «exklusiv» oder eine Nummer umstellen", async () => {
    const t = setup();
    await t.sync(exempt());
    const saved = await t.service.saveSettings(
      TENANT,
      settingsInput({ defaultVatMode: "exclusive", vatNumber: VAT_NUMBER }),
    );
    expect(saved).toMatchObject({ vatLiable: false, defaultVatMode: "none", vatNumber: null });
    expect(await t.repos.settings.get(TENANT)).toMatchObject({ vatLiable: false });
  });

  it("Mahnungen tragen keine MwSt: zu zahlen sind offener Betrag und Gebühren", async () => {
    const t = setup();
    await t.sync(exempt());
    const v = await t.sendNew({ lines });
    expect(v.invoice.totals.totalCents).toBe(10000);
    const first = await t.service.issueReminder(TENANT, v.invoice.id, "2027-01-01");
    const second = await t.service.issueReminder(TENANT, v.invoice.id, "2027-02-01");
    expect(first).toMatchObject({ feeCents: 0, totalCents: 10000 });
    expect(second).toMatchObject({ feeCents: 2000, totalCents: 12000 });
  });
});

describe("Umstellen gilt nur für neue Belege", () => {
  it("eine versendete Rechnung mit MwSt bleibt, ihre Gutschrift folgt ihr, neue Belege haben keine MwSt", async () => {
    const t = setup();
    await t.sync(liable());
    const old = await t.sendNew({ lines: [{ ...lines[0]!, vatRateBp: 810 }] });
    expect(old.invoice.vatMode).toBe("exclusive");
    expect(old.invoice.totals).toMatchObject({ vatCents: 810, totalCents: 10810 });
    const before = await t.balances();

    await t.sync(exempt());
    const same = await t.service.get(TENANT, old.invoice.id);
    expect(same.invoice).toEqual(old.invoice);
    expect(same.openCents).toBe(10810);
    expect(await t.balances()).toEqual(before);

    // Gutschrift auf die alte Rechnung: gleiche MwSt wie das Original, die Buchung auf 2200 wird gespiegelt.
    await t.service.credit(
      TENANT,
      old.invoice.id,
      [{ description: "Beitrag", quantityMilli: 1000, unitCents: 10000, vatRateBp: 810 }],
      "Gutschrift",
      USER,
    );
    const afterCredit = await t.balances();
    expect(afterCredit["2200"]).toEqual([810, 810]);

    const fresh = await t.sendNew({ lines });
    expect(fresh.invoice.vatMode).toBe("none");
    expect(fresh.invoice.totals.vatCents).toBe(0);
  });

  it("ein Entwurf mit MwSt aus der Zeit vor dem Wechsel wird erst nach dem Speichern ohne MwSt versendet", async () => {
    const t = setup();
    await t.sync(liable());
    const draft = await t.service.createDraft(
      TENANT,
      invoiceInput({ customerId: "K1", vatMode: "exclusive" }),
    );
    await t.sync(exempt());
    await rejects(t.service.send(TENANT, draft.invoice.id, USER), 422);

    const fixed = await t.service.updateDraft(
      TENANT,
      draft.invoice.id,
      invoiceInput({ customerId: "K1", lines: [{ ...lines[0]!, vatRateBp: 0 }] }),
      draft.invoice.version,
    );
    expect(fixed.invoice).toMatchObject({ vatMode: "none", totals: { vatCents: 0 } });
    expect((await t.service.send(TENANT, draft.invoice.id, USER)).invoice.status).toBe("sent");
  });

  it("zurück zu «pflichtig»: neue Rechnungen tragen wieder MwSt", async () => {
    const t = setup();
    await t.sync(exempt());
    await t.sync(liable());
    const v = await t.service.createDraft(
      TENANT,
      invoiceInput({ lines: [{ ...lines[0]!, vatRateBp: 810 }] }),
    );
    expect(v.invoice).toMatchObject({ vatMode: "exclusive", totals: { vatCents: 810 } });
  });
});
