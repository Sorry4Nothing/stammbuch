import { isDeepStrictEqual } from "node:util";
import type { Database, Datenbank } from "@stammbuch/db";
import { type Transaction, sql } from "kysely";
import {
  BillingError,
  type Invoice,
  type InvoiceKind,
  type InvoiceLine,
  type Payment,
  type Totals,
  frozenView,
} from "./domain.js";
import type { DunningConfig, Reminder } from "./dunning.js";
import type {
  BillingSettings,
  InvoiceQuery,
  InvoiceRepository,
  ReminderRepository,
  SettingsRepository,
} from "./repository.js";
import type { Repositories } from "./service.js";

/**
 * PostgreSQL-Umsetzung der Repositories (Kysely). Jede Methode läuft im Mandanten der Sitzung: die
 * Zeilensicherheit (RLS) der Datenbank trennt die Kunden, die `kunde_id`-Bedingungen hier sind die zweite Linie.
 */
type Trx = Transaction<Database>;
type Run = <T>(tenantId: string, fn: (trx: Trx) => Promise<T>) => Promise<T>;

const KIND = { invoice: "rechnung", credit_note: "gutschrift" } as const;
const KIND_BACK = { rechnung: "invoice", gutschrift: "credit_note" } as const;
const STATUS = {
  draft: "entwurf",
  sent: "versendet",
  paid: "bezahlt",
  cancelled: "storniert",
} as const;
const STATUS_BACK = {
  entwurf: "draft",
  versendet: "sent",
  bezahlt: "paid",
  storniert: "cancelled",
} as const;
const VAT = { none: "ohne", exclusive: "exklusiv" } as const;
const VAT_BACK = { ohne: "none", exklusiv: "exclusive" } as const;

const json = (v: unknown) => JSON.stringify(v);
/** Rappen kommen als bigint-String aus dem Treiber. */
const n = (v: string | number) => Number(v);
const iso = (d: Date | string) => new Date(d).toISOString();

/** Übersetzt Datenbankfehler, die einen fachlichen Konflikt bedeuten, in einen 409. */
function translate(e: unknown, uniqueMessage = "Eintrag existiert bereits."): never {
  const code = (e as { code?: string } | null)?.code;
  if (code === "23505") throw new BillingError(409, uniqueMessage);
  if (code === "23001") throw new BillingError(409, "Gebuchte Belege sind unveränderlich.");
  throw e;
}

const reposFor = (run: Run): Repositories => ({
  invoices: new PgInvoiceRepository(run),
  reminders: new PgReminderRepository(run),
  settings: new PgSettingsRepository(run),
});

/** Repositories auf einer bereits offenen Transaktion eines Mandanten (z. B. aus dem CAMT-Import). */
export function createPgRepositoriesOn(trx: Trx, tenant: string): Repositories {
  return reposFor((tenantId, fn) => {
    // Fail secure: eine gebundene Transaktion gilt nur für ihren Mandanten.
    if (tenantId !== tenant) throw new Error("Mandant passt nicht zur Transaktion");
    return fn(trx);
  });
}

/** Verbindet die Repositories mit einer `Datenbank`: jeder Aufruf ist eine eigene Transaktion. */
export function createPgRepositories(db: Datenbank) {
  const standalone: Run = (tenantId, fn) => db.withKunde(tenantId, fn);
  return {
    ...reposFor(standalone),
    /** Für \`ServiceDeps.transaction\`: alle Repositories teilen sich eine Transaktion. */
    transaction: <T>(tenantId: string, fn: (repos: Repositories) => Promise<T>): Promise<T> =>
      db.withKunde(tenantId, (trx) => fn(createPgRepositoriesOn(trx, tenantId))),
  };
}

// --- Rechnungen -------------------------------------------------------------------------------------

function selectInvoices(trx: Trx) {
  return trx
    .selectFrom("rechnung")
    .select([
      "id",
      "kunde_id",
      "art",
      "status",
      "nummer",
      "laufnummer",
      "kundennummer",
      "mitgliedsnr",
      "debitor",
      "waehrung",
      "mwst_modus",
      "runden_5",
      "betreff",
      "notizen",
      "netto_rappen",
      "mwst_rappen",
      "brutto_rappen",
      "rundung_rappen",
      "total_rappen",
      "mwst_saetze",
      "referenz_art",
      "referenz",
      "gutschrift_zu",
      "sammellauf_id",
      "zahler_key",
      "versendet_am",
      "mail_fehler_am",
      "erstellt_am",
      "geaendert_am",
      "version",
    ]) // prettier-ignore
    .select([
      sql<string>`rechnungsdatum::text`.as("rechnungsdatum"),
      sql<string>`faelligkeitsdatum::text`.as("faelligkeitsdatum"),
    ]);
}

