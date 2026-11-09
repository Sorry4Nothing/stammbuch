import { randomUUID } from "node:crypto";
import { Datenbank } from "@stammbuch/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Member } from "../people/domain.js";
import { createPostgresStore } from "../people/postgres.js";
import type { InvoiceMail, InvoiceMailPort } from "./mail-port.js";
import { createPgDeps } from "./pg-accounting.js";
import { createPgCollectiveSource, createPgGroupFeeStore } from "./pg-collective.js";
import { createPgRepositories } from "./pg-repository.js";
import { InvoiceService } from "./service.js";
import { OTHER_TENANT, TENANT, invoiceInput, settingsInput } from "./test-fixtures.js";
import { PgTestServer } from "./test-pg.js";

// Gegen echtes PostgreSQL: Beitrag je Gruppe (RLS, Fremdschlüssel), Nummernvorschau, Lauf mit Buchung in der
// Transaktion und Buchungen je Rechnung.
const USER = "11111111-aaaa-4aaa-8aaa-111111111111";
let server: PgTestServer;
beforeAll(async () => {
  server = await PgTestServer.start();
}, 120_000);
afterAll(() => server?.stop());

const addr = { strasse: "Dorfstrasse", hausnr: "3", plz: "3000", ort: "Bern", land: "CH" };
const member = (kundeId: string, n: number, over: Partial<Member> = {}): Member => ({
  id: randomUUID(),
  kundeId,
  typ: "einzel",
  status: "aktiv",
  anrede: null,
  vorname: `Vor${n}`,
  nachname: `Nach${n}`,
  email: `m${n}-${kundeId.slice(0, 4)}@example.test`,
  telefon: null,
  mobil: null,
  adresse: addr,
  notiz: null,
  geburtsdatum: null,
  funktion: null,
  firmaId: null,
  gruppeId: null,
  erstelltAm: new Date("2026-11-01T00:00:00Z"),
  geaendertAm: new Date("2026-11-01T00:00:00Z"),
  ...over,
});

async function prepared() {
  const database = await server.newDatabase();
  const db = new Datenbank(database.appUrl);
  const people = createPostgresStore(db);
  const sent: InvoiceMail[] = [];
  const mail: InvoiceMailPort = {
    send: async (_f, m) => {
      sent.push(m);
    },
  };
  const service = new InvoiceService({
    ...createPgDeps(db),
    collective: createPgCollectiveSource(db),
    mail,
    now: () => new Date("2026-11-04T10:00:00Z"),
  });
  await service.saveSettings(TENANT, settingsInput());
  await service.setFeatures(TENANT, { collectiveInvoicing: true });
  await service.saveSettings(OTHER_TENANT, settingsInput());
  return { db, people, service, sent, close: () => db.close() };
}

const config = (groupIds: string[]) => ({
  year: 2027,
  issueDate: "2026-12-01",
  termDays: 30,
  text: "Mitgliederbeitrag 2027",
  delivery: "email-or-print" as const,
  skipLeft: true,
  skipNoFee: true,
  groupIds,
});

