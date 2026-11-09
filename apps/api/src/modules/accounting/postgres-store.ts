import { sql } from "kysely";
import type { RawBuilder, Transaction } from "kysely";
import type { Database, Datenbank } from "@stammbuch/db";
import type { Account, EntryKind, JournalEntry, Side } from "./domain.js";
import type {
  AccountingStore,
  AccountingTx,
  Allocation,
  AuditEvent,
  Credit,
  CreditState,
  OpenItem,
  OpenItemState,
  Page,
  PersonLine,
  Totals,
} from "./repository.js";

type Trx = Transaction<Database>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// bigint und numeric liefert pg als string. Beträge sind ganze Rappen unter 10^12 (MAX_AMOUNT) und
// bleiben auch als Summe weit unter 2^53; die Datenbank rechnet, die Anwendung liest als number.
const num = (v: string | number): number => Number(v);
const iso = (d: Date): string => d.toISOString();
const totals = (soll: string, haben: string): Totals => ({ debit: num(soll), credit: num(haben) });

const ENTRY_COLUMNS = [
  "id",
  "belegnummer",
  "buchungsdatum",
  "art",
  "beschreibung",
  "storno_von",
  "erstellt_am",
  "erstellt_von",
  "aufbewahren_bis",
  "vorgaenger_hash",
  "hash",
] as const;

/**
 * Speicher auf PostgreSQL (Tabellen `buchhaltung_*`, packages/db/migrations). Jede Transaktion gehört
 * einem Kunden (RLS über `withKunde`) und nimmt zuerst die Buchhaltungssperre dieses Kunden: Lesen von
 * "letzte Buchung" und Schreiben der nächsten sind damit je Kunde nacheinander, die Belegnummern bleiben
 * lückenlos. Die Trigger der Datenbank prüfen dieselben Regeln als zweite Linie.
 */
export function createPostgresStore(db: Datenbank): AccountingStore {
  return {
    transaction: (tenantId, fn) =>
      db.withKunde(tenantId, async (trx) => {
        await sql`SELECT buchhaltung_sperre(${tenantId}::uuid)`.execute(trx);
        return fn(postgresTx(trx, tenantId));
      }),
  };
}

/**
 * Speicher auf einer bereits offenen Transaktion des Kunden (z. B. CAMT-Zahlung): Buchung und Rechnung
 * werden zusammen bestätigt oder verworfen. Die Buchhaltungssperre gilt bis zum Ende dieser Transaktion.
 */
export function createPostgresStoreOn(trx: Trx): AccountingStore {
  return {
    transaction: async (tenantId, fn) => {
      await sql`SELECT buchhaltung_sperre(${tenantId}::uuid)`.execute(trx);
      return fn(postgresTx(trx, tenantId));
    },
  };
}

