import { describe, expect, it } from "vitest";
import { createMemoryStore as createLedger } from "../accounting/repository.js";
import { AccountingService } from "../accounting/service.js";
import type { Firma, Member } from "../people/domain.js";
import { createMemoryStore as createPeople } from "../people/memory.js";
import { createAccountingPort } from "./accounting-port.js";
import { MemoryGroupFeeStore, createCollectiveSource } from "./collective.js";
import { createPersonDirectory } from "./directory.js";
import type { InvoiceMail, InvoiceMailPort, Sender } from "./mail-port.js";
import {
  MemoryInvoiceRepository,
  MemoryReminderRepository,
  MemorySettingsRepository,
} from "./memory.js";
import { RESEND_BATCH_MAX } from "./schemas.js";
import { InvoiceService } from "./service.js";
import { OTHER_TENANT, TENANT, invoiceInput, settingsInput } from "./test-fixtures.js";

// Ausgeblendete Funktionen (#132): Mitgliedsnummer in der Rechnung, Storno-Mail, Sammelversand, Lauf in Paketen.
const USER = "u1";
const NOW = new Date("2026-11-04T10:00:00Z");
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const addr = { strasse: "Dorfstrasse", hausnr: "3", plz: "3000", ort: "Bern", land: "CH" };

class FakeMail implements InvoiceMailPort {
  sent: { from: Sender; mail: InvoiceMail }[] = [];
  failFor = new Set<string>();
  async send(from: Sender, mail: InvoiceMail) {
    if (this.failFor.has(mail.to)) throw new Error("SMTP 550 intern: konto xy");
    this.sent.push({ from, mail });
  }
}

