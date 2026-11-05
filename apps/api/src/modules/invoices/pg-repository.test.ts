import { Datenbank } from "@stammbuch/db";
import Fastify from "fastify";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { errorHandler } from "../../lib/errors.js";
import { type Actor, PERMISSIONS, createInvoicesModuleFor } from "./index.js";
import { BillingError, type Invoice, type Payment } from "./domain.js";
import { createOpenItemLookup } from "./open-items.js";
import type { AccountingPort } from "./repository.js";
import { InvoiceService } from "./service.js";
import { createPgRepositories } from "./pg-repository.js";
import { OTHER_TENANT, TENANT, invoiceInput, settingsInput } from "./test-fixtures.js";
import { PgTestServer } from "./test-pg.js";

// Integrationstests gegen echtes PostgreSQL: Trigger, Mandantentrennung, Nebenläufigkeit, offene Posten.
const UNIQUE = { code: "23505" };
const IMMUTABLE = { code: "23001" }; // restrict_violation aus den Triggern
const RLS = { code: "42501" };

let server: PgTestServer;
beforeAll(async () => {
  server = await PgTestServer.start();
}, 120_000);
afterAll(() => server?.stop());

type Ctx = Awaited<ReturnType<PgTestServer["newContext"]>>;

async function prepared(opts: { max?: number } = {}) {
  const ctx = await server.newContext("2026-11-04T10:00:00Z", opts);
  await ctx.service.saveSettings(TENANT, settingsInput());
  await ctx.service.saveSettings(OTHER_TENANT, settingsInput());
  return ctx;
}

async function sent(ctx: Ctx, tenant = TENANT) {
  const d = await ctx.service.createDraft(tenant, invoiceInput());
  return ctx.service.send(tenant, d.invoice.id);
}

const asApp = <T>(ctx: Ctx, tenant: string, query: ReturnType<typeof sql<T>>) =>
  ctx.db.withKunde(tenant, (trx) => query.execute(trx));