type InvoiceRow = Awaited<ReturnType<ReturnType<typeof selectInvoices>["execute"]>>[number];

async function hydrate(trx: Trx, rows: InvoiceRow[]): Promise<Invoice[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [positions, payments] = await Promise.all([
    trx
      .selectFrom("rechnung_position")
      .select([
        "rechnung_id",
        "beschreibung",
        "menge_milli",
        "einzelpreis_rappen",
        "mwst_satz_bp",
        "erloeskonto",
      ])
      .where("rechnung_id", "in", ids)
      .orderBy("pos")
      .execute(),
    trx
      .selectFrom("rechnung_zahlung")
      .select(["id", "rechnung_id", "betrag_rappen", "erfasst_am", "erfasst_von"])
      .select(sql<string>`bezahlt_am::text`.as("bezahlt_am"))
      .where("rechnung_id", "in", ids)
      .orderBy("lfd")
      .execute(),
  ]);
  return rows.map((r) => {
    const lines: InvoiceLine[] = positions
      .filter((p) => p.rechnung_id === r.id)
      .map((p) => ({
        description: p.beschreibung,
        quantityMilli: p.menge_milli,
        unitCents: n(p.einzelpreis_rappen),
        vatRateBp: p.mwst_satz_bp,
        ...(p.erloeskonto ? { accountCode: p.erloeskonto } : {}),
      }));
    const pays: Payment[] = payments
      .filter((p) => p.rechnung_id === r.id)
      .map((p) => ({
        id: p.id,
        amountCents: n(p.betrag_rappen),
        paidOn: p.bezahlt_am,
        recordedAt: iso(p.erfasst_am),
        recordedBy: p.erfasst_von,
      }));
    const totals: Totals = {
      netCents: n(r.netto_rappen),
      vatBuckets: r.mwst_saetze as Totals["vatBuckets"],
      vatCents: n(r.mwst_rappen),
      grossCents: n(r.brutto_rappen),
      roundingCents: n(r.rundung_rappen),
      totalCents: n(r.total_rappen),
    };
    return {
      id: r.id,
      tenantId: r.kunde_id,
      kind: KIND_BACK[r.art],
      status: STATUS_BACK[r.status],
      number: r.nummer,
      seq: r.laufnummer,
      customerId: r.kundennummer,
      memberNumber: r.mitgliedsnr,
      debtor: r.debitor as Invoice["debtor"],
      currency: r.waehrung,
      issueDate: r.rechnungsdatum,
      dueDate: r.faelligkeitsdatum,
      vatMode: VAT_BACK[r.mwst_modus],
      roundTo5: r.runden_5,
      subject: r.betreff,
      notes: r.notizen,
      lines,
      totals,
      reference: r.referenz_art ? { type: r.referenz_art, value: r.referenz } : null,
      creditNoteOf: r.gutschrift_zu,
      collectiveRunId: r.sammellauf_id,
      payerKey: r.zahler_key,
      payments: pays,
      sentAt: r.versendet_am ? iso(r.versendet_am) : null,
      mailFailedAt: r.mail_fehler_am ? iso(r.mail_fehler_am) : null,
      createdAt: iso(r.erstellt_am),
      updatedAt: iso(r.geaendert_am),
      version: r.version,
    };
  });
}