function postgresTx(trx: Trx, k: string): AccountingTx {
  // ---- Buchungen -----------------------------------------------------------------------

  async function withLines(
    rows: {
      id: string;
      belegnummer: string;
      buchungsdatum: string;
      art: EntryKind;
      beschreibung: string;
      storno_von: string | null;
      erstellt_am: Date;
      erstellt_von: string;
      aufbewahren_bis: string;
      vorgaenger_hash: string;
      hash: string;
    }[],
  ): Promise<JournalEntry[]> {
    if (rows.length === 0) return [];
    const lines = await trx
      .selectFrom("buchhaltung_buchungszeile")
      .select(["buchung_id", "konto_nummer", "seite", "betrag", "person_id"])
      .where("kunde_id", "=", k)
      .where(
        "buchung_id",
        "in",
        rows.map((r) => r.id),
      )
      .orderBy("zeilennr")
      .execute();
    return rows.map((r) => ({
      id: r.id,
      number: num(r.belegnummer),
      bookingDate: r.buchungsdatum,
      kind: r.art,
      description: r.beschreibung,
      lines: lines
        .filter((l) => l.buchung_id === r.id)
        .map((l) => ({
          accountCode: l.konto_nummer,
          side: l.seite,
          amount: num(l.betrag),
          ...(l.person_id === null ? {} : { personId: l.person_id }),
        })),
      reversalOf: r.storno_von,
      createdAt: iso(r.erstellt_am),
      createdBy: r.erstellt_von,
      retentionUntil: r.aufbewahren_bis,
      prevHash: r.vorgaenger_hash,
      hash: r.hash,
    }));
  }

  const entries = () =>
    trx.selectFrom("buchhaltung_buchung").select(ENTRY_COLUMNS).where("kunde_id", "=", k);
  const firstEntry = async (q: ReturnType<typeof entries>) =>
    (await withLines(await q.limit(1).execute()))[0] ?? null;

  // ---- Offene Posten und Guthaben ------------------------------------------------------

  type ItemRow = {
    id: string;
    person_id: string;
    referenz: string;
    belegdatum: string;
    faellig_am: string;
    betrag: string;
    buchung_id: string;
    erstellt_am: Date;
    zugeordnet: string;
    storniert: boolean;
  };
  const itemState = (r: ItemRow): OpenItemState => ({
    id: r.id,
    personId: r.person_id,
    reference: r.referenz,
    documentDate: r.belegdatum,
    dueDate: r.faellig_am,
    amount: num(r.betrag),
    entryId: r.buchung_id,
    createdAt: iso(r.erstellt_am),
    allocated: num(r.zugeordnet),
    reversed: r.storniert,
  });
  const itemsWhere = async (cond: RawBuilder<unknown>, tail: RawBuilder<unknown>) =>
    (
      await sql<ItemRow>`
        SELECT * FROM (
          SELECT p.lfd, p.id, p.person_id, p.referenz, p.belegdatum, p.faellig_am, p.betrag, p.buchung_id, p.erstellt_am,
                 coalesce((SELECT sum(z.betrag) FROM buchhaltung_zuordnung z
                           WHERE z.kunde_id = p.kunde_id AND z.posten_id = p.id), 0) AS zugeordnet,
                 EXISTS (SELECT FROM buchhaltung_buchung s
                         WHERE s.kunde_id = p.kunde_id AND s.storno_von = p.buchung_id) AS storniert
          FROM buchhaltung_offener_posten p WHERE p.kunde_id = ${k}
        ) s WHERE ${cond} ${tail}`.execute(trx)
    ).rows.map(itemState);

  type CreditRow = {
    id: string;
    art: "payment" | "credit_note";
    person_id: string;
    referenz: string;
    valuta: string;
    betrag: string;
    buchung_id: string;
    erstellt_am: Date;
    zugeordnet: string;
    storniert: boolean;
  };
  const creditState = (r: CreditRow): CreditState => ({
    id: r.id,
    kind: r.art,
    personId: r.person_id,
    reference: r.referenz,
    valueDate: r.valuta,
    amount: num(r.betrag),
    entryId: r.buchung_id,
    createdAt: iso(r.erstellt_am),
    allocated: num(r.zugeordnet),
    reversed: r.storniert,
  });
  const creditsWhere = async (cond: RawBuilder<unknown>, tail: RawBuilder<unknown>) =>
    (
      await sql<CreditRow>`
        SELECT * FROM (
          SELECT g.lfd, g.id, g.art, g.person_id, g.referenz, g.valuta, g.betrag, g.buchung_id, g.erstellt_am,
                 coalesce((SELECT sum(z.betrag) FROM buchhaltung_zuordnung z
                           WHERE z.kunde_id = g.kunde_id AND z.guthaben_id = g.id), 0) AS zugeordnet,
                 EXISTS (SELECT FROM buchhaltung_buchung s
                         WHERE s.kunde_id = g.kunde_id AND s.storno_von = g.buchung_id) AS storniert
          FROM buchhaltung_guthaben g WHERE g.kunde_id = ${k}
        ) s WHERE ${cond} ${tail}`.execute(trx)
    ).rows.map(creditState);

  const pageSql = (p: Page) => sql`OFFSET ${p.offset} LIMIT ${p.limit}`;

  // ---- Zuordnungen ---------------------------------------------------------------------

  const allocations = () =>
    trx
      .selectFrom("buchhaltung_zuordnung")
      .select([
        "id",
        "guthaben_id",
        "posten_id",
        "betrag",
        "aufhebung_von",
        "erstellt_am",
        "erstellt_von",
      ])
      .where("kunde_id", "=", k)
      .orderBy("lfd");
  const allocation = (r: {
    id: string;
    guthaben_id: string;
    posten_id: string;
    betrag: string;
    aufhebung_von: string | null;
    erstellt_am: Date;
    erstellt_von: string;
  }): Allocation => ({
    id: r.id,
    creditId: r.guthaben_id,
    openItemId: r.posten_id,
    amount: num(r.betrag),
    reversalOf: r.aufhebung_von,
    createdAt: iso(r.erstellt_am),
    createdBy: r.erstellt_von,
  });

  // ---- Perioden ------------------------------------------------------------------------

  const periodEvents = () =>
    trx
      .selectFrom("buchhaltung_periodenereignis")
      .select(["periode", "status", "zeitpunkt", "akteur", "grund"])
      .where("kunde_id", "=", k);
  const periodEvent = (r: {
    periode: string;
    status: "closed" | "open";
    zeitpunkt: Date;
    akteur: string;
    grund: string | null;
  }) => ({
    period: r.periode,
    status: r.status,
    at: iso(r.zeitpunkt),
    actor: r.akteur,
    reason: r.grund,
  });

  // Ein Wert aus dem Request, der keine UUID ist, findet nichts (statt einen Datenbankfehler auszulösen).
  const byId = <T>(id: string, find: () => Promise<T | null>): Promise<T | null> =>
    uuidPattern.test(id) ? find() : Promise.resolve(null);

  return {
    listAccounts: async () =>
      (
        await trx
          .selectFrom("buchhaltung_konto")
          .select(["nummer", "name", "art", "aktiv"])
          .where("kunde_id", "=", k)
          .orderBy("nummer")
          .execute()
      ).map(accountOf),
    getAccount: async (code) => {
      const r = await trx
        .selectFrom("buchhaltung_konto")
        .select(["nummer", "name", "art", "aktiv"])
        .where("kunde_id", "=", k)
        .where("nummer", "=", code)
        .executeTakeFirst();
      return r ? accountOf(r) : null;
    },
    insertAccount: async (a) => {
      await trx
        .insertInto("buchhaltung_konto")
        .values({ kunde_id: k, nummer: a.code, name: a.name, art: a.type, aktiv: a.active })
        .execute();
    },
    renameAccount: async (code, name) => {
      await trx
        .updateTable("buchhaltung_konto")
        .set({ name })
        .where("kunde_id", "=", k)
        .where("nummer", "=", code)
        .execute();
    },

    lastEntry: () => firstEntry(entries().orderBy("belegnummer", "desc")),
    insertEntry: async (e) => {
      await trx
        .insertInto("buchhaltung_buchung")
        .values({
          id: e.id,
          kunde_id: k,
          belegnummer: e.number,
          buchungsdatum: e.bookingDate,
          art: e.kind,
          beschreibung: e.description,
          storno_von: e.reversalOf,
          erstellt_am: e.createdAt,
          erstellt_von: e.createdBy,
          aufbewahren_bis: e.retentionUntil,
          vorgaenger_hash: e.prevHash,
          hash: e.hash,
        })
        .execute();
      await trx
        .insertInto("buchhaltung_buchungszeile")
        .values(
          e.lines.map((l, i) => ({
            kunde_id: k,
            buchung_id: e.id,
            zeilennr: i + 1,
            konto_nummer: l.accountCode,
            seite: l.side,
            betrag: l.amount,
            person_id: l.personId ?? null,
          })),
        )
        .execute();
    },
    getEntry: (id) => byId(id, () => firstEntry(entries().where("id", "=", id))),
    getReversalOf: (id) => firstEntry(entries().where("storno_von", "=", id)),
    listEntries: async (f, page) => {
      let q = entries();
      if (f.from) q = q.where("buchungsdatum", ">=", f.from);
      if (f.to) q = q.where("buchungsdatum", "<=", f.to);
      const code = f.accountCode;
      if (code) {
        q = q.where((eb) =>
          eb.exists(
            eb
              .selectFrom("buchhaltung_buchungszeile as z")
              .select(sql.lit(1).as("eins"))
              .whereRef("z.buchung_id", "=", "buchhaltung_buchung.id")
              .whereRef("z.kunde_id", "=", "buchhaltung_buchung.kunde_id")
              .where("z.konto_nummer", "=", code),
          ),
        );
      }
      return withLines(
        await q.orderBy("belegnummer").offset(page.offset).limit(page.limit).execute(),
      );
    },
    accountTotals: async ({ from, to }) => {
      const { rows } = await sql<{ konto: string; soll: string; haben: string }>`
        SELECT z.konto_nummer AS konto,
               coalesce(sum(z.betrag) FILTER (WHERE z.seite = 'debit'), 0) AS soll,
               coalesce(sum(z.betrag) FILTER (WHERE z.seite = 'credit'), 0) AS haben
        FROM buchhaltung_buchungszeile z
        JOIN buchhaltung_buchung b ON b.kunde_id = z.kunde_id AND b.id = z.buchung_id
        WHERE z.kunde_id = ${k}
          AND (${from ?? null}::date IS NULL OR b.buchungsdatum >= ${from ?? null}::date)
          AND (${to ?? null}::date IS NULL OR b.buchungsdatum <= ${to ?? null}::date)
        GROUP BY z.konto_nummer`.execute(trx);
      return new Map(rows.map((r) => [r.konto, totals(r.soll, r.haben)]));
    },
    accountEntryCounts: async ({ from, to }) => {
      const { rows } = await sql<{ konto: string; anzahl: string }>`
        SELECT z.konto_nummer AS konto, count(DISTINCT z.buchung_id) AS anzahl
        FROM buchhaltung_buchungszeile z
        JOIN buchhaltung_buchung b ON b.kunde_id = z.kunde_id AND b.id = z.buchung_id
        WHERE z.kunde_id = ${k}
          AND (${from ?? null}::date IS NULL OR b.buchungsdatum >= ${from ?? null}::date)
          AND (${to ?? null}::date IS NULL OR b.buchungsdatum <= ${to ?? null}::date)
        GROUP BY z.konto_nummer`.execute(trx);
      return new Map(rows.map((r) => [r.konto, num(r.anzahl)]));
    },
    countEntries: async (f) => {
      const code = f.accountCode ?? null;
      const { rows } = await sql<{ anzahl: string }>`
        SELECT count(*) AS anzahl FROM buchhaltung_buchung b
        WHERE b.kunde_id = ${k}
          AND (${f.from ?? null}::date IS NULL OR b.buchungsdatum >= ${f.from ?? null}::date)
          AND (${f.to ?? null}::date IS NULL OR b.buchungsdatum <= ${f.to ?? null}::date)
          AND (${code}::text IS NULL OR EXISTS (
            SELECT FROM buchhaltung_buchungszeile z
            WHERE z.kunde_id = b.kunde_id AND z.buchung_id = b.id AND z.konto_nummer = ${code}))`.execute(
        trx,
      );
      return num(rows[0]?.anzahl ?? 0);
    },
    userNames: async (ids) => {
      const valid = [...new Set(ids)].filter((id) => uuidPattern.test(id));
      if (valid.length === 0) return new Map();
      const rows = await trx
        .selectFrom("benutzer")
        .select(["id", "name"])
        .where("kunde_id", "=", k)
        .where("id", "in", valid)
        .execute();
      return new Map(rows.map((r) => [r.id, r.name]));
    },
    // Name aus Mitglied oder Firma desselben Kunden (wie in ledger-read.ts); die Personen-ID ist Text.
    personName: async (personId) => {
      const { rows } = await sql<{ name: string | null }>`
        SELECT coalesce(
                 (SELECT nullif(trim(m.vorname || ' ' || m.nachname), '') FROM mitglied m
                  WHERE m.kunde_id = ${k} AND m.id::text = ${personId}),
                 (SELECT f.name FROM firma f WHERE f.kunde_id = ${k} AND f.id::text = ${personId})
               ) AS name`.execute(trx);
      return rows[0]?.name ?? null;
    },
    personTotals: async (personId) => {
      const { rows } = await sql<{ person: string; soll: string; haben: string }>`
        SELECT z.person_id AS person,
               coalesce(sum(z.betrag) FILTER (WHERE z.seite = 'debit'), 0) AS soll,
               coalesce(sum(z.betrag) FILTER (WHERE z.seite = 'credit'), 0) AS haben
        FROM buchhaltung_buchungszeile z
        WHERE z.kunde_id = ${k} AND z.person_id IS NOT NULL
          AND (${personId ?? null}::text IS NULL OR z.person_id = ${personId ?? null}::text)
        GROUP BY z.person_id`.execute(trx);
      return new Map(rows.map((r) => [r.person, totals(r.soll, r.haben)]));
    },
    listPersonLines: async (personId, page) => {
      const { rows } = await sql<{
        entry_id: string;
        belegnummer: string;
        buchungsdatum: string;
        art: EntryKind;
        beschreibung: string;
        seite: Side;
        betrag: string;
        saldo: string;
      }>`
        SELECT * FROM (
          SELECT b.id AS entry_id, b.belegnummer, b.buchungsdatum, b.art, b.beschreibung, z.seite, z.betrag, z.zeilennr,
                 sum(CASE WHEN z.seite = 'debit' THEN z.betrag ELSE -z.betrag END)
                   OVER (ORDER BY b.belegnummer, z.zeilennr) AS saldo
          FROM buchhaltung_buchungszeile z
          JOIN buchhaltung_buchung b ON b.kunde_id = z.kunde_id AND b.id = z.buchung_id
          WHERE z.kunde_id = ${k} AND z.person_id = ${personId}
        ) s ORDER BY belegnummer, zeilennr ${pageSql(page)}`.execute(trx);
      return rows.map((r): PersonLine => ({
        entryId: r.entry_id,
        entryNumber: num(r.belegnummer),
        bookingDate: r.buchungsdatum,
        kind: r.art,
        description: r.beschreibung,
        side: r.seite,
        amount: num(r.betrag),
        balanceAfter: num(r.saldo),
      }));
    },

    insertOpenItem: async (i: OpenItem) => {
      await trx
        .insertInto("buchhaltung_offener_posten")
        .values({
          id: i.id,
          kunde_id: k,
          person_id: i.personId,
          referenz: i.reference,
          belegdatum: i.documentDate,
          faellig_am: i.dueDate,
          betrag: i.amount,
          buchung_id: i.entryId,
          erstellt_am: i.createdAt,
        })
        .execute();
    },
    getOpenItem: async (id) =>
      byId(id, async () => (await itemsWhere(sql`s.id = ${id}`, sql``))[0] ?? null),
    getOpenItemByEntry: async (entryId) =>
      (await itemsWhere(sql`s.buchung_id = ${entryId}`, sql``))[0] ?? null,
    listOpenItems: (f, page) =>
      itemsWhere(
        sql`(${f.personId ?? null}::text IS NULL OR s.person_id = ${f.personId ?? null}::text)
            AND (NOT ${f.onlyOpen === true} OR (NOT s.storniert AND s.betrag - s.zugeordnet > 0))`,
        sql`ORDER BY s.faellig_am, s.erstellt_am, s.lfd ${pageSql(page)}`,
      ),

    insertCredit: async (c: Credit) => {
      await trx
        .insertInto("buchhaltung_guthaben")
        .values({
          id: c.id,
          kunde_id: k,
          art: c.kind,
          person_id: c.personId,
          referenz: c.reference,
          valuta: c.valueDate,
          betrag: c.amount,
          buchung_id: c.entryId,
          erstellt_am: c.createdAt,
        })
        .execute();
    },
    getCredit: async (id) =>
      byId(id, async () => (await creditsWhere(sql`s.id = ${id}`, sql``))[0] ?? null),
    getCreditByEntry: async (entryId) =>
      (await creditsWhere(sql`s.buchung_id = ${entryId}`, sql``))[0] ?? null,
    listCredits: (f, page) =>
      creditsWhere(
        sql`(${f.personId ?? null}::text IS NULL OR s.person_id = ${f.personId ?? null}::text)
            AND (NOT ${f.onlyUnallocated === true} OR (NOT s.storniert AND s.betrag - s.zugeordnet > 0))`,
        sql`ORDER BY s.lfd ${pageSql(page)}`,
      ),

    insertAllocation: async (a) => {
      await trx
        .insertInto("buchhaltung_zuordnung")
        .values({
          id: a.id,
          kunde_id: k,
          guthaben_id: a.creditId,
          posten_id: a.openItemId,
          betrag: a.amount,
          aufhebung_von: a.reversalOf,
          erstellt_am: a.createdAt,
          erstellt_von: a.createdBy,
        })
        .execute();
    },
    getAllocation: (id) =>
      byId(id, async () => {
        const r = await allocations().where("id", "=", id).executeTakeFirst();
        return r ? allocation(r) : null;
      }),
    getAllocationReversal: async (id) => {
      const r = await allocations().where("aufhebung_von", "=", id).executeTakeFirst();
      return r ? allocation(r) : null;
    },
    listAllocations: async (f) => {
      let q = allocations();
      if (f.creditId) q = q.where("guthaben_id", "=", f.creditId);
      if (f.openItemId) q = q.where("posten_id", "=", f.openItemId);
      return (await q.execute()).map(allocation);
    },

    appendPeriodEvent: async (e) => {
      await trx
        .insertInto("buchhaltung_periodenereignis")
        .values({
          kunde_id: k,
          periode: e.period,
          status: e.status,
          zeitpunkt: e.at,
          akteur: e.actor,
          grund: e.reason,
        })
        .execute();
    },
    lastPeriodEvent: async (period) => {
      const r = await periodEvents()
        .where("periode", "=", period)
        .orderBy("lfd", "desc")
        .executeTakeFirst();
      return r ? periodEvent(r) : null;
    },
    listPeriodEvents: async () => (await periodEvents().orderBy("lfd").execute()).map(periodEvent),

    appendAudit: async (e: AuditEvent) => {
      await trx
        .insertInto("buchhaltung_protokoll")
        .values({
          id: e.id,
          kunde_id: k,
          zeitpunkt: e.at,
          akteur: e.actor,
          aktion: e.action,
          objekt_typ: e.objectType,
          objekt_id: e.objectId,
          details: JSON.stringify(e.detail) as unknown as Record<string, unknown>,
        })
        .execute();
    },
    listAudit: async (page) =>
      (
        await trx
          .selectFrom("buchhaltung_protokoll")
          .select(["id", "zeitpunkt", "akteur", "aktion", "objekt_typ", "objekt_id", "details"])
          .where("kunde_id", "=", k)
          .orderBy("lfd")
          .offset(page.offset)
          .limit(page.limit)
          .execute()
      ).map((r): AuditEvent => ({
        id: r.id,
        at: iso(r.zeitpunkt),
        actor: r.akteur,
        action: r.aktion,
        objectType: r.objekt_typ,
        objectId: r.objekt_id,
        detail: r.details as AuditEvent["detail"],
      })),

    getIdempotency: async (key) => {
      const r = await trx
        .selectFrom("buchhaltung_idempotenz")
        .select(["anfrage_hash", "ergebnis"])
        .where("kunde_id", "=", k)
        .where("schluessel", "=", key)
        .executeTakeFirst();
      return r ? { requestHash: r.anfrage_hash, result: r.ergebnis } : null;
    },
    putIdempotency: async (key, record) => {
      await trx
        .insertInto("buchhaltung_idempotenz")
        .values({
          kunde_id: k,
          schluessel: key,
          anfrage_hash: record.requestHash,
          ergebnis: JSON.stringify(record.result),
        })
        .execute();
    },
  };
}

const accountOf = (r: {
  nummer: string;
  name: string;
  art: Account["type"];
  aktiv: boolean;
}): Account => ({ code: r.nummer, name: r.name, type: r.art, active: r.aktiv });
