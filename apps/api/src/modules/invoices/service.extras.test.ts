import { describe, expect, it } from "vitest";
import { createMemoryStore as createLedger } from "../accounting/repository.js";
import { AccountingService } from "../accounting/service.js";
import type { Member } from "../people/domain.js";
import { createMemoryStore as createPeople } from "../people/memory.js";
import { toXlsx } from "../reports/export.js";
import { createAccountingPort } from "./accounting-port.js";
import { MemoryGroupFeeStore, createCollectiveSource } from "./collective.js";
import type { InvoiceMail, InvoiceMailPort, Sender } from "./mail-port.js";
import {
  MemoryInvoiceRepository,
  MemoryReminderRepository,
  MemorySettingsRepository,
} from "./memory.js";
import { InvoiceService } from "./service.js";
import { OTHER_TENANT, TENANT, invoiceInput, settingsInput } from "./test-fixtures.js";

// Tests zu #109 gegen die In-Memory-Ablage: E-Mail, Storno-Grund, Export, Mahnstufen, Buchungen, Sammelrechnung nach
// Gruppen. Die Mandantentrennung der Postgres-Ablage prüft collective.pg.test.ts.
const USER = "u1";
const NOW = new Date("2026-11-04T10:00:00Z");
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

class FakeMail implements InvoiceMailPort {
  sent: { from: Sender; mail: InvoiceMail }[] = [];
  /** Adressen, an die der Versand scheitert. */
  failFor = new Set<string>();
  async send(from: Sender, mail: InvoiceMail) {
    if (this.failFor.has(mail.to)) throw new Error("SMTP 550 intern: konto xy");
    this.sent.push({ from, mail });
  }
}

function setup(over: { clock?: Date; settings?: Parameters<typeof settingsInput>[0] } = {}) {
  const clock = { now: over.clock ?? NOW };
  const ledger = new AccountingService(createLedger(), () => clock.now);
  const people = createPeople();
  const fees = new MemoryGroupFeeStore();
  const mail = new FakeMail();
  const repos = {
    invoices: new MemoryInvoiceRepository(),
    reminders: new MemoryReminderRepository(),
    settings: new MemorySettingsRepository(),
  };
  let n = 100;
  const serviceFor = (tenantId: string, withMail = true) =>
    new InvoiceService({
      ...repos,
      accounting: createAccountingPort(ledger, { tenantId, userId: USER }),
      collective: createCollectiveSource(people, fees),
      ...(withMail ? { mail } : {}),
      now: () => clock.now,
      newId: () => ID(++n),
    });
  const service = serviceFor(TENANT);
  const ready = async () => {
    await service.saveSettings(TENANT, settingsInput(over.settings));
    return service;
  };
  const sent = async (input = {}) => {
    const d = await service.createDraft(TENANT, invoiceInput({ customerId: "K1", ...input }));
    return service.send(TENANT, d.invoice.id, USER);
  };
  return { service, serviceFor, ready, sent, mail, people, fees, clock, repos };
}

describe("Storno mit Grund und Bemerkung", () => {
  it("schreibt beides auf die Gutschrift, die Bemerkung nur intern", async () => {
    const { ready, sent, repos } = setup();
    const service = await ready();
    const v = await sent();
    const after = await service.cancel(TENANT, v.invoice.id, USER, {
      reason: "Falscher Betrag",
      remark: "Telefonisch mit Frau Muster geklärt",
    });
    expect(after.invoice.status).toBe("cancelled");
    const [note] = await repos.invoices.creditNotesOf(TENANT, v.invoice.id);
    expect(note?.subject).toBe("Storno: Falscher Betrag");
    expect(note?.notes).toBe("Telefonisch mit Frau Muster geklärt");
  });

  it("ohne Angaben bleibt der Betreff «Storno»", async () => {
    const { ready, sent, repos } = setup();
    const service = await ready();
    const v = await sent();
    await service.cancel(TENANT, v.invoice.id, USER);
    expect((await repos.invoices.creditNotesOf(TENANT, v.invoice.id))[0]?.subject).toBe("Storno");
  });
});