/** Alle Spalten, die ein Entwurf ändern darf. */
function headerValues(i: Invoice) {
  return {
    art: KIND[i.kind],
    status: STATUS[i.status],
    nummer: i.number,
    laufnummer: i.seq,
    kundennummer: i.customerId,
    mitgliedsnr: i.memberNumber,
    debitor: json(i.debtor),
    waehrung: i.currency,
    rechnungsdatum: i.issueDate,
    faelligkeitsdatum: i.dueDate,
    mwst_modus: VAT[i.vatMode],
    runden_5: i.roundTo5,
    betreff: i.subject,
    notizen: i.notes,
    netto_rappen: i.totals.netCents,
    mwst_rappen: i.totals.vatCents,
    brutto_rappen: i.totals.grossCents,
    rundung_rappen: i.totals.roundingCents,
    total_rappen: i.totals.totalCents,
    mwst_saetze: json(i.totals.vatBuckets),
    referenz_art: i.reference?.type ?? null,
    referenz: i.reference?.value ?? null,
    gutschrift_zu: i.creditNoteOf,
    sammellauf_id: i.collectiveRunId,
    zahler_key: i.payerKey,
    versendet_am: i.sentAt,
    mail_fehler_am: i.mailFailedAt,
    geaendert_am: i.updatedAt,
    version: i.version,
  } as const;
}

async function writePositions(trx: Trx, i: Invoice) {
  await trx
    .insertInto("rechnung_position")
    .values(
      i.lines.map((l, idx) => ({
        rechnung_id: i.id,
        kunde_id: i.tenantId,
        pos: idx + 1,
        beschreibung: l.description,
        menge_milli: l.quantityMilli,
        einzelpreis_rappen: l.unitCents,
        mwst_satz_bp: l.vatRateBp,
        erloeskonto: l.accountCode ?? null,
      })),
    )
    .execute();
}

async function writePayments(trx: Trx, i: Invoice) {
  if (i.payments.length === 0) return;
  await trx
    .insertInto("rechnung_zahlung")
    .values(
      i.payments.map((p) => ({
        id: p.id,
        kunde_id: i.tenantId,
        rechnung_id: i.id,
        betrag_rappen: p.amountCents,
        bezahlt_am: p.paidOn,
        erfasst_am: p.recordedAt,
        erfasst_von: p.recordedBy,
      })),
    )
    .onConflict((oc) => oc.column("id").doNothing()) // Zahlungen sind anhängend: Bekanntes bleibt.
    .execute();
}

export class PgInvoiceRepository implements InvoiceRepository {
  constructor(private readonly run: Run) {}

  async insert(i: Invoice) {
    await this.run(i.tenantId, async (trx) => {
      await trx
        .insertInto("rechnung")
        .values({
          ...headerValues(i),
          id: i.id,
          kunde_id: i.tenantId,
          erstellt_am: i.createdAt,
        })
        .execute();
      await writePositions(trx, i);
      await writePayments(trx, i);
    }).catch((e: unknown) => translate(e, "Beleg existiert bereits."));
  }

  async update(i: Invoice, expectedVersion: number) {
    await this.run(i.tenantId, async (trx) => {
      // Zeile sperren: parallele Änderungen warten, danach entscheidet die Version.
      const cur = await trx
        .selectFrom("rechnung")
        .select(["status", "version"])
        .where("id", "=", i.id)
        .where("kunde_id", "=", i.tenantId)
        .forUpdate()
        .executeTakeFirst();
      if (!cur) throw new BillingError(404, "Beleg nicht gefunden.");
      if (cur.version !== expectedVersion)
        throw new BillingError(409, "Beleg wurde zwischenzeitlich geändert.");

      if (cur.status === "entwurf") {
        await trx.deleteFrom("rechnung_position").where("rechnung_id", "=", i.id).execute();
        await writePositions(trx, i);
        await trx
          .updateTable("rechnung")
          .set(headerValues(i))
          .where("id", "=", i.id)
          .where("kunde_id", "=", i.tenantId)
          .execute();
      } else {
        // Verteidigung in der Tiefe, wie im In-Memory-Repository; die Trigger sichern es zusätzlich.
        const [stored] = await hydrate(
          trx,
          await selectInvoices(trx).where("id", "=", i.id).execute(),
        );
        if (!stored || !isDeepStrictEqual(frozenView(stored), frozenView(i)))
          throw new BillingError(409, "Gebuchte Belege sind unveränderlich.");
        await trx
          .updateTable("rechnung")
          .set({
            status: STATUS[i.status],
            mail_fehler_am: i.mailFailedAt,
            geaendert_am: i.updatedAt,
            version: i.version,
          })
          .where("id", "=", i.id)
          .where("kunde_id", "=", i.tenantId)
          .execute();
      }
      await writePayments(trx, i);
    }).catch((e: unknown) => translate(e));
  }

