import { describe, expect, it } from "vitest";
import { BillingError } from "./domain.js";
import { isValidQrr, isValidScor } from "./reference.js";
import {
  IBAN,
  OTHER_TENANT,
  TENANT,
  invoiceInput,
  settingsInput,
  type TestContext,
} from "./test-fixtures.js";

/**
 * Fachliche Tests des Rechnungsservice, unabhängig von der Ablage. Läuft gegen den In-Memory-Store
 * (service.test.ts) und gegen PostgreSQL (service.pg.test.ts).
 */
export function defineServiceSuite(make: () => Promise<TestContext> | TestContext) {
  async function setup(over = {}) {
    const ctx = await make();
    await ctx.service.saveSettings(TENANT, settingsInput(over));
    return ctx;
  }

  async function sent(ctx: Awaited<ReturnType<typeof setup>>) {
    const draft = await ctx.service.createDraft(TENANT, invoiceInput());
    return ctx.service.send(TENANT, draft.invoice.id);
  }

  describe("Einstellungen", () => {
    it("lehnt Nicht-CH-IBAN und unzulässige Empfängeradresse ab", async () => {
      const { service } = await make();
      await expect(
        service.saveSettings(TENANT, settingsInput({ iban: "DE89370400440532013000" })),
      ).rejects.toBeInstanceOf(BillingError);
      const s = settingsInput();
      await expect(
        service.saveSettings(TENANT, { ...s, creditor: { ...s.creditor, name: "Ł".repeat(3) } }),
      ).rejects.toBeInstanceOf(BillingError);
    });
    it("Rechnungen ohne Einstellungen werden verweigert (fail closed)", async () => {
      const { service } = await make();
      await expect(service.createDraft(TENANT, invoiceInput())).rejects.toMatchObject({
        statusCode: 422,
      });
    });
  });

  describe("Lebenszyklus", () => {
    it("Entwurf -> versendet: lückenlose Nummer, gültige QR-Referenz, Fälligkeit nach Zahlungsfrist", async () => {
      const ctx = await setup({ referencePrefix: "12" });
      const a = await sent(ctx);
      const b = await sent(ctx);
      expect(a.invoice.number).toBe("RE-2026-0001");
      expect(b.invoice.number).toBe("RE-2026-0002");
      expect(a.invoice.status).toBe("sent");
      expect(a.invoice.dueDate).toBe("2026-12-01");
      expect(a.invoice.reference?.type).toBe("QRR");
      expect(isValidQrr(a.invoice.reference?.value ?? "")).toBe(true);
      expect(a.invoice.reference?.value).toMatch(/^0+12202600000\d{2}$|12202600000/);
      expect(a.invoice.reference?.value).not.toBe(b.invoice.reference?.value);
      // 120.00 + 1.5 x 90.00 = 255.00 netto, 8.1 % auf 135.00 = 10.94 (Satz 0 % auf 120 gibt 0)
      expect(a.invoice.totals.totalCents).toBe(25500 + 1094);
      expect(a.openCents).toBe(26594);
    });

    it("verwendet SCOR bei normaler IBAN", async () => {
      const ctx = await setup({ iban: IBAN });
      const v = await sent(ctx);
      expect(v.invoice.reference?.type).toBe("SCOR");
      expect(isValidScor(v.invoice.reference?.value ?? "")).toBe(true);
    });

    it("findet Rechnungen über Nummer und Empfängername; Platzhalter der Eingabe gelten wörtlich", async () => {
      const ctx = await setup();
      await sent(ctx);
      const find = async (q: string, tenant = TENANT) =>
        (await ctx.service.list(tenant, { q, limit: 10, offset: 0 })).total;
      expect(await find("re-2026-0001")).toBe(1);
      expect(await find("erika")).toBe(1);
      expect(await find("Meier")).toBe(0);
      expect(await find("%")).toBe(0);
      expect(await find("_")).toBe(0);
      expect(await find("erika", OTHER_TENANT)).toBe(0);
    });

    it("gebuchte Belege sind weder änderbar noch löschbar", async () => {
      const ctx = await setup();
      const v = await sent(ctx);
      const id = v.invoice.id;
      await expect(
        ctx.service.updateDraft(TENANT, id, invoiceInput(), v.invoice.version),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(ctx.service.deleteDraft(TENANT, id)).rejects.toMatchObject({ statusCode: 409 });
      await expect(ctx.service.send(TENANT, id)).rejects.toMatchObject({ statusCode: 409 });
      // Verteidigung in der Tiefe: auch das Repository lehnt eine Änderung der Positionen ab.
      const stored = await ctx.repos.invoices.get(TENANT, id);
      if (!stored) throw new Error("fehlt");
      await expect(
        ctx.repos.invoices.update(
          {
            ...stored,
            lines: [{ ...stored.lines[0]!, unitCents: 1 }],
            version: stored.version + 1,
          },
          stored.version,
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("Entwürfe lassen sich ändern und löschen; paralleles Bearbeiten wird erkannt", async () => {
      const ctx = await setup();
      const d = await ctx.service.createDraft(TENANT, invoiceInput());
      const u = await ctx.service.updateDraft(
        TENANT,
        d.invoice.id,
        invoiceInput({ subject: "Neu" }),
        d.invoice.version,
      );
      expect(u.invoice.subject).toBe("Neu");
      await expect(
        ctx.service.updateDraft(TENANT, d.invoice.id, invoiceInput(), d.invoice.version),
      ).rejects.toMatchObject({ statusCode: 409 });
      await ctx.service.deleteDraft(TENANT, d.invoice.id);
      await expect(ctx.service.get(TENANT, d.invoice.id)).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("Zahlungen führen zu bezahlt; Rückbuchung öffnet wieder; Zahlungen bleiben erhalten", async () => {
      const ctx = await setup();
      const v = await sent(ctx);
      const id = v.invoice.id;
      const pay = (amountCents: number) =>
        ctx.service.recordPayment(TENANT, id, { amountCents, paidOn: "2026-11-10" }, "user-1");
      expect((await pay(10000)).invoice.status).toBe("sent");
      expect((await pay(16594)).invoice.status).toBe("paid");
      const back = await pay(-16594);
      expect(back.invoice.status).toBe("sent");
      expect(back.invoice.payments).toHaveLength(3);
      await expect(pay(-100000)).rejects.toMatchObject({ statusCode: 422 });
    });

    it("Entwurf nimmt keine Zahlung an", async () => {
      const ctx = await setup();
      const d = await ctx.service.createDraft(TENANT, invoiceInput());
      await expect(
        ctx.service.recordPayment(
          TENANT,
          d.invoice.id,
          { amountCents: 1, paidOn: "2026-11-10" },
          "u",
        ),
      ).rejects.toBeInstanceOf(BillingError);
    });
  });

  describe("Storno und Gutschrift (Gegenbuchung)", () => {
    it("Storno erzeugt eine Gutschrift über den vollen Betrag; die Rechnung bleibt unverändert", async () => {
      const ctx = await setup();
      const v = await sent(ctx);
      const after = await ctx.service.cancel(TENANT, v.invoice.id);
      expect(after.invoice.status).toBe("cancelled");
      expect(after.openCents).toBe(0);
      expect(after.invoice.lines).toEqual(v.invoice.lines);
      expect(after.invoice.totals).toEqual(v.invoice.totals);
      const list = await ctx.service.list(TENANT, { kind: "credit_note", limit: 10, offset: 0 });
      expect(list.total).toBe(1);
      const note = list.items[0]!.invoice;
      expect(note.number).toBe("GS-2026-0001");
      expect(note.creditNoteOf).toBe(v.invoice.id);
      expect(note.totals.totalCents).toBe(-v.invoice.totals.totalCents);
      expect(note.reference).toBeNull();
      await expect(ctx.service.cancel(TENANT, v.invoice.id)).rejects.toMatchObject({
        statusCode: 409,
      });
    });

    it("Storno mit Rappenrundung hebt den Betrag genau auf", async () => {
      const ctx = await setup({ roundTo5: true });
      const d = await ctx.service.createDraft(
        TENANT,
        invoiceInput({ lines: [{ description: "x", quantityMilli: 1000, unitCents: 1003 }] }),
      );
      const v = await ctx.service.send(TENANT, d.invoice.id);
      expect(v.invoice.totals.totalCents % 5).toBe(0);
      expect((await ctx.service.cancel(TENANT, v.invoice.id)).invoice.status).toBe("cancelled");
    });

    it("Teilgutschrift senkt den offenen Betrag; Übergutschrift wird abgelehnt", async () => {
      const ctx = await setup();
      const v = await sent(ctx);
      const part = await ctx.service.credit(TENANT, v.invoice.id, [
        { description: "Rabatt", quantityMilli: 1000, unitCents: 5000, vatRateBp: 0 },
      ]);
      expect(part.invoice.status).toBe("sent");
      expect(part.creditedCents).toBe(5000);
      expect(part.openCents).toBe(26594 - 5000);
      await expect(
        ctx.service.credit(TENANT, v.invoice.id, [
          { description: "zu viel", quantityMilli: 1000, unitCents: 100000, vatRateBp: 0 },
        ]),
      ).rejects.toMatchObject({ statusCode: 422 });
      // Rest bezahlen -> bezahlt
      const paid = await ctx.service.recordPayment(
        TENANT,
        v.invoice.id,
        { amountCents: 26594 - 5000, paidOn: "2026-11-10" },
        "u",
      );
      expect(paid.invoice.status).toBe("paid");
      // Bezahlte Rechnung lässt sich nicht mehr stornieren
      await expect(ctx.service.cancel(TENANT, v.invoice.id)).rejects.toMatchObject({
        statusCode: 409,
      });
    });
  });

  describe("Offene Posten für die Startseite", () => {
    it("liefert nur versendete Rechnungen mit Restbetrag, älteste Fälligkeit zuerst, mit Schuldner", async () => {
      const ctx = await setup();
      const first = await sent(ctx); // fällig 2026-12-01
      const second = await ctx.service.send(
        TENANT,
        (
          await ctx.service.createDraft(
            TENANT,
            invoiceInput({ debtor: { ...invoiceInput().debtor, name: "Beat Muster" } }),
          )
        ).invoice.id,
      );
      const paid = await sent(ctx);
      await ctx.service.recordPayment(
        TENANT,
        paid.invoice.id,
        { amountCents: paid.openCents, paidOn: "2026-11-10" },
        "u",
      );
      await ctx.service.credit(TENANT, second.invoice.id, [
        { description: "Rabatt", quantityMilli: 1000, unitCents: 5000, vatRateBp: 0 },
      ]);
      await ctx.service.createDraft(TENANT, invoiceInput()); // Entwurf zählt nicht

      const r = await ctx.service.openItems(TENANT, 100);
      expect(r.total).toBe(2);
      expect(r.overdue).toBe(0);
      expect(r.items.map((i) => [i.invoiceId, i.debtor, i.openCents, i.currency])).toEqual([
        [first.invoice.id, "Erika Beispiel", 26594, "CHF"],
        [second.invoice.id, "Beat Muster", 26594 - 5000, "CHF"],
      ]);
      expect(r.items[0]).toMatchObject({ number: first.invoice.number, dueDate: "2026-12-01" });
    });

    it("zählt überfällige Posten und kürzt die Liste, nicht die Summe", async () => {
      const ctx = await setup();
      await sent(ctx);
      await sent(ctx);
      ctx.clock.now = new Date("2026-12-02T10:00:00Z"); // einen Tag nach Fälligkeit
      const r = await ctx.service.openItems(TENANT, 1);
      expect(r.items).toHaveLength(1);
      expect(r.total).toBe(2);
      expect(r.overdue).toBe(2);
    });

    it("trennt Mandanten", async () => {
      const ctx = await setup();
      await sent(ctx);
      expect(await ctx.service.openItems(OTHER_TENANT, 100)).toEqual({
        items: [],
        total: 0,
        overdue: 0,
      });
    });
  });

  describe("Mandantentrennung (SR-11)", () => {
    it("fremde Belege sind nicht auffindbar, änderbar oder bezahlbar", async () => {
      const ctx = await setup();
      await ctx.service.saveSettings(OTHER_TENANT, settingsInput());
      const v = await sent(ctx);
      const id = v.invoice.id;
      await expect(ctx.service.get(OTHER_TENANT, id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(ctx.service.send(OTHER_TENANT, id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(ctx.service.invoicePdf(OTHER_TENANT, id)).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(
        ctx.service.recordPayment(OTHER_TENANT, id, { amountCents: 1, paidOn: "2026-11-10" }, "u"),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect((await ctx.service.list(OTHER_TENANT, { limit: 10, offset: 0 })).total).toBe(0);
      // Nummernkreise sind je Mandant getrennt
      const o = await ctx.service.createDraft(OTHER_TENANT, invoiceInput());
      expect((await ctx.service.send(OTHER_TENANT, o.invoice.id)).invoice.number).toBe(
        "RE-2026-0001",
      );
    });
  });

  describe("Rückbuchung einer Zahlung (#68)", () => {
    const pay = (
      ctx: Awaited<ReturnType<typeof setup>>,
      id: string,
      amountCents: number,
      paidOn: string,
    ) => ctx.service.recordPayment(TENANT, id, { amountCents, paidOn }, "user-1");

    it("hebt genau eine frühere Zahlung auf: kein Teilbetrag, nicht doppelt, nicht vor der Zahlung", async () => {
      const ctx = await setup();
      const id = (await sent(ctx)).invoice.id;
      await pay(ctx, id, 10000, "2026-11-10");
      await expect(pay(ctx, id, -5000, "2026-11-11")).rejects.toMatchObject({ statusCode: 422 });
      await expect(pay(ctx, id, -10000, "2026-11-09")).rejects.toMatchObject({ statusCode: 422 });
      const back = await pay(ctx, id, -10000, "2026-11-11");
      expect(back).toMatchObject({ paidCents: 0, openCents: 26594 });
      await expect(pay(ctx, id, -10000, "2026-11-12")).rejects.toMatchObject({ statusCode: 422 });
      expect((await ctx.service.get(TENANT, id)).invoice.payments).toHaveLength(2);
      // Eine Zahlung nach der Rückbuchung lässt sich wieder zurückbuchen.
      await pay(ctx, id, 10000, "2026-11-13");
      expect((await pay(ctx, id, -10000, "2026-11-14")).invoice.payments).toHaveLength(4);
    });

    it("ein anderer Mandant kann nicht zurückbuchen", async () => {
      const ctx = await setup();
      await ctx.service.saveSettings(OTHER_TENANT, settingsInput());
      const id = (await sent(ctx)).invoice.id;
      await pay(ctx, id, 10000, "2026-11-10");
      await expect(
        ctx.service.recordPayment(
          OTHER_TENANT,
          id,
          { amountCents: -10000, paidOn: "2026-11-11" },
          "u",
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect((await ctx.service.get(TENANT, id)).paidCents).toBe(10000);
    });

    it("Fälligkeit und Mahnstufe bleiben konsistent: gemahnt, bezahlt, zurückgebucht, nächste Stufe fällig", async () => {
      const ctx = await setup();
      const v = await sent(ctx); // fällig 2026-12-01
      const id = v.invoice.id;
      await ctx.service.issueReminder(TENANT, id, "2026-12-11"); // Stufe 1, Frist bis 2026-12-21
      await pay(ctx, id, 26594, "2026-12-12");
      expect(await ctx.service.dueForDunning(TENANT, "2027-02-01")).toEqual([]);

      const back = await pay(ctx, id, -26594, "2026-12-13");
      expect(back.invoice.status).toBe("sent");
      expect(back.invoice.dueDate).toBe("2026-12-01");
      expect(await ctx.service.listReminders(TENANT, id)).toHaveLength(1);
      // Die Frist der Stufe 1 läuft weiter, danach ist Stufe 2 fällig (nicht Stufe 1 noch einmal).
      expect(await ctx.service.dueForDunning(TENANT, "2026-12-21")).toEqual([]);
      const due = await ctx.service.dueForDunning(TENANT, "2026-12-22");
      expect(due.map((d) => [d.invoiceId, d.nextLevel.level, d.openCents])).toEqual([
        [id, 2, 26594],
      ]);
      const r2 = await ctx.service.issueReminder(TENANT, id, "2026-12-22");
      expect(r2).toMatchObject({ level: 2, openCents: 26594, totalCents: 28594 });
    });

    it("ist die Zahlung ganz zurückgebucht, lässt sich die Rechnung wieder stornieren", async () => {
      const ctx = await setup();
      const id = (await sent(ctx)).invoice.id;
      await pay(ctx, id, 26594, "2026-11-10");
      await expect(ctx.service.cancel(TENANT, id)).rejects.toMatchObject({ statusCode: 409 });
      await pay(ctx, id, -26594, "2026-11-11");
      expect((await ctx.service.cancel(TENANT, id)).invoice.status).toBe("cancelled");
    });
  });

  describe("Erlöskonto je Position (#67)", () => {
    const line = (accountCode?: string) => ({
      description: "Pos",
      quantityMilli: 1000,
      unitCents: 1000,
      vatRateBp: 0,
      ...(accountCode ? { accountCode } : {}),
    });

    it("der Entwurf lässt das Konto offen, das Versenden schreibt es fest: Standardkonto oder 3400", async () => {
      const ctx = await setup();
      const d = await ctx.service.createDraft(
        TENANT,
        invoiceInput({ lines: [line(), line("3200")] }),
      );
      expect(d.invoice.lines.map((l) => l.accountCode)).toEqual([undefined, "3200"]);
      const v = await ctx.service.send(TENANT, d.invoice.id);
      expect(v.invoice.lines.map((l) => l.accountCode)).toEqual(["3400", "3200"]);
      expect((await ctx.service.get(TENANT, d.invoice.id)).invoice.lines).toEqual(v.invoice.lines);
    });

    it("Standardkonto des Mandanten gilt für Positionen ohne Konto, bei Sammelrechnungen 3000", async () => {
      const ctx = await setup({ defaultRevenueAccount: "3200" });
      const d = await ctx.service.createDraft(
        TENANT,
        invoiceInput({ lines: [line(), line("3600")] }),
      );
      const v = await ctx.service.send(TENANT, d.invoice.id);
      expect(v.invoice.lines.map((l) => l.accountCode)).toEqual(["3200", "3600"]);

      await ctx.service.setFeatures(TENANT, { collectiveInvoicing: true });
      const run = await ctx.service.runCollective(TENANT, {
        runId: "44444444-4444-4444-8444-444444444444",
        period: "Beitrag",
        vatMode: "none",
        items: [
          {
            memberId: "m1",
            payerKey: "K9",
            payer: invoiceInput().debtor,
            description: "Beitrag",
            amountCents: 5000,
          },
        ],
      });
      const c = await ctx.service.send(TENANT, run.created[0]!);
      expect(c.invoice.lines.map((l) => l.accountCode)).toEqual(["3000"]);
    });

    it("Gutschriften übernehmen das Konto der Rechnung; bei mehreren Konten muss die Position es nennen", async () => {
      const ctx = await setup({ defaultRevenueAccount: "3200" });
      const single = await ctx.service.send(
        TENANT,
        (await ctx.service.createDraft(TENANT, invoiceInput({ lines: [line()] }))).invoice.id,
      );
      // Das Standardkonto ändert sich später, die Gutschrift folgt trotzdem der Rechnung.
      await ctx.service.saveSettings(TENANT, settingsInput({ defaultRevenueAccount: "3400" }));
      await ctx.service.credit(TENANT, single.invoice.id, [line()]);
      const notes = await ctx.service.list(TENANT, { kind: "credit_note", limit: 10, offset: 0 });
      expect(notes.items[0]?.invoice.lines.map((l) => l.accountCode)).toEqual(["3200"]);

      const multi = await ctx.service.send(
        TENANT,
        (
          await ctx.service.createDraft(
            TENANT,
            invoiceInput({ lines: [line("3000"), line("3200")] }),
          )
        ).invoice.id,
      );
      await expect(ctx.service.credit(TENANT, multi.invoice.id, [line()])).rejects.toMatchObject({
        statusCode: 422,
      });
      await ctx.service.credit(TENANT, multi.invoice.id, [line("3000")]);
      const cancelled = await ctx.service.cancel(
        TENANT,
        (
          await ctx.service.send(
            TENANT,
            (
              await ctx.service.createDraft(
                TENANT,
                invoiceInput({ lines: [line("3000"), line("3600")] }),
              )
            ).invoice.id,
          )
        ).invoice.id,
      );
      expect(cancelled.invoice.status).toBe("cancelled");
      const all = await ctx.service.list(TENANT, { kind: "credit_note", limit: 10, offset: 0 });
      const storno = all.items.find((n) => n.invoice.lines.length === 2)!;
      expect(storno.invoice.lines.map((l) => l.accountCode)).toEqual(["3000", "3600"]);
    });
  });

  describe("Mahnwesen", () => {
    it("mahnt in Stufen, mit Fristen und kumulierten Gebühren", async () => {
      const ctx = await setup();
      const v = await sent(ctx);
      const id = v.invoice.id; // fällig 2026-12-01
      expect(await ctx.service.dueForDunning(TENANT, "2026-12-10")).toHaveLength(0); // erst +10 Tage
      const due = await ctx.service.dueForDunning(TENANT, "2026-12-11");
      expect(due.map((d) => d.nextLevel.level)).toEqual([1]);

      const r1 = await ctx.service.issueReminder(TENANT, id, "2026-12-11");
      expect(r1).toMatchObject({ level: 1, dueOn: "2026-12-21", feeCents: 0, totalCents: 26594 });
      await expect(ctx.service.issueReminder(TENANT, id, "2026-12-11")).rejects.toMatchObject({
        statusCode: 409,
      });
      await expect(ctx.service.issueReminder(TENANT, id, "2026-12-21")).rejects.toMatchObject({
        statusCode: 409,
      }); // Frist läuft bis einschliesslich 21.12.
      const r2 = await ctx.service.issueReminder(TENANT, id, "2026-12-22");
      expect(r2).toMatchObject({
        level: 2,
        dueOn: "2027-01-01",
        feeCents: 2000,
        totalCents: 28594,
      });
      const r3 = await ctx.service.issueReminder(TENANT, id, "2027-01-02");
      expect(r3).toMatchObject({ level: 3, feeCents: 3000, totalCents: 26594 + 5000 });
      await expect(ctx.service.issueReminder(TENANT, id, "2027-03-01")).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(await ctx.service.listReminders(TENANT, id)).toHaveLength(3);
    });

    it("mahnt nicht, was bezahlt, storniert, Entwurf oder nicht fällig ist", async () => {
      const ctx = await setup();
      const draft = await ctx.service.createDraft(TENANT, invoiceInput());
      const paid = await sent(ctx);
      await ctx.service.recordPayment(
        TENANT,
        paid.invoice.id,
        { amountCents: 26594, paidOn: "2026-11-02" },
        "u",
      );
      const cancelled = await sent(ctx);
      await ctx.service.cancel(TENANT, cancelled.invoice.id);
      expect(await ctx.service.dueForDunning(TENANT, "2030-01-01")).toHaveLength(0);
      await expect(
        ctx.service.issueReminder(TENANT, draft.invoice.id, "2030-01-01"),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("Teilzahlung senkt den gemahnten Betrag", async () => {
      const ctx = await setup();
      const v = await sent(ctx);
      await ctx.service.recordPayment(
        TENANT,
        v.invoice.id,
        { amountCents: 6594, paidOn: "2026-11-20" },
        "u",
      );
      const r = await ctx.service.issueReminder(TENANT, v.invoice.id, "2026-12-15");
      expect(r.openCents).toBe(20000);
    });
  });

  describe("Sammelrechnung (optionales Modul)", () => {
    const payer = (name: string) => ({
      name,
      street: "Vereinsgasse",
      buildingNumber: "3",
      postalCode: "6000",
      town: "Luzern",
      country: "CH",
    });
    const run = (runId: string) => ({
      runId,
      period: "Mitgliederbeitrag 2027",
      vatMode: "none" as const,
      items: [
        {
          memberId: "m1",
          payerKey: "fam-a",
          payer: payer("Familie A"),
          description: "Anna A.",
          amountCents: 8000,
        },
        {
          memberId: "m2",
          payerKey: "fam-a",
          payer: payer("Familie A"),
          description: "Ben A.",
          amountCents: 4000,
        },
        {
          memberId: "m3",
          payerKey: "c",
          payer: payer("Carla C"),
          description: "Carla C.",
          amountCents: 8000,
        },
      ],
    });
    const RUN = "33333333-3333-4333-8333-333333333333";

    it("ist ohne Freischaltung gesperrt", async () => {
      const ctx = await setup();
      await expect(ctx.service.runCollective(TENANT, run(RUN))).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it("bündelt je Zahler eine Rechnung und ist idempotent", async () => {
      const ctx = await setup();
      await ctx.service.setFeatures(TENANT, { collectiveInvoicing: true });
      const r1 = await ctx.service.runCollective(TENANT, run(RUN));
      expect(r1.created).toHaveLength(2);
      const drafts = await ctx.service.list(TENANT, { status: "draft", limit: 10, offset: 0 });
      const fam = drafts.items.find((i) => i.invoice.payerKey === "fam-a")!;
      expect(fam.invoice.lines).toHaveLength(2);
      expect(fam.invoice.totals.totalCents).toBe(12000);
      expect(fam.invoice.vatMode).toBe("none");
      const r2 = await ctx.service.runCollective(TENANT, run(RUN));
      expect(r2.created).toHaveLength(0);
      expect(r2.skippedPayers.sort()).toEqual(["c", "fam-a"]);
      expect((await ctx.service.list(TENANT, { limit: 50, offset: 0 })).total).toBe(2);
    });

    it("gilt pro Mandant: anderer Kunde bleibt gesperrt", async () => {
      const ctx = await setup();
      await ctx.service.saveSettings(OTHER_TENANT, settingsInput());
      await ctx.service.setFeatures(TENANT, { collectiveInvoicing: true });
      await expect(ctx.service.runCollective(OTHER_TENANT, run(RUN))).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it("legt bei einem ungültigen Eintrag nichts an", async () => {
      const ctx = await setup();
      await ctx.service.setFeatures(TENANT, { collectiveInvoicing: true });
      const bad = run(RUN);
      bad.items.push({ ...bad.items[0]!, payerKey: "x", amountCents: 100_000_000 * 1001 });
      await expect(ctx.service.runCollective(TENANT, bad)).rejects.toBeInstanceOf(BillingError);
      expect((await ctx.service.list(TENANT, { limit: 50, offset: 0 })).total).toBe(0);
    });
  });
}