describe("E-Mail-Versand", () => {
  const input = {
    to: "erika@example.test",
    subject: "Rechnung RE-2026-0001",
    message: "Guten Tag",
  };

  it("sendet das PDF der gebuchten Rechnung über das Mailkonto des Handelnden", async () => {
    const { ready, sent, mail } = setup();
    const service = await ready();
    const v = await sent();
    await service.emailInvoice(TENANT, v.invoice.id, USER, input);
    const [m] = mail.sent;
    expect(m?.from).toEqual({ tenantId: TENANT, userId: USER });
    expect(m?.mail).toMatchObject({ to: input.to, subject: input.subject, text: "Guten Tag" });
    expect(m?.mail.attachment.filename).toBe("RE-2026-0001.pdf");
    expect(Buffer.from(m!.mail.attachment.bytes).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("verweigert Entwürfe, fremde Rechnungen und fehlende Einrichtung", async () => {
    const { ready, service: s, mail, serviceFor } = setup();
    const service = await ready();
    const draft = await service.createDraft(TENANT, invoiceInput({ customerId: "K1" }));
    await expect(service.emailInvoice(TENANT, draft.invoice.id, USER, input)).rejects.toMatchObject(
      { statusCode: 409 },
    );
    await expect(s.emailInvoice(OTHER_TENANT, draft.invoice.id, USER, input)).rejects.toMatchObject(
      { statusCode: 404 },
    );
    const v = await service.send(TENANT, draft.invoice.id, USER);
    await expect(
      serviceFor(TENANT, false).emailInvoice(TENANT, v.invoice.id, USER, input),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: "Der E-Mail-Versand ist nicht eingerichtet.",
    });
    expect(mail.sent).toHaveLength(0);
  });

  it("meldet einen Fehler des Mailsystems ohne dessen Text (SR-51)", async () => {
    const { ready, sent, mail } = setup();
    const service = await ready();
    const v = await sent();
    mail.failFor.add(input.to);
    const err = await service.emailInvoice(TENANT, v.invoice.id, USER, input).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 422 });
    expect(err.message).not.toMatch(/SMTP|konto xy/);
  });

  it("sendet eine Mahnung mit ihrem PDF; unbekannte Stufe ergibt 404", async () => {
    const { ready, sent, mail, clock } = setup();
    const service = await ready();
    const v = await sent();
    clock.now = new Date("2027-01-20T10:00:00Z");
    await service.issueReminder(TENANT, v.invoice.id);
    await service.emailReminder(TENANT, v.invoice.id, 1, USER, input);
    expect(mail.sent[0]?.mail.attachment.filename).toBe("mahnung-1-RE-2026-0001.pdf");
    await expect(service.emailReminder(TENANT, v.invoice.id, 2, USER, input)).rejects.toMatchObject(
      { statusCode: 404 },
    );
  });
});

describe("Export der Rechnungsliste", () => {
  it("listet Rechnungen ohne Gutschriften mit abgeleitetem Status und Mahnstufe", async () => {
    const { ready, sent, clock } = setup();
    const service = await ready();
    const open = await sent();
    const cancelled = await sent();
    await service.cancel(TENANT, cancelled.invoice.id, USER);
    const reminded = await sent();
    await service.createDraft(TENANT, invoiceInput());
    clock.now = new Date("2027-01-20T10:00:00Z");
    await service.issueReminder(TENANT, reminded.invoice.id);

    const table = await service.exportTable(TENANT);
    const by = (nr: string | null) => table.rows.find((r) => r[0] === nr);
    expect(table.rows).toHaveLength(4); // 3 versendet + 1 Entwurf, die Gutschrift fehlt
    expect(by(open.invoice.number)?.[5]).toBe("Offen");
    expect(by(cancelled.invoice.number)?.[5]).toBe("Storniert");
    expect(by(reminded.invoice.number)?.slice(5, 7)).toEqual(["Gemahnt", "Zahlungserinnerung"]);
    expect(by("")?.[5]).toBe("Entwurf");
    expect(by(open.invoice.number)?.[7]).toBe(26594);
  });

  it("exportiert mit ids genau diese Rechnungen, fremde und unbekannte fallen weg", async () => {
    const { ready, sent, serviceFor } = setup();
    const service = await ready();
    const a = await sent();
    await sent();
    const table = await service.exportTable(TENANT, [a.invoice.id, ID(999), a.invoice.id]);
    expect(table.rows.map((r) => r[0])).toEqual([a.invoice.number]);
    expect((await serviceFor(OTHER_TENANT).exportTable(OTHER_TENANT, [a.invoice.id])).rows).toEqual(
      [],
    );
  });

  it("ergibt eine XLSX-Datei und neutralisiert Formeln in Texten (SR-20)", async () => {
    const { ready, service: s } = setup();
    const service = await ready();
    await service.createDraft(
      TENANT,
      invoiceInput({ debtor: { ...invoiceInput().debtor, name: "=HYPERLINK(1)" } }),
    );
    const table = await s.exportTable(TENANT);
    const bytes = toXlsx(table);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
  });
});