  async deleteDraft(tenantId: string, id: string) {
    const res = await this.run(tenantId, (trx) =>
      trx
        .deleteFrom("rechnung")
        .where("id", "=", id)
        .where("kunde_id", "=", tenantId)
        .where("status", "=", "entwurf")
        .where("nummer", "is", null)
        .executeTakeFirst(),
    );
    return res.numDeletedRows > 0n;
  }

  async get(tenantId: string, id: string) {
    return this.run(tenantId, async (trx) => {
      const rows = await selectInvoices(trx)
        .where("id", "=", id)
        .where("kunde_id", "=", tenantId)
        .execute();
      return (await hydrate(trx, rows))[0] ?? null;
    });
  }

  async list(tenantId: string, q: InvoiceQuery) {
    return this.run(tenantId, async (trx) => {
      let rows = selectInvoices(trx).where("kunde_id", "=", tenantId);
      let count = trx
        .selectFrom("rechnung")
        .select(sql<string>`count(*)`.as("c"))
        .where("kunde_id", "=", tenantId);
      if (q.status) {
        rows = rows.where("status", "=", STATUS[q.status]);
        count = count.where("status", "=", STATUS[q.status]);
      }
      if (q.kind) {
        rows = rows.where("art", "=", KIND[q.kind]);
        count = count.where("art", "=", KIND[q.kind]);
      }
      if (q.q) {
        // `%`, `_` und `\` der Eingabe bleiben wörtlich; der Wert geht nur als Parameter in die Abfrage (SR-20).
        const like = `%${q.q.replace(/[\\%_]/g, "\\$&")}%`;
        const match = sql<boolean>`(nummer ILIKE ${like} OR debitor->>'name' ILIKE ${like} OR betreff ILIKE ${like})`;
        rows = rows.where(match);
        count = count.where(match);
      }
      const [page, total] = await Promise.all([
        rows.orderBy("erstellt_am", "desc").orderBy("id", "desc").limit(q.limit).offset(q.offset).execute(),
        count.executeTakeFirstOrThrow(),
      ]); // prettier-ignore
      return { items: await hydrate(trx, page), total: n(total.c) };
    });
  }

  async creditNotesOf(tenantId: string, invoiceId: string) {
    return this.run(tenantId, async (trx) =>
      hydrate(
        trx,
        await selectInvoices(trx)
          .where("kunde_id", "=", tenantId)
          .where("gutschrift_zu", "=", invoiceId)
          .where("status", "<>", "entwurf")
          .execute(),
      ),
    );
  }

  /**
   * Nächste Nummer. Der Zähler wird gesperrt, bis die Transaktion endet: nur in der Transaktion des Versendens
   * (\`ServiceDeps.transaction\`) bleibt die Folge lückenlos, weil ein Rollback die Nummer zurückgibt.
   */
  async nextSeq(tenantId: string, kind: InvoiceKind, year: number) {
    return this.run(tenantId, async (trx) => {
      const { rows } = await sql<{ letzte_nummer: number }>`
        INSERT INTO nummernkreis (kunde_id, art, jahr, letzte_nummer)
        VALUES (${tenantId}, ${KIND[kind]}, ${year}, 1)
        ON CONFLICT (kunde_id, art, jahr) DO UPDATE SET letzte_nummer = nummernkreis.letzte_nummer + 1
        RETURNING letzte_nummer`.execute(trx);
      return rows[0]!.letzte_nummer;
    });
  }

  async lastSeq(tenantId: string, kind: InvoiceKind, year: number) {
    return this.run(tenantId, async (trx) => {
      const row = await trx
        .selectFrom("nummernkreis")
        .select("letzte_nummer")
        .where("kunde_id", "=", tenantId)
        .where("art", "=", KIND[kind])
        .where("jahr", "=", year)
        .executeTakeFirst();
      return row?.letzte_nummer ?? 0;
    });
  }

  async findByRunAndPayer(tenantId: string, runId: string, payerKey: string) {
    return this.run(tenantId, async (trx) => {
      const rows = await selectInvoices(trx)
        .where("kunde_id", "=", tenantId)
        .where("sammellauf_id", "=", runId)
        .where("zahler_key", "=", payerKey)
        .execute();
      return (await hydrate(trx, rows))[0] ?? null;
    });
  }
}

// --- Mahnungen ----------------------------------------------------------------------------------------

export class PgReminderRepository implements ReminderRepository {
  constructor(private readonly run: Run) {}