const member = (n: number, over: Partial<Member> = {}): Member => ({
  id: ID(100 + n),
  kundeId: TENANT,
  typ: "einzel",
  status: "aktiv",
  quelle: "manuell",
  zusammengefuehrtMit: null,
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

function setup(options: { batch?: number; withMail?: boolean } = {}) {
  const clock = { now: NOW };
  const ledger = new AccountingService(createLedger(), () => clock.now);
  const people = createPeople();
  const fees = new MemoryGroupFeeStore();
  const mail = new FakeMail();
  const repos = {
    invoices: new MemoryInvoiceRepository(),
    reminders: new MemoryReminderRepository(),
    settings: new MemorySettingsRepository(),
  };
  let n = 10_000;
  const serviceFor = (tenantId: string) =>
    new InvoiceService({
      ...repos,
      accounting: createAccountingPort(ledger, { tenantId, userId: USER }),
      collective: createCollectiveSource(people, fees),
      people: createPersonDirectory(people),
      ...(options.withMail === false ? {} : { mail }),
      ...(options.batch ? { collectiveBatch: options.batch } : {}),
      now: () => clock.now,
      newId: () => ID(++n),
    });
  const service = serviceFor(TENANT);
  const ready = async () => {
    await service.saveSettings(TENANT, settingsInput());
    return service;
  };
  /** Rechnung an eine Person: gebucht (`sent`) oder nur Entwurf. */
  const invoiceTo = async (customerId: string | undefined, book = true) => {
    const d = await service.createDraft(
      TENANT,
      invoiceInput(customerId ? { customerId } : {}),
      USER,
    );
    return book ? service.send(TENANT, d.invoice.id, USER) : d;
  };
  return { service, serviceFor, ready, invoiceTo, mail, people, fees, repos, clock };
}

describe("Mitgliedsnummer in der Rechnung", () => {
  it("hält die Nummer der Person beim Erfassen fest und behält sie über Buchung und Gutschrift", async () => {
    const { ready, people, invoiceTo, service } = setup();
    await ready();
    const m = await people.members.insert(member(1));
    expect(m.mitgliedsnr).toMatch(/^M-\d+$/);

    const draft = await invoiceTo(m.id, false);
    expect(draft.invoice.memberNumber).toBe(m.mitgliedsnr);
    const sent = await service.send(TENANT, draft.invoice.id, USER);
    expect(sent.invoice.memberNumber).toBe(m.mitgliedsnr);

    const cancelled = await service.cancel(TENANT, sent.invoice.id, USER);
    expect(cancelled.invoice.memberNumber).toBe(m.mitgliedsnr);
    const [note] = await setupNotes(service, sent.invoice.id);
    expect(note?.memberNumber).toBe(m.mitgliedsnr);
  });

  async function setupNotes(service: InvoiceService, id: string) {
    const all = await service.list(TENANT, { kind: "credit_note", limit: 10, offset: 0 });
    return all.items.map((i) => i.invoice).filter((i) => i.creditNoteOf === id);
  }

  it("ändert beim Bearbeiten des Entwurfs mit dem Empfänger; Firmen und Freitext haben keine", async () => {
    const { ready, people, invoiceTo, service } = setup();
    await ready();
    const a = await people.members.insert(member(1));
    const b = await people.members.insert(member(2));
    const firma: Firma = {
      id: ID(900),
      kundeId: TENANT,
      name: "Beispiel AG",
      uid: null,
      mwstNr: null,
      adresse: addr,
      email: "info@beispiel.example",
      telefon: null,
      status: "freigegeben",
      zusammengefuehrtMit: null,
      erstelltAm: NOW,
      kontaktperson: null,
      rechnungsEmail: "kasse@beispiel.example",
      notiz: null,
      quelle: "manuell",
      erfasstVonId: null,
    };
    await people.firmen.insert(firma);

    const d = await invoiceTo(a.id, false);
    const input = (customerId: string) => invoiceInput({ customerId });
    const toB = await service.updateDraft(TENANT, d.invoice.id, input(b.id), d.invoice.version);
    expect(toB.invoice.memberNumber).toBe(b.mitgliedsnr);
    expect(b.mitgliedsnr).not.toBe(a.mitgliedsnr);
    const toFirma = await service.updateDraft(
      TENANT,
      d.invoice.id,
      input(firma.id),
      toB.invoice.version,
    );
    expect(toFirma.invoice.memberNumber).toBeNull();
    const free = await invoiceTo("K-1042", false);
    expect(free.invoice.memberNumber).toBeNull();
    expect((await invoiceTo(undefined, false)).invoice.memberNumber).toBeNull();
  });

  it("kennt keine Nummer aus einem anderen Mandanten", async () => {
    const { ready, people, serviceFor } = setup();
    await ready();
    const foreign = await people.members.insert(member(1, { kundeId: OTHER_TENANT }));
    const draft = await serviceFor(TENANT).createDraft(
      TENANT,
      invoiceInput({ customerId: foreign.id }),
    );
    expect(draft.invoice.memberNumber).toBeNull();
  });

  it("macht die Nummer nach dem Buchen unveränderlich", async () => {
    const { ready, people, invoiceTo, repos } = setup();
    await ready();
    const m = await people.members.insert(member(1));
    const sent = await invoiceTo(m.id);
    await expect(
      repos.invoices.update(
        { ...sent.invoice, memberNumber: "M-9999", version: sent.invoice.version + 1 },
        sent.invoice.version,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("holt die Nummer beim Buchen nach, wenn ein Entwurf keine Momentaufnahme hat", async () => {
    const { ready, people, invoiceTo, service, repos } = setup();
    await ready();
    const m = await people.members.insert(member(1));
    const d = await invoiceTo(m.id, false);
    await repos.invoices.update({ ...d.invoice, memberNumber: null, version: 2 }, 1);
    const sent = await service.send(TENANT, d.invoice.id, USER);
    expect(sent.invoice.memberNumber).toBe(m.mitgliedsnr);
  });

  it("steht im PDF der Rechnung (und nicht mehr die interne Personen-ID)", async () => {
    const { ready, people, invoiceTo, service } = setup();
    await ready();
    const m = await people.members.insert(member(1));
    const sent = await invoiceTo(m.id);
    const { pdf } = await service.invoicePdf(TENANT, sent.invoice.id);
    const text = await pdfText(pdf);
    expect(text).toContain(hex("Mitgl.-Nr."));
    expect(text).toContain(hex(m.mitgliedsnr));
    expect(text).not.toContain(hex(m.id));
  });

  it("nimmt die Nummer der Sammelrechnung aus dem Personenmodul", async () => {
    const ctx = setup();
    const service = await ctx.ready();
    await service.setFeatures(TENANT, { collectiveInvoicing: true });
    await ctx.people.gruppen.insert({
      id: ID(1),
      kundeId: TENANT,
      name: "Aktive",
      beschreibung: null,
      erstelltAm: NOW,
      geaendertAm: NOW,
    });
    const m = await ctx.people.members.insert(member(1));
    await ctx.people.gruppen.assign(TENANT, m.id, ID(1));
    await ctx.fees.set(TENANT, ID(1), 12000);
    await service.runCollectiveByGroups(
      TENANT,
      {
        runId: ID(50),
        config: {
          year: 2027,
          issueDate: "2026-12-01",
          termDays: 30,
          text: "Beitrag",
          delivery: "print",
          skipLeft: true,
          skipNoFee: true,
          groupIds: [ID(1)],
        },
      },
      USER,
    );
    const [inv] = (await service.list(TENANT, { limit: 5, offset: 0 })).items;
    expect(inv?.invoice.memberNumber).toBe(m.mitgliedsnr);
  });
});

/** Inhalt aller Seiten als Text (Schrift als Hex), wie in pdf.test.ts. */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  return doc
    .getPages()
    .map((page) => {
      const contents = page.node.Contents();
      const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
      return streams
        .map((ref) => {
          const s = page.doc.context.lookup(ref);
          return s instanceof PDFRawStream
            ? Buffer.from(decodePDFRawStream(s).decode()).toString("latin1")
            : "";
        })
        .join("\n");
    })
    .join("\n");
}
const hex = (s: string) => Buffer.from(s, "latin1").toString("hex").toUpperCase();

describe("Storno mit Benachrichtigung", () => {
  it("sendet die Storno-Gutschrift als PDF an die Person und meldet «sent»", async () => {
    const { ready, people, invoiceTo, service, mail } = setup();
    await ready();
    const m = await people.members.insert(member(1));
    const sent = await invoiceTo(m.id);
    const view = await service.cancel(TENANT, sent.invoice.id, USER, {
      reason: "Falscher Betrag",
      remark: "intern",
      notify: true,
    });
    expect(view.invoice.status).toBe("cancelled");
    expect(view.notification).toBe("sent");
    const [one] = mail.sent;
    expect(mail.sent).toHaveLength(1);
    expect(one?.from).toEqual({ tenantId: TENANT, userId: USER });
    expect(one?.mail.to).toBe("m1@example.test");
    expect(one?.mail.subject).toBe("Storno der Rechnung RE-2026-0001");
    expect(one?.mail.text).toContain("Gutschrift GS-2026-0001");
    expect(one?.mail.text).toContain("CHF 265.94");
    expect(one?.mail.text).toContain("Musterverein Beispielstadt");
    // Grund und interne Bemerkung gehen nicht an den Kunden
    expect(one?.mail.text).not.toMatch(/Falscher Betrag|intern/);
    expect(one?.mail.attachment.filename).toBe("GS-2026-0001.pdf");
    expect(Buffer.from(one!.mail.attachment.bytes).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("sendet ohne Wunsch nichts und lässt «notification» weg", async () => {
    const { ready, people, invoiceTo, service, mail } = setup();
    await ready();
    const m = await people.members.insert(member(1));
    const view = await service.cancel(TENANT, (await invoiceTo(m.id)).invoice.id, USER);
    expect(view.notification).toBeUndefined();
    expect(mail.sent).toHaveLength(0);
  });

  it("überspringt Personen ohne E-Mail-Adresse und Rechnungen ohne bekannte Person (Storno besteht)", async () => {
    const { ready, people, invoiceTo, service, mail } = setup();
    await ready();
    const m = await people.members.insert(member(1, { email: null }));
    const a = await service.cancel(TENANT, (await invoiceTo(m.id)).invoice.id, USER, {
      notify: true,
    });
    expect([a.invoice.status, a.notification]).toEqual(["cancelled", "no-address"]);
    const b = await service.cancel(TENANT, (await invoiceTo("K-1")).invoice.id, USER, {
      notify: true,
    });
    expect([b.invoice.status, b.notification]).toEqual(["cancelled", "no-address"]);
    expect(mail.sent).toHaveLength(0);
  });

  it("lässt das Storno bei einem Mailfehler bestehen und meldet «failed» ohne Mail-Interna (SR-51)", async () => {
    const { ready, people, invoiceTo, service, mail } = setup();
    await ready();
    const m = await people.members.insert(member(1));
    mail.failFor.add("m1@example.test");
    const view = await service.cancel(TENANT, (await invoiceTo(m.id)).invoice.id, USER, {
      notify: true,
    });
    expect(view.invoice.status).toBe("cancelled");
    expect(view.notification).toBe("failed");
    expect(JSON.stringify(view)).not.toMatch(/SMTP|konto xy/);
    // Die Gutschrift ist gebucht, auch wenn die Mail fehlte
    const notes = await service.list(TENANT, { kind: "credit_note", limit: 5, offset: 0 });
    expect(notes.total).toBe(1);
  });

  it("meldet «failed», wenn kein Mailkonto eingerichtet ist", async () => {
    const { ready, people, invoiceTo, service } = setup({ withMail: false });
    await ready();
    const m = await people.members.insert(member(1));
    const view = await service.cancel(TENANT, (await invoiceTo(m.id)).invoice.id, USER, {
      notify: true,
    });
    expect([view.invoice.status, view.notification]).toEqual(["cancelled", "failed"]);
  });

  it("storniert nichts und sendet nichts bei Rechnungen mit Zahlung oder fremdem Mandanten", async () => {
    const { ready, people, invoiceTo, service, serviceFor, mail } = setup();
    await ready();
    const m = await people.members.insert(member(1));
    const sent = await invoiceTo(m.id);
    await expect(
      serviceFor(OTHER_TENANT).cancel(OTHER_TENANT, sent.invoice.id, USER, { notify: true }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await service.recordPayment(
      TENANT,
      sent.invoice.id,
      { amountCents: 100, paidOn: "2026-11-05" },
      USER,
    );
    await expect(
      service.cancel(TENANT, sent.invoice.id, USER, { notify: true }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mail.sent).toHaveLength(0);
  });
});

describe("Sammelaktion «Rechnungen erneut senden»", () => {
  it("meldet je Rechnung gesendet, übersprungen oder Fehler", async () => {
    const { ready, people, invoiceTo, service, mail } = setup();
    await ready();
    const withMail = await people.members.insert(member(1));
    const noMail = await people.members.insert(member(2, { email: null }));
    const failing = await people.members.insert(member(3));
    mail.failFor.add("m3@example.test");

    const ok = await invoiceTo(withMail.id);
    const skipped = await invoiceTo(noMail.id);
    const free = await invoiceTo("K-1");
    const failed = await invoiceTo(failing.id);
    const draft = await invoiceTo(withMail.id, false);
    const cancelled = await invoiceTo(withMail.id);
    await service.cancel(TENANT, cancelled.invoice.id, USER);

    const ids = [
      ok.invoice.id,
      skipped.invoice.id,
      free.invoice.id,
      failed.invoice.id,
      draft.invoice.id,
      cancelled.invoice.id,
      ID(99_999),
      ok.invoice.id,
    ];
    const items = await service.resendInvoices(TENANT, ids, USER);
    expect(items.map((i) => [i.number, i.outcome, i.reason])).toEqual([
      [ok.invoice.number, "sent", undefined],
      [skipped.invoice.number, "skipped", "no-address"],
      [free.invoice.number, "skipped", "no-address"],
      [failed.invoice.number, "failed", "queue"],
      [null, "skipped", "not-sendable"],
      [cancelled.invoice.number, "skipped", "not-sendable"],
      [null, "failed", "not-found"],
    ]);
    expect(mail.sent).toHaveLength(1);
    // Zustellfehler steht nur an der gescheiterten Rechnung
    const flagged = await Promise.all(
      [ok, failed].map(async (v) => (await service.get(TENANT, v.invoice.id)).invoice.mailFailedAt),
    );
    expect(flagged.map((f) => f !== null)).toEqual([false, true]);
    const [one] = mail.sent;
    expect(one?.mail.to).toBe("m1@example.test");
    expect(one?.mail.subject).toBe("Rechnung RE-2026-0001 vom 01.11.2026");
    expect(one?.mail.text).toContain(
      "Rechnung RE-2026-0001 über CHF 265.94, zahlbar bis 01.12.2026",
    );
    expect(one?.mail.attachment.filename).toBe("Rechnung_RE-2026-0001.pdf");
    expect(JSON.stringify(items)).not.toMatch(/SMTP|konto xy/);
  });

  it("begrenzt auf die Obergrenze, verlangt Rechnungen und Mailkonto", async () => {
    const { ready, service } = setup();
    await ready();
    const many = Array.from({ length: RESEND_BATCH_MAX + 1 }, (_, i) => ID(i + 1));
    await expect(service.resendInvoices(TENANT, many, USER)).rejects.toMatchObject({
      statusCode: 422,
    });
    await expect(service.resendInvoices(TENANT, [], USER)).rejects.toMatchObject({
      statusCode: 400,
    });
    const none = setup({ withMail: false });
    await none.ready();
    await expect(none.service.resendInvoices(TENANT, [ID(1)], USER)).rejects.toMatchObject({
      statusCode: 422,
      message: "Der E-Mail-Versand ist nicht eingerichtet.",
    });
  });

  it("zählt gleiche IDs einmal und kennt keine Rechnungen anderer Mandanten", async () => {
    const { ready, people, invoiceTo, serviceFor, mail } = setup();
    await ready();
    const m = await people.members.insert(member(1));
    const inv = await invoiceTo(m.id);
    const other = serviceFor(OTHER_TENANT);
    await other.saveSettings(OTHER_TENANT, settingsInput());
    expect(await other.resendInvoices(OTHER_TENANT, [inv.invoice.id], USER)).toEqual([
      { id: inv.invoice.id, number: null, outcome: "failed", reason: "not-found" },
    ]);
    expect(mail.sent).toHaveLength(0);
  });
});

describe("Sammelrechnung in Paketen", () => {
  async function prepare(persons: number, batch: number) {
    const ctx = setup({ batch });
    const service = await ctx.ready();
    await service.setFeatures(TENANT, { collectiveInvoicing: true });
    await ctx.people.gruppen.insert({
      id: ID(1),
      kundeId: TENANT,
      name: "Aktive",
      beschreibung: null,
      erstelltAm: NOW,
      geaendertAm: NOW,
    });
    for (let n = 1; n <= persons; n++) {
      const m = await ctx.people.members.insert(member(n));
      await ctx.people.gruppen.assign(TENANT, m.id, ID(1));
    }
    await ctx.fees.set(TENANT, ID(1), 12000);
    const input = {
      runId: ID(50),
      config: {
        year: 2027,
        issueDate: "2026-12-01",
        termDays: 30,
        text: "Beitrag",
        delivery: "email" as const,
        skipLeft: true,
        skipNoFee: true,
        groupIds: [ID(1)],
      },
      mail: { subject: "Rechnung {number}", message: "Betrag {amount}" },
    };
    return { ...ctx, service, input };
  }

  it("bucht je Anfrage höchstens ein Paket und meldet den Rest; Wiederholung macht weiter", async () => {
    const { service, input, mail, repos } = await prepare(5, 2);
    const calls: Awaited<ReturnType<typeof service.runCollectiveByGroups>>[] = [];
    for (let i = 0; i < 3; i++)
      calls.push(await service.runCollectiveByGroups(TENANT, input, USER));
    expect(calls.map((c) => [c.created, c.skipped, c.remaining, c.mailed])).toEqual([
      [2, 0, 3, 2],
      [2, 2, 1, 2],
      [1, 4, 0, 1],
    ]);
    // Nichts doppelt: fünf Rechnungen, fünf Mails, lückenlose Nummern
    const all = await repos.invoices.list(TENANT, { limit: 50, offset: 0 });
    expect(all.items.map((i) => i.number).sort()).toEqual([
      "RE-2026-0001",
      "RE-2026-0002",
      "RE-2026-0003",
      "RE-2026-0004",
      "RE-2026-0005",
    ]);
    expect(mail.sent).toHaveLength(5);
    expect(new Set(mail.sent.map((m) => m.mail.to)).size).toBe(5);
    const extra = await service.runCollectiveByGroups(TENANT, input, USER);
    expect([extra.created, extra.mailed, extra.skipped, extra.remaining]).toEqual([0, 0, 5, 0]);
  });
});