describe("Beitrag je Gruppe (PostgreSQL)", () => {
  it("speichert, ändert und entfernt den Beitrag; Kunden sehen nur ihre eigenen", async () => {
    const { db, people, close } = await prepared();
    try {
      const fees = createPgGroupFeeStore(db);
      const g = { id: randomUUID(), kundeId: TENANT, name: "Aktive" };
      await people.gruppen.insert(g);
      await fees.set(TENANT, g.id, 12000);
      await fees.set(TENANT, g.id, 15000);
      expect([...(await fees.list(TENANT))]).toEqual([[g.id, 15000]]);
      expect((await fees.list(OTHER_TENANT)).size).toBe(0);
      await fees.set(TENANT, g.id, null);
      expect((await fees.list(TENANT)).size).toBe(0);
    } finally {
      await close();
    }
  });

  it("verweigert einen Beitrag für die Gruppe eines anderen Kunden (RLS, Fremdschlüssel)", async () => {
    const { db, people, close } = await prepared();
    try {
      const g = { id: randomUUID(), kundeId: TENANT, name: "Aktive" };
      await people.gruppen.insert(g);
      const fees = createPgGroupFeeStore(db);
      await expect(fees.set(OTHER_TENANT, g.id, 100)).rejects.toMatchObject({ code: "23503" });
      // Ein Beitrag mit fremder kunde_id scheitert an der Richtlinie, auch wenn die Anwendung ihn versuchte
      await expect(
        db.withKunde(OTHER_TENANT, (trx) =>
          trx
            .insertInto("rechnung_gruppenbeitrag")
            .values({ kunde_id: TENANT, gruppe_id: g.id, beitrag_rappen: 100 })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      // CHECK: positiver, begrenzter Betrag
      await expect(createPgGroupFeeStore(db).set(TENANT, g.id, 0)).rejects.toMatchObject({
        code: "23514",
      });
    } finally {
      await close();
    }
  });

  it("lastSeq liest den Nummernkreis, ohne eine Nummer zu vergeben", async () => {
    const { db, close } = await prepared();
    try {
      const { invoices } = createPgRepositories(db);
      expect(await invoices.lastSeq(TENANT, "invoice", 2026)).toBe(0);
      await invoices.nextSeq(TENANT, "invoice", 2026);
      expect(await invoices.lastSeq(TENANT, "invoice", 2026)).toBe(1);
      expect(await invoices.lastSeq(TENANT, "invoice", 2026)).toBe(1);
      expect(await invoices.lastSeq(OTHER_TENANT, "invoice", 2026)).toBe(0);
    } finally {
      await close();
    }
  });
});

describe("Sammelrechnung nach Gruppen (PostgreSQL)", () => {
  it("Vorschau, Lauf mit Buchung in der Transaktion, Wiederholung folgenlos, Buchungen je Rechnung", async () => {
    const { people, service, sent, close } = await prepared();
    try {
      const g = { id: randomUUID(), kundeId: TENANT, name: "Aktive" };
      await people.gruppen.insert(g);
      for (const m of [member(TENANT, 1), member(TENANT, 2, { email: null })]) {
        await people.members.insert(m);
        await people.gruppen.assign(TENANT, m.id, g.id);
      }
      await service.setGroupFee(TENANT, g.id, 12000);

      const setup = await service.collectiveSetup(TENANT);
      expect(setup.groups).toEqual([{ id: g.id, name: "Aktive", feeCents: 12000, persons: 2 }]);
      const preview = await service.collectivePreview(TENANT, config([g.id]));
      expect(preview.rows.map((r) => [r.number, r.delivery])).toEqual([
        ["RE-2026-0001", "email"],
        ["RE-2026-0002", "print"],
      ]);

      const run = {
        runId: randomUUID(),
        config: config([g.id]),
        mail: { subject: "Rechnung {number}", message: "Betrag {amount}" },
      };
      const first = await service.runCollectiveByGroups(TENANT, run, USER);
      expect(first).toEqual({ created: 2, mailed: 1, notMailed: 0, skipped: 0 });
      expect(sent.map((m) => [m.subject, m.text])).toEqual([
        ["Rechnung RE-2026-0001", "Betrag CHF 120.00"],
      ]);
      expect(await service.runCollectiveByGroups(TENANT, run, USER)).toMatchObject({
        created: 0,
        skipped: 2,
      });

      const list = await service.list(TENANT, { kind: "invoice", limit: 10, offset: 0 });
      expect(
        list.items.map((i) => [i.invoice.number, i.invoice.status, i.openCents]).sort(),
      ).toEqual([
        ["RE-2026-0001", "sent", 12000],
        ["RE-2026-0002", "sent", 12000],
      ]);
      const [entry] = await service.bookings(TENANT, list.items[0]!.invoice.id, USER);
      expect(entry).toMatchObject({
        kind: "invoice",
        description: expect.stringContaining("RE-2026-"),
      });
      expect(entry?.lines.map((l) => [l.accountCode, l.side, l.amountCents]).sort()).toEqual([
        ["1100", "debit", 12000],
        ["3000", "credit", 12000],
      ]);
      // Anderer Kunde: keine Gruppen, keine Rechnungen
      expect(
        await service.list(OTHER_TENANT, { kind: "invoice", limit: 10, offset: 0 }),
      ).toMatchObject({
        total: 0,
      });
    } finally {
      await close();
    }
  });

  it("Buchungen je Rechnung mit Zahlung und Storno aus der echten Buchhaltung", async () => {
    const { service, close } = await prepared();
    try {
      const book = async () => {
        const d = await service.createDraft(TENANT, invoiceInput({ customerId: "K1" }));
        return service.send(TENANT, d.invoice.id, USER);
      };
      const a = await book();
      await service.recordPayment(
        TENANT,
        a.invoice.id,
        { amountCents: 26594, paidOn: "2026-11-10" },
        USER,
      );
      expect((await service.bookings(TENANT, a.invoice.id, USER)).map((e) => e.kind)).toEqual([
        "invoice",
        "payment",
      ]);
      const b = await book();
      await service.cancel(TENANT, b.invoice.id, USER, { reason: "Doppelt erstellt" });
      expect((await service.bookings(TENANT, b.invoice.id, USER)).map((e) => e.kind)).toEqual([
        "invoice",
        "credit_note",
      ]);
      await expect(service.bookings(OTHER_TENANT, a.invoice.id, USER)).rejects.toMatchObject({
        statusCode: 404,
      });
    } finally {
      await close();
    }
  });
});