  async insert(r: Reminder) {
    await this.run(r.tenantId, (trx) =>
      trx
        .insertInto("mahnung")
        .values({
          id: r.id,
          kunde_id: r.tenantId,
          rechnung_id: r.invoiceId,
          stufe: r.level,
          titel: r.title,
          ausgestellt_am: r.issuedOn,
          faellig_am: r.dueOn,
          gebuehr_rappen: r.feeCents,
          offen_rappen: r.openCents,
          total_rappen: r.totalCents,
          erstellt_am: r.createdAt,
        })
        .execute(),
    ).catch((e: unknown) => translate(e, "Diese Mahnstufe wurde bereits erstellt."));
  }

  async listByInvoice(tenantId: string, invoiceId: string) {
    const rows = await this.run(tenantId, (trx) =>
      trx
        .selectFrom("mahnung")
        .select([
          "id",
          "kunde_id",
          "rechnung_id",
          "stufe",
          "titel",
          "gebuehr_rappen",
          "offen_rappen",
          "total_rappen",
          "erstellt_am",
        ]) // prettier-ignore
        .select([
          sql<string>`ausgestellt_am::text`.as("ausgestellt_am"),
          sql<string>`faellig_am::text`.as("faellig_am"),
        ])
        .where("kunde_id", "=", tenantId)
        .where("rechnung_id", "=", invoiceId)
        .orderBy("stufe")
        .execute(),
    );
    return rows.map<Reminder>((r) => ({
      id: r.id,
      tenantId: r.kunde_id,
      invoiceId: r.rechnung_id,
      level: r.stufe,
      title: r.titel,
      issuedOn: r.ausgestellt_am,
      dueOn: r.faellig_am,
      feeCents: n(r.gebuehr_rappen),
      openCents: n(r.offen_rappen),
      totalCents: n(r.total_rappen),
      createdAt: iso(r.erstellt_am),
    }));
  }
}

// --- Einstellungen --------------------------------------------------------------------------------------

export class PgSettingsRepository implements SettingsRepository {
  constructor(private readonly run: Run) {}

  async get(tenantId: string): Promise<BillingSettings | null> {
    const r = await this.run(tenantId, (trx) =>
      trx
        .selectFrom("rechnung_einstellung")
        .selectAll()
        .where("kunde_id", "=", tenantId)
        .executeTakeFirst(),
    );
    if (!r) return null;
    return {
      tenantId: r.kunde_id,
      creditor: r.empfaenger as BillingSettings["creditor"],
      iban: r.iban,
      vatNumber: r.mwst_nummer,
      contactLines: r.kontakt_zeilen as string[],
      numberPrefix: r.nummer_praefix,
      creditNotePrefix: r.gutschrift_praefix,
      referencePrefix: r.referenz_praefix,
      paymentTermDays: r.zahlungsfrist_tage,
      defaultVatMode: VAT_BACK[r.mwst_modus],
      defaultVatRateBp: r.mwst_satz_bp,
      roundTo5: r.runden_5,
      defaultRevenueAccount: r.erloeskonto_standard,
      dunning: r.mahnstufen as DunningConfig,
      features: { collectiveInvoicing: r.sammelrechnung },
    };
  }

  async save(s: BillingSettings) {
    const values = {
      empfaenger: json(s.creditor),
      iban: s.iban,
      mwst_nummer: s.vatNumber,
      kontakt_zeilen: json(s.contactLines),
      nummer_praefix: s.numberPrefix,
      gutschrift_praefix: s.creditNotePrefix,
      referenz_praefix: s.referencePrefix,
      zahlungsfrist_tage: s.paymentTermDays,
      mwst_modus: VAT[s.defaultVatMode],
      mwst_satz_bp: s.defaultVatRateBp,
      runden_5: s.roundTo5,
      erloeskonto_standard: s.defaultRevenueAccount,
      mahnstufen: json(s.dunning),
      sammelrechnung: s.features.collectiveInvoicing,
    };
    await this.run(s.tenantId, (trx) =>
      trx
        .insertInto("rechnung_einstellung")
        .values({ ...values, kunde_id: s.tenantId })
        .onConflict((oc) =>
          oc.column("kunde_id").doUpdateSet({ ...values, geaendert_am: sql`now()` }),
        )
        .execute(),
    );
  }
}