async function asOwner<T>(ctx: Ctx, fn: (c: pg.Client) => Promise<T>) {
  const c = new pg.Client({ connectionString: ctx.database.ownerUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

describe("Trigger: gebuchte Belege sind unveränderlich", () => {
  let ctx: Ctx;
  let inv: Invoice;
  beforeAll(async () => {
    ctx = await prepared();
    inv = (await sent(ctx)).invoice;
  });

  it("Betrag, Betreff und Referenz lassen sich weder als Anwendung noch als Eigentümer ändern", async () => {
    for (const set of [
      sql`betreff = 'anders'`,
      sql`total_rappen = 1, brutto_rappen = 1`,
      sql`referenz = '000000000000000020260000026'`,
      sql`nummer = 'RE-2026-0099'`,
      sql`debitor = '{"name":"X"}'::jsonb`,
    ]) {
      await expect(
        asApp(
          ctx,
          TENANT,
          sql`UPDATE rechnung SET ${set}, version = version + 1 WHERE id = ${inv.id}`,
        ),
      ).rejects.toMatchObject(IMMUTABLE);
      await expect(
        asOwner(ctx, (c) =>
          c.query(`UPDATE rechnung SET version = version + 1, betreff = 'anders' WHERE id = $1`, [
            inv.id,
          ]),
        ),
      ).rejects.toMatchObject(IMMUTABLE);
    }
  });

  it("der Status darf weiter, aber nie zurück zum Entwurf; die Version zählt um genau eins", async () => {
    await expect(
      asApp(ctx, TENANT, sql`UPDATE rechnung SET status = 'entwurf', version = version + 1 WHERE id = ${inv.id}`),
    ).rejects.toThrow(); // prettier-ignore
    await expect(
      asApp(ctx, TENANT, sql`UPDATE rechnung SET status = 'bezahlt' WHERE id = ${inv.id}`),
    ).rejects.toMatchObject(IMMUTABLE); // Version nicht erhöht
    await expect(
      asApp(ctx, TENANT, sql`UPDATE rechnung SET status = 'bezahlt', version = version + 2 WHERE id = ${inv.id}`),
    ).rejects.toMatchObject(IMMUTABLE); // prettier-ignore
  });

  it("versendete Belege lassen sich nicht löschen (auch nicht als Eigentümer)", async () => {
    const res = await asApp(ctx, TENANT, sql`DELETE FROM rechnung WHERE id = ${inv.id}`);
    expect(res.numAffectedRows).toBe(0n); // RLS-Richtlinie: nur Entwürfe
    await expect(
      asOwner(ctx, (c) => c.query("DELETE FROM rechnung WHERE id = $1", [inv.id])),
    ).rejects.toMatchObject(IMMUTABLE);
  });

  it("Positionen versendeter Belege sind unveränderlich", async () => {
    await expect(
      asApp(ctx, TENANT, sql`DELETE FROM rechnung_position WHERE rechnung_id = ${inv.id}`),
    ).rejects.toMatchObject(IMMUTABLE);
    await expect(
      asOwner(ctx, (c) =>
        c.query("UPDATE rechnung_position SET einzelpreis_rappen = 1 WHERE rechnung_id = $1", [
          inv.id,
        ]),
      ),
    ).rejects.toMatchObject(IMMUTABLE);
    await expect(
      asApp(
        ctx,
        TENANT,
        sql`INSERT INTO rechnung_position (rechnung_id, kunde_id, pos, beschreibung, menge_milli, einzelpreis_rappen, mwst_satz_bp)
            VALUES (${inv.id}, ${TENANT}, 99, 'extra', 1000, 100, 0)`,
      ),
    ).rejects.toMatchObject(IMMUTABLE);
  });

  it("Entwürfe bleiben änderbar und löschbar", async () => {
    const d = await ctx.service.createDraft(TENANT, invoiceInput());
    await ctx.service.updateDraft(TENANT, d.invoice.id, invoiceInput({ subject: "neu" }), 1);
    await ctx.service.deleteDraft(TENANT, d.invoice.id);
    expect(await ctx.repos.invoices.get(TENANT, d.invoice.id)).toBeNull();
  });

  it("Zahlungen und Mahnungen sind nur anhängend", async () => {
    ctx.clock.now = new Date("2026-12-20T10:00:00Z");
    await ctx.service.recordPayment(
      TENANT,
      inv.id,
      { amountCents: 100, paidOn: "2026-12-01" },
      "u1",
    );
    const reminder = await ctx.service.issueReminder(TENANT, inv.id);
    for (const q of [
      sql`UPDATE rechnung_zahlung SET betrag_rappen = 1`,
      sql`DELETE FROM rechnung_zahlung`,
      sql`UPDATE mahnung SET gebuehr_rappen = 0`,
      sql`DELETE FROM mahnung`,
    ])
      await expect(asApp(ctx, TENANT, q)).rejects.toThrow();
    // Auch der Eigentümer kommt nicht heran.
    await expect(asOwner(ctx, (c) => c.query("DELETE FROM mahnung"))).rejects.toMatchObject(
      IMMUTABLE,
    );
    await expect(asOwner(ctx, (c) => c.query("UPDATE rechnung_zahlung SET betrag_rappen = 5"))).rejects.toMatchObject(IMMUTABLE); // prettier-ignore
    expect((await ctx.repos.reminders.listByInvoice(TENANT, inv.id)).map((r) => r.id)).toEqual([
      reminder.id,
    ]);
  });

  it("Mahnstufe pro Rechnung nur einmal (UNIQUE)", async () => {
    const [existing] = await ctx.repos.reminders.listByInvoice(TENANT, inv.id);
    await expect(ctx.repos.reminders.insert({ ...existing!, id: "00000000-0000-4000-8000-0000000000ff" })).rejects.toMatchObject({ statusCode: 409 }); // prettier-ignore
    await expect(
      asOwner(ctx, (c) =>
        c.query(
          `INSERT INTO mahnung (id, kunde_id, rechnung_id, stufe, titel, ausgestellt_am, faellig_am, gebuehr_rappen, offen_rappen, total_rappen, erstellt_am)
           SELECT gen_random_uuid(), kunde_id, rechnung_id, stufe, titel, ausgestellt_am, faellig_am, gebuehr_rappen, offen_rappen, total_rappen, erstellt_am FROM mahnung`,
        ),
      ),
    ).rejects.toMatchObject(UNIQUE);
  });

  it("Zahlungen gibt es nicht zu Entwürfen und Gutschriften", async () => {
    const d = await ctx.service.createDraft(TENANT, invoiceInput());
    await expect(
      asApp(
        ctx,
        TENANT,
        sql`INSERT INTO rechnung_zahlung (id, kunde_id, rechnung_id, betrag_rappen, bezahlt_am, erfasst_am, erfasst_von)
            VALUES (gen_random_uuid(), ${TENANT}, ${d.invoice.id}, 100, '2026-11-10', now(), 'u')`,
      ),
    ).rejects.toMatchObject(IMMUTABLE);
  });

  it("der Nummernkreis läuft nur vorwärts in Einerschritten", async () => {
    for (const set of [sql`letzte_nummer = letzte_nummer - 1`, sql`letzte_nummer = letzte_nummer + 5`, sql`letzte_nummer = 1`])
      await expect(asApp(ctx, TENANT, sql`UPDATE nummernkreis SET ${set}`)).rejects.toMatchObject(IMMUTABLE); // prettier-ignore
    await expect(asApp(ctx, TENANT, sql`DELETE FROM nummernkreis`)).rejects.toThrow();
  });

  it("zwei Belege können nie dieselbe Nummer tragen (auch nicht an der Anwendung vorbei)", async () => {
    const d = await ctx.service.createDraft(TENANT, invoiceInput());
    await expect(
      asOwner(ctx, async (c) => {
        // Entwurf ohne Anwendung "versenden" und die Nummer 1 doppelt vergeben.
        await c.query(
          `UPDATE rechnung SET status = 'versendet', nummer = 'RE-2026-0001', laufnummer = 1,
                  versendet_am = now(), version = version + 1 WHERE id = $1`,
          [d.invoice.id],
        );
      }),
    ).rejects.toMatchObject(UNIQUE);
  });

  it("Vertragsende: Löschen des Kunden entfernt auch gebuchte Belege samt Zahlungen und Mahnungen", async () => {
    const c2 = await prepared();
    c2.clock.now = new Date("2026-12-20T10:00:00Z");
    const s = await sent(c2, OTHER_TENANT);
    await c2.service.recordPayment(
      OTHER_TENANT,
      s.invoice.id,
      { amountCents: 100, paidOn: "2026-12-01" },
      "u",
    );
    await c2.service.issueReminder(OTHER_TENANT, s.invoice.id);
    await asOwner(c2, (c) => c.query("DELETE FROM kunde WHERE id = $1", [OTHER_TENANT]));
    const { rows } = await asOwner(c2, (c) =>
      c.query("SELECT (SELECT count(*) FROM rechnung WHERE kunde_id = $1) AS n", [OTHER_TENANT]),
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});

describe("Mandantentrennung", () => {
  let ctx: Ctx;
  let a: Invoice;
  beforeAll(async () => {
    ctx = await prepared();
    ctx.clock.now = new Date("2026-12-20T10:00:00Z");
    a = (await sent(ctx, TENANT)).invoice;
    await ctx.service.issueReminder(TENANT, a.id);
  });

  it("fremde Belege sind für Repository und Service nicht vorhanden", async () => {
    expect(await ctx.repos.invoices.get(OTHER_TENANT, a.id)).toBeNull();
    expect((await ctx.repos.invoices.list(OTHER_TENANT, { limit: 50, offset: 0 })).total).toBe(0);
    expect(await ctx.repos.invoices.creditNotesOf(OTHER_TENANT, a.id)).toEqual([]);
    expect(await ctx.repos.reminders.listByInvoice(OTHER_TENANT, a.id)).toEqual([]);
    expect(await ctx.repos.invoices.deleteDraft(OTHER_TENANT, a.id)).toBe(false);
    await expect(ctx.service.get(OTHER_TENANT, a.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(ctx.service.send(OTHER_TENANT, a.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      ctx.service.recordPayment(OTHER_TENANT, a.id, { amountCents: 1, paidOn: "2026-12-01" }, "u"),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(ctx.service.issueReminder(OTHER_TENANT, a.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("update fremder Belege ändert nichts und meldet 404", async () => {
    await expect(
      ctx.repos.invoices.update(
        { ...a, tenantId: OTHER_TENANT, version: a.version + 1 },
        a.version,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("Anwendung kann keine Zeilen für einen anderen Mandanten schreiben (RLS)", async () => {
    await expect(
      ctx.repos.invoices.insert({ ...a, id: "00000000-0000-4000-8000-0000000000aa", number: null, seq: null, status: "draft", reference: null, sentAt: null, payments: [], version: 1 }), // prettier-ignore
    ).resolves.toBeUndefined(); // eigener Mandant: ok
    await expect(
      ctx.db.withKunde(OTHER_TENANT, (trx) =>
        trx
          .insertInto("nummernkreis")
          .values({ kunde_id: TENANT, art: "rechnung", jahr: 2026, letzte_nummer: 1 })
          .execute(),
      ),
    ).rejects.toMatchObject(RLS);
    // Gutschrift auf eine Rechnung des anderen Mandanten: Fremdschlüssel verhindert es.
    await expect(
      asOwner(ctx, (c) =>
        c.query(
          `INSERT INTO rechnung (id, kunde_id, art, status, debitor, waehrung, rechnungsdatum, faelligkeitsdatum, mwst_modus, runden_5,
             betreff, notizen, netto_rappen, mwst_rappen, brutto_rappen, rundung_rappen, total_rappen, mwst_saetze, gutschrift_zu, erstellt_am, geaendert_am, version)
           VALUES (gen_random_uuid(), $1, 'gutschrift', 'entwurf', '{}', 'CHF', '2026-11-01', '2026-11-01', 'ohne', false, '', '', 0, 0, 0, 0, 0, '[]', $2, now(), now(), 1)`,
          [OTHER_TENANT, a.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("Einstellungen und Feature-Flags gelten je Mandant", async () => {
    await ctx.service.setFeatures(TENANT, { collectiveInvoicing: true });
    expect((await ctx.service.getSettings(TENANT))?.features.collectiveInvoicing).toBe(true);
    expect((await ctx.service.getSettings(OTHER_TENANT))?.features.collectiveInvoicing).toBe(false);
    const rows = await asApp(ctx, OTHER_TENANT, sql`SELECT kunde_id FROM rechnung_einstellung`);
    expect(rows.rows).toEqual([{ kunde_id: OTHER_TENANT }]);
  });

  it("ohne Mandant liefert jede Rechnungstabelle nichts", async () => {
    for (const t of ["rechnung", "rechnung_position", "rechnung_zahlung", "mahnung", "nummernkreis", "rechnung_einstellung"])
      expect((await sql`SELECT 1 FROM ${sql.table(t)}`.execute(ctx.db.kysely)).rows).toEqual([]); // prettier-ignore
  });
});

describe("Nebenläufigkeit", () => {
  it("parallel versendete Rechnungen erhalten lückenlose, eindeutige Nummern", async () => {
    const ctx = await prepared({ max: 10 });
    const drafts = await Promise.all(
      Array.from({ length: 24 }, () => ctx.service.createDraft(TENANT, invoiceInput())),
    );
    const results = await Promise.all(drafts.map((d) => ctx.service.send(TENANT, d.invoice.id)));
    const seqs = results.map((r) => r.invoice.seq!).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(new Set(results.map((r) => r.invoice.number)).size).toBe(24);
    expect(new Set(results.map((r) => r.invoice.reference?.value)).size).toBe(24);
  });

  it("scheitert das Versenden, wird die Nummer nicht verbraucht (keine Lücke)", async () => {
    const ctx = await prepared({ max: 10 });
    const failing = new Set<string>();
    const accounting: AccountingPort = {
      invoiceBooked: async (i) => {
        if (failing.has(i.id)) throw new Error("Buchhaltung nicht erreichbar");
      },
      paymentRecorded: async () => {},
    };
    const { transaction, ...repos } = createPgRepositories(ctx.db);
    let n = 100;
    const service = new InvoiceService({
      ...repos,
      transaction,
      accounting,
      newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
      now: () => ctx.clock.now,
    });
    const drafts = await Promise.all(
      Array.from({ length: 12 }, () => service.createDraft(TENANT, invoiceInput())),
    );
    drafts.filter((_, i) => i % 3 === 0).forEach((d) => failing.add(d.invoice.id));
    const settled = await Promise.allSettled(drafts.map((d) => service.send(TENANT, d.invoice.id)));
    const ok = settled.filter((s) => s.status === "fulfilled");
    expect(ok).toHaveLength(8);
    const seqs = ok.map((s) => s.value.invoice.seq!).sort((x, y) => x - y);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Die gescheiterten sind weiterhin Entwürfe ohne Nummer und lassen sich später versenden.
    const failedId = [...failing][0]!;
    expect((await service.get(TENANT, failedId)).invoice).toMatchObject({
      status: "draft",
      number: null,
    });
    failing.clear();
    expect((await service.send(TENANT, failedId)).invoice.seq).toBe(9);
  });

  it("Nummernkreise sind getrennt nach Mandant, Belegart und Jahr", async () => {
    const ctx = await prepared();
    const a = await sent(ctx, TENANT);
    const b = await sent(ctx, OTHER_TENANT);
    expect([a.invoice.number, b.invoice.number]).toEqual(["RE-2026-0001", "RE-2026-0001"]);
    const d = await ctx.service.createDraft(TENANT, invoiceInput({ issueDate: "2027-01-05" }));
    expect((await ctx.service.send(TENANT, d.invoice.id)).invoice.number).toBe("RE-2027-0001");
    await ctx.service.cancel(TENANT, a.invoice.id);
    const credits = await ctx.repos.invoices.creditNotesOf(TENANT, a.invoice.id);
    expect(credits.map((c) => c.number)).toEqual(["GS-2026-0001"]);
  });

  it("paralleles Bearbeiten eines Entwurfs: genau ein Schreiber gewinnt", async () => {
    const ctx = await prepared({ max: 10 });
    const d = await ctx.service.createDraft(TENANT, invoiceInput());
    const r = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        ctx.service.updateDraft(TENANT, d.invoice.id, invoiceInput({ subject: `v${i}` }), 1),
      ),
    );
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    for (const x of r.filter((x) => x.status === "rejected"))
      expect((x.reason as BillingError).statusCode).toBe(409);
    expect((await ctx.service.get(TENANT, d.invoice.id)).invoice.version).toBe(2);
  });

  it("parallele Zahlungen: keine geht verloren, keine wird doppelt gezählt", async () => {
    const ctx = await prepared({ max: 10 });
    const s = await sent(ctx);
    const r = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        ctx.service.recordPayment(
          TENANT,
          s.invoice.id,
          { amountCents: 100 + i, paidOn: "2026-11-10" },
          "u",
        ),
      ),
    );
    const won = r.filter((x) => x.status === "fulfilled").length;
    expect(won).toBeGreaterThanOrEqual(1);
    const after = await ctx.service.get(TENANT, s.invoice.id);
    expect(after.invoice.payments).toHaveLength(won);
    expect(after.invoice.version).toBe(s.invoice.version + won);
  });

  it("parallele Mahnungen: pro Stufe genau eine", async () => {
    const ctx = await prepared({ max: 10 });
    ctx.clock.now = new Date("2026-12-20T10:00:00Z");
    const s = await sent(ctx);
    const r = await Promise.allSettled(
      Array.from({ length: 4 }, () => ctx.service.issueReminder(TENANT, s.invoice.id)),
    );
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await ctx.repos.reminders.listByInvoice(TENANT, s.invoice.id)).toHaveLength(1);
  });

  it("Gutschrift und Statusänderung sind atomar: scheitert der Schluss, bleibt nichts zurück", async () => {
    const ctx = await prepared();
    const s = await sent(ctx);
    const accounting: AccountingPort = {
      invoiceBooked: async (i) => {
        if (i.kind === "credit_note") throw new Error("Buchhaltung nicht erreichbar");
      },
      paymentRecorded: async () => {},
    };
    const { transaction, ...repos } = createPgRepositories(ctx.db);
    const service = new InvoiceService({
      ...repos,
      transaction,
      accounting,
      now: () => ctx.clock.now,
    });
    await expect(service.cancel(TENANT, s.invoice.id)).rejects.toThrow("Buchhaltung");
    const after = await ctx.service.get(TENANT, s.invoice.id);
    expect(after.invoice.status).toBe("sent");
    expect((await ctx.repos.invoices.list(TENANT, { limit: 50, offset: 0 })).total).toBe(1);
    // Die Gutschriftsnummer ist nicht verbraucht.
    expect((await ctx.service.cancel(TENANT, s.invoice.id)).invoice.status).toBe("cancelled");
    expect((await ctx.repos.invoices.creditNotesOf(TENANT, s.invoice.id))[0]?.number).toBe(
      "GS-2026-0001",
    );
  });
});

describe("Anbindung Buchhaltung", () => {
  it("meldet versendete Belege und Zahlungen über den Port", async () => {
    const ctx = await prepared();
    const log: string[] = [];
    const accounting: AccountingPort = {
      invoiceBooked: async (i: Invoice) => void log.push(`beleg:${i.number}`),
      paymentRecorded: async (i: Invoice, p: Payment) =>
        void log.push(`zahlung:${i.number}:${p.amountCents}`),
    };
    const { transaction, ...repos } = createPgRepositories(ctx.db);
    const service = new InvoiceService({
      ...repos,
      transaction,
      accounting,
      now: () => ctx.clock.now,
    });
    const d = await service.createDraft(TENANT, invoiceInput());
    await service.send(TENANT, d.invoice.id);
    await service.recordPayment(
      TENANT,
      d.invoice.id,
      { amountCents: 500, paidOn: "2026-11-10" },
      "u",
    );
    expect(log).toEqual(["beleg:RE-2026-0001", "zahlung:RE-2026-0001:500"]);
  });
});

describe("Offene Posten für den CAMT-Import", () => {
  it("liefert versendete, offene Rechnungen mit normalisierter Referenz und Restbetrag", async () => {
    const ctx = await prepared();
    const a = (await sent(ctx)).invoice;
    const lookup = createOpenItemLookup(ctx.db, TENANT);
    const ref = a.reference!.value!;
    const found = await lookup.findByReferences([ref]);
    expect(found).toEqual([
      { id: a.id, reference: ref, amountRappen: a.totals.totalCents, currency: "CHF" },
    ]);
    // Schreibweise mit Leerzeichen (gedruckt) und Kleinschreibung führt zum selben Posten.
    const printed = `${ref.slice(0, 2)} ${ref.slice(2).replace(/(\d{5})(?=\d)/g, "$1 ")}`;
    expect(await lookup.findByReferences([printed, ref, ""])).toHaveLength(1);

    await ctx.service.recordPayment(
      TENANT,
      a.id,
      { amountCents: 10000, paidOn: "2026-11-10" },
      "u",
    );
    expect((await lookup.findByReferences([ref]))[0]?.amountRappen).toBe(
      a.totals.totalCents - 10000,
    );

    await ctx.service.credit(TENANT, a.id, [
      { description: "Rabatt", quantityMilli: 1000, unitCents: 2000, vatRateBp: 0 },
    ]);
    expect((await lookup.findByReferences([ref]))[0]?.amountRappen).toBe(
      a.totals.totalCents - 10000 - 2000,
    );

    await ctx.service.recordPayment(
      TENANT,
      a.id,
      { amountCents: a.totals.totalCents - 12000, paidOn: "2026-11-11" },
      "u",
    );
    expect(await lookup.findByReferences([ref])).toEqual([]); // bezahlt
  });

  it("ignoriert Entwürfe, Gutschriften, stornierte Rechnungen und fremde Mandanten", async () => {
    const ctx = await prepared();
    const draft = await ctx.service.createDraft(TENANT, invoiceInput());
    const cancelled = (await sent(ctx)).invoice;
    await ctx.service.cancel(TENANT, cancelled.id);
    const credit = (await ctx.repos.invoices.creditNotesOf(TENANT, cancelled.id))[0]!;
    const other = (await sent(ctx, OTHER_TENANT)).invoice;
    const lookup = createOpenItemLookup(ctx.db, TENANT);
    const refs = [
      cancelled.reference!.value!,
      credit.reference?.value ?? "0",
      other.reference!.value!,
      draft.invoice.id,
    ];
    expect(await lookup.findByReferences(refs)).toEqual([]);
    expect(
      await createOpenItemLookup(ctx.db, OTHER_TENANT).findByReferences([other.reference!.value!]),
    ).toHaveLength(1);
  });

  it("SCOR-Referenzen (RF…) finden ihre Rechnung ebenfalls", async () => {
    const ctx = await server.newContext();
    await ctx.service.saveSettings(TENANT, settingsInput({ iban: "CH58 0079 1123 0008 8901 2" }));
    const a = (await sent(ctx)).invoice;
    expect(a.reference?.type).toBe("SCOR");
    const lookup = createOpenItemLookup(ctx.db, TENANT);
    expect(await lookup.findByReferences([a.reference!.value!.toLowerCase()])).toHaveLength(1);
  });
});

describe("Verdrahtung der API mit PostgreSQL (DATABASE_URL)", () => {
  const actor = (tenantId: string): Actor => ({
    userId: "u1",
    tenantId,
    permissions: new Set(PERMISSIONS),
  });
  const header = (t: string) => ({ "x-tenant": t });

  it("Standard lehnt ohne Auth ab; mit Auth-Port läuft der ganze Weg über HTTP gegen die Datenbank", async () => {
    const ctx = await server.newContext();
    const config = loadConfig({
      LOG_LEVEL: "silent",
      DATABASE_URL: ctx.database.appUrl,
      FORM_SECRET: Buffer.alloc(32, 1).toString("base64"),
    });

    const closed = await buildApp(config);
    expect((await closed.inject({ method: "GET", url: "/invoices" })).statusCode).toBe(401);
    await closed.close();

    const app = Fastify();
    app.setErrorHandler(errorHandler);
    const db = new Datenbank(ctx.database.appUrl);
    const mod = createInvoicesModuleFor(db, async (req) => {
      const t = req.headers["x-tenant"];
      return typeof t === "string" ? actor(t) : null;
    });
    await app.register(async (scope) => mod.register(scope));
    const put = await app.inject({
      method: "PUT",
      url: "/invoices/settings",
      headers: header(TENANT),
      payload: settingsInput(),
    });
    expect(put.statusCode).toBe(200);
    const created = await app.inject({
      method: "POST",
      url: "/invoices",
      headers: header(TENANT),
      payload: invoiceInput({ customerId: "K1" }), // Versenden bucht die Forderung und braucht die Kundennummer
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const send = await app.inject({
      method: "POST",
      url: `/invoices/${id}/send`,
      headers: header(TENANT),
    });
    expect(send.json()).toMatchObject({ number: "RE-2026-0001", status: "sent" });
    expect(send.json().tenantId).toBeUndefined(); // SR-74
    const pdf = await app.inject({
      method: "GET",
      url: `/invoices/${id}/pdf`,
      headers: header(TENANT),
    });
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    // Anderer Mandant sieht nichts.
    expect(
      (await app.inject({ method: "GET", url: `/invoices/${id}`, headers: header(OTHER_TENANT) }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: "/invoices", headers: header(OTHER_TENANT) })).json()
        .total,
    ).toBe(0);
    await app.close();
    await db.close();
  });
});