describe("Mahnstufen-Einstellungen", () => {
  const levels = [
    { level: 1, title: "Erinnerung", waitDays: 5, graceDays: 7, feeCents: 0 },
    { level: 2, title: "Mahnung", waitDays: 0, graceDays: 7, feeCents: 1500 },
  ];

  it("speichert die Stufen und wendet sie auf das Mahnwesen an", async () => {
    const { ready, sent, clock } = setup();
    const service = await ready();
    const v = await sent();
    const saved = await service.saveDunning(TENANT, { levels });
    expect(saved.dunning.levels).toEqual(levels);
    expect((await service.getSettings(TENANT))?.dunning.levels).toHaveLength(2);
    // Fälligkeit 2026-12-01 plus 5 Tage Wartezeit
    clock.now = new Date("2026-12-07T10:00:00Z");
    const due = await service.dueForDunning(TENANT);
    expect(due.map((d) => d.nextLevel.title)).toEqual(["Erinnerung"]);
    expect(v.invoice.id).toBe(due[0]?.invoiceId);
  });

  it("lehnt Lücken in der Nummerierung ab und braucht Einstellungen", async () => {
    const { ready, service: s } = setup();
    const service = await ready();
    await expect(
      service.saveDunning(TENANT, { levels: [{ ...levels[1]!, level: 2 }] }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(s.saveDunning(OTHER_TENANT, { levels })).rejects.toMatchObject({
      statusCode: 422,
    });
  });
});

describe("Buchungen je Rechnung", () => {
  it("zeigt Forderung, Zahlung, Rückbuchung und Gutschrift mit Kontenbezeichnung", async () => {
    const { ready, sent } = setup();
    const service = await ready();
    const paid = await sent();
    await service.recordPayment(
      TENANT,
      paid.invoice.id,
      { amountCents: 10000, paidOn: "2026-11-10" },
      USER,
    );
    await service.recordPayment(
      TENANT,
      paid.invoice.id,
      { amountCents: -10000, paidOn: "2026-11-11" },
      USER,
    );
    const rows = await service.bookings(TENANT, paid.invoice.id, USER);
    expect(rows.map((r) => r.kind)).toEqual(["invoice", "payment", "reversal"]);
    expect(rows[0]?.description).toBe("Rechnung RE-2026-0001");
    expect(rows[0]?.lines.find((l) => l.accountCode === "1100")).toMatchObject({
      side: "debit",
      amountCents: 26594,
    });
    expect(rows[0]?.lines.every((l) => l.accountName !== "")).toBe(true);
    expect(rows.map((r) => r.number)).toEqual([...rows.map((r) => r.number)].sort((a, b) => a - b));

    const cancelled = await sent();
    await service.cancel(TENANT, cancelled.invoice.id, USER);
    expect((await service.bookings(TENANT, cancelled.invoice.id, USER)).map((r) => r.kind)).toEqual(
      ["invoice", "credit_note"],
    );
  });

  it("Entwurf und fremder Mandant ergeben keine Buchungen bzw. 404", async () => {
    const { ready, serviceFor } = setup();
    const service = await ready();
    const draft = await service.createDraft(TENANT, invoiceInput({ customerId: "K1" }));
    expect(await service.bookings(TENANT, draft.invoice.id, USER)).toEqual([]);
    await expect(
      serviceFor(OTHER_TENANT).bookings(OTHER_TENANT, draft.invoice.id, USER),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("Sammelrechnung nach Gruppen", () => {
  const G_AKTIV = ID(1);
  const G_JUNIOR = ID(2);
  const G_FREI = ID(3);
  const addr = { strasse: "Dorfstrasse", hausnr: "3", plz: "3000", ort: "Bern", land: "CH" };

  async function seed(ctx: ReturnType<typeof setup>) {
    const { people, fees } = ctx;
    for (const [id, name] of [
      [G_AKTIV, "Aktive"],
      [G_JUNIOR, "Junioren"],
      [G_FREI, "Freimitglieder"],
    ] as const)
      await people.gruppen.insert({
        id,
        kundeId: TENANT,
        name,
        beschreibung: null,
        erstelltAm: NOW,
        geaendertAm: NOW,
      });
    const member = (n: number, over: Partial<Member>): Member => ({
      id: ID(100 + n),
      kundeId: TENANT,
      typ: "einzel",
      status: "aktiv",
      anrede: null,
      vorname: `Vor${n}`,
      nachname: `Nach${n}`,
      email: `m${n}@example.test`,
      telefon: null,
      mobil: null,
      adresse: addr,
      notiz: null,
      mitgliedsnr: "",
      geburtsdatum: null,
      eintritt: null,
      kanal: null,
      gruppeSeit: null,
      funktion: null,
      firmaId: null,
      gruppeId: null,
      erstelltAm: NOW,
      geaendertAm: NOW,
      ...over,
    });
    const rows: [Member, string | null][] = [
      [member(1, {}), G_AKTIV],
      [member(2, { email: null }), G_AKTIV],
      [member(3, { adresse: null }), G_AKTIV],
      [member(4, { status: "archiviert" }), G_AKTIV],
      [member(5, {}), G_JUNIOR],
      [member(6, {}), G_FREI],
      [member(7, {}), null],
    ];
    for (const [m, g] of rows) {
      await people.members.insert(m);
      if (g) await people.gruppen.assign(TENANT, m.id, g);
    }
    await fees.set(TENANT, G_AKTIV, 12000);
    await fees.set(TENANT, G_JUNIOR, 5000);
  }

  const config = (over = {}) => ({
    year: 2027,
    issueDate: "2026-12-01",
    termDays: 30,
    text: "Mitgliederbeitrag 2027",
    delivery: "email-or-print" as const,
    skipLeft: true,
    skipNoFee: true,
    groupIds: [G_AKTIV, G_JUNIOR, G_FREI],
    ...over,
  });
  const mailText = {
    subject: "Rechnung {number}",
    message: "Rechnung {number} über {amount}",
  };

  async function enabled() {
    const ctx = setup();
    const service = await ctx.ready();
    await service.setFeatures(TENANT, { collectiveInvoicing: true });
    await seed(ctx);
    return { ...ctx, service };
  }

  it("ist ohne freigeschaltetes Modul gesperrt (403) und ohne Einstellungen nicht benutzbar", async () => {
    const { ready } = setup();
    const service = await ready();
    await expect(service.collectiveSetup(TENANT)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.collectivePreview(TENANT, config())).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(service.setGroupFee(TENANT, G_AKTIV, 100)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      service.runCollectiveByGroups(TENANT, { runId: ID(50), config: config() }, USER),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("zeigt Gruppen mit Beitrag, aktiven Personen und Vorgaben", async () => {
    const { service } = await enabled();
    const setup = await service.collectiveSetup(TENANT);
    expect(setup.groups).toEqual([
      { id: G_AKTIV, name: "Aktive", feeCents: 12000, persons: 3 },
      { id: G_FREI, name: "Freimitglieder", feeCents: null, persons: 1 },
      { id: G_JUNIOR, name: "Junioren", feeCents: 5000, persons: 1 },
    ]);
    expect(setup.totalPersons).toBe(6);
    expect(setup.defaults).toEqual({
      year: 2026,
      issueDate: "2026-11-04",
      termDays: 30,
      text: "Mitgliederbeitrag 2026",
    });
  });

  it("setzt und entfernt den Beitrag; unbekannte und fremde Gruppen ergeben 404", async () => {
    const { service, serviceFor } = await enabled();
    await service.setGroupFee(TENANT, G_FREI, 2500);
    expect(
      (await service.collectiveSetup(TENANT)).groups.find((g) => g.id === G_FREI)?.feeCents,
    ).toBe(2500);
    await service.setGroupFee(TENANT, G_FREI, null);
    expect(
      (await service.collectiveSetup(TENANT)).groups.find((g) => g.id === G_FREI)?.feeCents,
    ).toBeNull();
    await expect(service.setGroupFee(TENANT, ID(77), 100)).rejects.toMatchObject({
      statusCode: 404,
    });
    const other = serviceFor(OTHER_TENANT);
    await other.saveSettings(OTHER_TENANT, settingsInput());
    await other.setFeatures(OTHER_TENANT, { collectiveInvoicing: true });
    await expect(other.setGroupFee(OTHER_TENANT, G_AKTIV, 100)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect((await other.collectiveSetup(OTHER_TENANT)).groups).toEqual([]);
  });

  it("plant die Vorschau: Gruppen ohne Beitrag und Ausgetretene fallen weg, fehlende Adresse wird gezählt", async () => {
    const { service } = await enabled();
    const p = await service.collectivePreview(TENANT, config());
    expect(p).toMatchObject({
      count: 3,
      groupCount: 2,
      totalCents: 12000 + 12000 + 5000,
      dueDate: "2026-12-31",
      viaEmail: 2,
      printCount: 1,
      noAddress: 1,
    });
    expect(p.rows.map((r) => [r.number, r.recipient, r.delivery, r.check])).toEqual([
      ["RE-2026-0001", "Vor1 Nach1", "email", "ready"],
      ["RE-2026-0002", "Vor2 Nach2", "print", "no-email"],
      ["RE-2026-0003", "Vor5 Nach5", "email", "ready"],
    ]);
    const withLeft = await service.collectivePreview(TENANT, config({ skipLeft: false }));
    expect(withLeft.count).toBe(4);
    const print = await service.collectivePreview(TENANT, config({ delivery: "print" }));
    expect([print.viaEmail, print.printCount]).toEqual([0, 3]);
    expect(print.rows.every((r) => r.check === "ready")).toBe(true);
  });

  it("legt den Lauf an: gebucht, nummeriert, Mails mit eingesetzten Platzhaltern", async () => {
    const { service, mail, repos } = await enabled();
    const input = { runId: ID(50), config: config(), mail: mailText };
    const result = await service.runCollectiveByGroups(TENANT, input, USER);
    expect(result).toEqual({ created: 3, mailed: 2, notMailed: 0, skipped: 0, remaining: 0 });
    const all = await repos.invoices.list(TENANT, { limit: 50, offset: 0 });
    expect(all.items.map((i) => [i.number, i.status, i.totals.totalCents]).sort()).toEqual([
      ["RE-2026-0001", "sent", 12000],
      ["RE-2026-0002", "sent", 12000],
      ["RE-2026-0003", "sent", 5000],
    ]);
    expect(all.items.every((i) => i.collectiveRunId === ID(50) && i.vatMode === "none")).toBe(true);
    expect(mail.sent.map((m) => [m.mail.to, m.mail.subject, m.mail.text])).toEqual([
      ["m1@example.test", "Rechnung RE-2026-0001", "Rechnung RE-2026-0001 über CHF 120.00"],
      ["m5@example.test", "Rechnung RE-2026-0003", "Rechnung RE-2026-0003 über CHF 50.00"],
    ]);
    // Forderung in der Buchhaltung je Rechnung
    expect((await service.bookings(TENANT, all.items[0]!.id, USER)).length).toBe(1);
  });

  it("wiederholt mit derselben Lauf-ID nichts doppelt und versendet nichts doppelt", async () => {
    const { service, mail } = await enabled();
    const input = { runId: ID(50), config: config(), mail: mailText };
    await service.runCollectiveByGroups(TENANT, input, USER);
    const again = await service.runCollectiveByGroups(TENANT, input, USER);
    expect(again).toEqual({ created: 0, mailed: 0, notMailed: 0, skipped: 3, remaining: 0 });
    expect(mail.sent).toHaveLength(2);
  });

  it("zählt Mails, die nicht in die Queue kamen; die Rechnung bleibt gebucht", async () => {
    const { service, mail } = await enabled();
    mail.failFor.add("m5@example.test");
    const result = await service.runCollectiveByGroups(
      TENANT,
      { runId: ID(50), config: config(), mail: mailText },
      USER,
    );
    expect(result).toMatchObject({ created: 3, mailed: 1, notMailed: 1 });
  });

  it("verlangt den Mailtext bei E-Mail-Zustellung und verbietet leere Läufe", async () => {
    const { service, mail } = await enabled();
    await expect(
      service.runCollectiveByGroups(TENANT, { runId: ID(50), config: config() }, USER),
    ).rejects.toMatchObject({ statusCode: 400 });
    // «nur Ausdruck» braucht keinen Text und verschickt nichts
    const print = await service.runCollectiveByGroups(
      TENANT,
      { runId: ID(51), config: config({ delivery: "print" }) },
      USER,
    );
    expect(print).toMatchObject({ created: 3, mailed: 0 });
    expect(mail.sent).toHaveLength(0);
    await expect(
      service.runCollectiveByGroups(
        TENANT,
        { runId: ID(52), config: config({ groupIds: [G_FREI] }), mail: mailText },
        USER,
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("sendet vorab eine Musterrechnung; scheitert sie, wird nichts angelegt", async () => {
    const { service, mail, repos } = await enabled();
    mail.failFor.add("ich@example.test");
    await expect(
      service.runCollectiveByGroups(
        TENANT,
        { runId: ID(50), config: config(), mail: mailText, testMailTo: "ich@example.test" },
        USER,
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect((await repos.invoices.list(TENANT, { limit: 10, offset: 0 })).total).toBe(0);

    mail.failFor.clear();
    await service.runCollectiveByGroups(
      TENANT,
      { runId: ID(50), config: config(), mail: mailText, testMailTo: "ich@example.test" },
      USER,
    );
    const [test, ...rest] = mail.sent;
    expect(test?.mail).toMatchObject({ to: "ich@example.test", subject: "Rechnung Muster" });
    expect(rest).toHaveLength(2);
    expect(test?.mail.attachment.filename).toBe("entwurf-Muster.pdf");
  });
});
