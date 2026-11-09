import { randomUUID } from "node:crypto";
import { Datenbank } from "@stammbuch/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Member } from "../people/domain.js";
import { createPostgresStore } from "../people/postgres.js";
import { createPersonDirectory } from "./directory.js";
import type { InvoiceMail, InvoiceMailPort } from "./mail-port.js";
import { createPgDeps } from "./pg-accounting.js";
import { createPgCollectiveSource } from "./pg-collective.js";
import { InvoiceService } from "./service.js";
import { OTHER_TENANT, TENANT, invoiceInput, settingsInput } from "./test-fixtures.js";
import { PgTestServer } from "./test-pg.js";

// Gegen echtes PostgreSQL (#132): Mitgliedsnummer als Momentaufnahme (Spalte, Trigger), Storno-Mail nach der
// Transaktion, Sammelversand mit Mandantentrennung und Sammellauf in Paketen (eine Transaktion je Paket).
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
  quelle: "manuell",
  zusammengefuehrtMit: null,
  anrede: null,
  vorname: `Vor${n}`,
  nachname: `Nach${n}`,
  email: `m${n}-${kundeId.slice(0, 4)}@example.test`,
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
  erstelltAm: new Date("2026-11-01T00:00:00Z"),
  geaendertAm: new Date("2026-11-01T00:00:00Z"),
  ...over,
});

async function prepared(batch?: number) {
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
    people: createPersonDirectory(people),
    mail,
    ...(batch ? { collectiveBatch: batch } : {}),
    now: () => new Date("2026-11-04T10:00:00Z"),
  });
  await service.saveSettings(TENANT, settingsInput());
  await service.setFeatures(TENANT, { collectiveInvoicing: true });
  await service.saveSettings(OTHER_TENANT, settingsInput());
  return { db, people, service, sent, close: () => db.close() };
}

describe("Mitgliedsnummer in der Rechnung (PostgreSQL)", () => {
  it("speichert die Nummer beim Erfassen und schützt sie nach dem Versenden vor Änderungen", async () => {
    const { db, people, service, close } = await prepared();
    try {
      const m = await people.members.insert(member(TENANT, 1));
      expect(m.mitgliedsnr).toMatch(/^M-\d+$/);
      const draft = await service.createDraft(TENANT, invoiceInput({ customerId: m.id }), USER);
      expect(draft.invoice.memberNumber).toBe(m.mitgliedsnr);

      const sent = await service.send(TENANT, draft.invoice.id, USER);
      expect(sent.invoice.memberNumber).toBe(m.mitgliedsnr);
      expect((await service.get(TENANT, draft.invoice.id)).invoice.memberNumber).toBe(
        m.mitgliedsnr,
      );

      // Der Trigger rechnung_schuetzen sperrt die Spalte wie jede andere nach dem Versenden.
      await expect(
        db.withKunde(TENANT, (trx) =>
          trx
            .updateTable("rechnung")
            .set({ mitgliedsnr: "M-9999", version: 3, geaendert_am: new Date() })
            .where("id", "=", draft.invoice.id)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: "23001" });

      // Auch die Gutschrift des Stornos trägt sie
      await service.cancel(TENANT, draft.invoice.id, USER);
      const notes = await service.list(TENANT, { kind: "credit_note", limit: 5, offset: 0 });
      expect(notes.items.map((i) => i.invoice.memberNumber)).toEqual([m.mitgliedsnr]);
    } finally {
      await close();
    }
  });

  it("nimmt keine Nummer einer Person eines anderen Kunden", async () => {
    const { people, service, close } = await prepared();
    try {
      const foreign = await people.members.insert(member(OTHER_TENANT, 1));
      const draft = await service.createDraft(
        TENANT,
        invoiceInput({ customerId: foreign.id }),
        USER,
      );
      expect(draft.invoice.memberNumber).toBeNull();
    } finally {
      await close();
    }
  });
});

describe("Storno-Mail und Sammelversand (PostgreSQL)", () => {
  it("sendet die Storno-Gutschrift nach der Transaktion; der Sammelversand kennt nur eigene Rechnungen", async () => {
    const { people, service, sent, close } = await prepared();
    try {
      const m = await people.members.insert(member(TENANT, 1));
      const a = await service.send(
        TENANT,
        (await service.createDraft(TENANT, invoiceInput({ customerId: m.id }), USER)).invoice.id,
        USER,
      );
      const b = await service.send(
        TENANT,
        (await service.createDraft(TENANT, invoiceInput({ customerId: m.id }), USER)).invoice.id,
        USER,
      );

      const items = await service.resendInvoices(TENANT, [a.invoice.id, randomUUID()], USER);
      expect(items.map((i) => i.outcome)).toEqual(["sent", "failed"]);
      expect(await service.resendInvoices(OTHER_TENANT, [a.invoice.id], USER)).toEqual([
        { id: a.invoice.id, number: null, outcome: "failed", reason: "not-found" },
      ]);

      const cancelled = await service.cancel(TENANT, b.invoice.id, USER, { notify: true });
      expect(cancelled).toMatchObject({ notification: "sent", invoice: { status: "cancelled" } });
      expect(sent.map((s) => [s.to, s.attachment.filename])).toEqual([
        ["m1-1111@example.test", "Rechnung_RE-2026-0001.pdf"],
        ["m1-1111@example.test", "GS-2026-0001.pdf"],
      ]);
    } finally {
      await close();
    }
  });
});

describe("Sammelrechnung in Paketen (PostgreSQL)", () => {
  it("bucht je Anfrage ein Paket in einer Transaktion; Wiederholung mit derselben Lauf-ID macht weiter", async () => {
    const { people, service, sent, close } = await prepared(2);
    try {
      const g = {
        id: randomUUID(),
        kundeId: TENANT,
        name: "Aktive",
        beschreibung: null,
        erstelltAm: new Date(0),
        geaendertAm: new Date(0),
      };
      await people.gruppen.insert(g);
      const stored: Member[] = [];
      for (let n = 1; n <= 5; n++) {
        const m = await people.members.insert(member(TENANT, n));
        await people.gruppen.assign(TENANT, m.id, g.id);
        stored.push(m);
      }
      await service.setGroupFee(TENANT, g.id, 12000);
      const run = {
        runId: randomUUID(),
        config: {
          year: 2027,
          issueDate: "2026-12-01",
          termDays: 30,
          text: "Mitgliederbeitrag 2027",
          delivery: "email" as const,
          skipLeft: true,
          skipNoFee: true,
          groupIds: [g.id],
        },
        mail: { subject: "Rechnung {number}", message: "Betrag {amount}" },
      };
      const calls = [];
      for (let i = 0; i < 3; i++)
        calls.push(await service.runCollectiveByGroups(TENANT, run, USER));
      expect(calls.map((c) => [c.created, c.skipped, c.remaining])).toEqual([
        [2, 0, 3],
        [2, 2, 1],
        [1, 4, 0],
      ]);
      expect(sent).toHaveLength(5);
      const list = await service.list(TENANT, { kind: "invoice", limit: 10, offset: 0 });
      expect(list.items.map((i) => i.invoice.number).sort()).toEqual([
        "RE-2026-0001",
        "RE-2026-0002",
        "RE-2026-0003",
        "RE-2026-0004",
        "RE-2026-0005",
      ]);
      expect(list.items.map((i) => i.invoice.memberNumber).sort()).toEqual(
        stored.map((m) => m.mitgliedsnr).sort(),
      );
    } finally {
      await close();
    }
  });
});
