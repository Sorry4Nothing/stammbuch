import type { Database, Datenbank, FirmaTable, MitgliedTable } from "@stammbuch/db";
import type { Address } from "@stammbuch/shared";
import { sql } from "kysely";
import type { Selectable, Transaction } from "kysely";
import { AppError } from "../../lib/errors.js";
import type { Firma, Gruppe, Member } from "./domain.js";
import type {
  FirmaQuery,
  MemberQuery,
  Page,
  PeopleStore,
  RegistrationRepository,
} from "./repository.js";

type Trx = Transaction<Database>;

// Trenner im Cursor: Die Normalisierung macht aus Steuerzeichen Leerzeichen, er kommt also nie im Text vor.
const SEP = "\u0001";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSERT_CHUNK = 1000; // 1000 Zeilen x ~22 Spalten bleiben unter dem Limit von 65535 Parametern

/** Meldungen für verletzte UNIQUE-Constraints (Name des Index aus den Migrationen). */
const CONFLICTS: Record<string, string> = {
  mitglied_email_key: "E-Mail-Adresse ist bereits vergeben.",
  gruppe_name_key: "Eine Gruppe mit diesem Namen existiert bereits.",
  gruppe_mitgliedschaft_pkey: "Die Person ist bereits in einer anderen Gruppe.",
  firma_uid_gueltig: "Eine Firma mit dieser UID existiert bereits.",
};

/** Übersetzt Constraint-Verstösse in Fachfehler. Alles andere (inkl. Verbindungsfehler) geht als 500 durch. */
function translate(e: unknown): never {
  if (typeof e === "object" && e !== null && "code" in e) {
    if (e.code === "23505") {
      const constraint = "constraint" in e ? String(e.constraint) : "";
      throw new AppError(409, CONFLICTS[constraint]);
    }
    // Fremdschlüssel: Verweis auf etwas, das es im Mandanten nicht gibt.
    if (e.code === "23503") throw new AppError(404);
  }
  throw e;
}

/** Jeder Zugriff läuft in einer Transaktion mit gesetztem Mandanten (RLS) und übersetzt DB-Fehler. */
function runner(db: Datenbank) {
  return async <T>(kundeId: string, fn: (trx: Trx) => Promise<T>): Promise<T> => {
    try {
      return await db.withKunde(kundeId, fn);
    } catch (e) {
      return translate(e);
    }
  };
}

/** Suchbegriffe: jedes Wort muss im Suchtext vorkommen. Normalisiert wird in der Datenbank. */
function searchTokens(q: string | undefined): string[] {
  return (q ?? "").split(/\s+/).filter(Boolean).slice(0, 8);
}
const like = (column: string, token: string) =>
  sql<boolean>`${sql.ref(column)} LIKE '%' || suchtext_normalisieren(${token}) || '%'`;

function splitCursor(after: string, parts: number): string[] {
  const p = after.split(SEP);
  if (p.length !== parts || !UUID.test(p.at(-1) ?? ""))
    throw new AppError(400, "Ungültiger Cursor.");
  return p;
}

function page<T>(rows: Array<T & { _key: string }>, limit: number): Page<T> {
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  return { items, next: more ? (items.at(-1)?._key ?? null) : null };
}

// Zeilen <-> Domäne

function addressOf(r: {
  strasse: string | null;
  hausnr: string | null;
  zusatz: string | null;
  plz: string | null;
  ort: string | null;
  land: string | null;
}): Address | null {
  if (r.strasse === null || r.plz === null || r.ort === null || r.land === null) return null;
  return {
    strasse: r.strasse,
    ...(r.hausnr !== null && { hausnr: r.hausnr }),
    ...(r.zusatz !== null && { zusatz: r.zusatz }),
    plz: r.plz,
    ort: r.ort,
    land: r.land,
  };
}

const addressColumns = (a: Address | null) => ({
  strasse: a?.strasse ?? null,
  hausnr: a?.hausnr ?? null,
  zusatz: a?.zusatz ?? null,
  plz: a?.plz ?? null,
  ort: a?.ort ?? null,
  land: a?.land ?? null,
});

type MemberRow = Selectable<MitgliedTable> & { gruppe_id: string | null };

const toMember = (r: MemberRow): Member => ({
  id: r.id,
  kundeId: r.kunde_id,
  typ: r.typ,
  status: r.status,
  anrede: r.anrede,
  vorname: r.vorname,
  nachname: r.nachname,
  email: r.email,
  telefon: r.telefon,
  mobil: r.mobil,
  adresse: addressOf(r),
  notiz: r.notiz,
  funktion: r.funktion,
  geburtsdatum: r.geburtsdatum,
  firmaId: r.firma_id,
  gruppeId: r.gruppe_id,
  erstelltAm: r.erstellt_am,
  geaendertAm: r.geaendert_am,
});

const memberValues = (m: Member) => ({
  kunde_id: m.kundeId,
  id: m.id,
  typ: m.typ,
  status: m.status,
  anrede: m.anrede,
  vorname: m.vorname,
  nachname: m.nachname,
  email: m.email,
  telefon: m.telefon,
  mobil: m.mobil,
  ...addressColumns(m.adresse),
  notiz: m.notiz,
  funktion: m.funktion,
  geburtsdatum: m.geburtsdatum,
  firma_id: m.firmaId,
  erstellt_am: m.erstelltAm,
  geaendert_am: m.geaendertAm,
});

const toFirma = (r: Selectable<FirmaTable>): Firma => ({
  id: r.id,
  kundeId: r.kunde_id,
  name: r.name,
  uid: r.uid,
  mwstNr: r.mwst_nr,
  adresse: addressOf(r) as Address,
  email: r.email,
  telefon: r.telefon,
  kontaktperson: r.kontaktperson,
  status: r.status,
  zusammengefuehrtMit: r.zusammengefuehrt_mit,
  erstelltAm: r.erstellt_am,
});

const firmaValues = (f: Firma) => ({
  kunde_id: f.kundeId,
  id: f.id,
  name: f.name,
  uid: f.uid,
  mwst_nr: f.mwstNr,
  strasse: f.adresse.strasse,
  hausnr: f.adresse.hausnr ?? null,
  zusatz: f.adresse.zusatz ?? null,
  plz: f.adresse.plz,
  ort: f.adresse.ort,
  land: f.adresse.land,
  email: f.email,
  telefon: f.telefon,
  kontaktperson: f.kontaktperson,
  status: f.status,
  zusammengefuehrt_mit: f.zusammengefuehrtMit,
  erstellt_am: f.erstelltAm,
});

function memberSelect(trx: Trx) {
  return trx
    .selectFrom("mitglied as m")
    .leftJoin("gruppe_mitgliedschaft as gm", (j) =>
      j.onRef("gm.kunde_id", "=", "m.kunde_id").onRef("gm.mitglied_id", "=", "m.id"),
    )
    .selectAll("m")
    .select("gm.gruppe_id");
}

/**
 * PostgreSQL-Implementierung. Alle Zugriffe laufen über `Datenbank.withKunde`: RLS begrenzt auf den
 * Mandanten, `kunde_id` steht zusätzlich in jeder Abfrage (doppelte Absicherung, SR-10).
 */
export function createPostgresStore(db: Datenbank): PeopleStore {
  const run = runner(db);

  const members: PeopleStore["members"] = {
    async insert(m) {
      await run(m.kundeId, (t) => t.insertInto("mitglied").values(memberValues(m)).execute());
    },

    async insertMany(kundeId, list) {
      await run(kundeId, async (t) => {
        for (let i = 0; i < list.length; i += INSERT_CHUNK) {
          const chunk = list.slice(i, i + INSERT_CHUNK).map(memberValues);
          await t.insertInto("mitglied").values(chunk).execute();
        }
      });
    },

    async get(kundeId, id) {
      const r = await run(kundeId, (t) =>
        memberSelect(t).where("m.kunde_id", "=", kundeId).where("m.id", "=", id).executeTakeFirst(),
      );
      return r && toMember(r);
    },

    async save(m) {
      const { kunde_id, id, ...changes } = memberValues(m);
      const r = await run(kunde_id, (t) =>
        t
          .updateTable("mitglied")
          .set(changes)
          .where("kunde_id", "=", kunde_id)
          .where("id", "=", id)
          .executeTakeFirst(),
      );
      if (r.numUpdatedRows === 0n) throw new AppError(404);
    },

    async findByEmail(kundeId, email) {
      const r = await run(kundeId, (t) =>
        memberSelect(t)
          .where("m.kunde_id", "=", kundeId)
          .where("m.email", "=", email)
          .executeTakeFirst(),
      );
      return r && toMember(r);
    },

    async existingEmails(kundeId, emails) {
      if (emails.length === 0) return new Set();
      const rows = await run(kundeId, (t) =>
        t
          .selectFrom("mitglied")
          .select("email")
          .where("kunde_id", "=", kundeId)
          .where("email", "in", emails)
          .execute(),
      );
      return new Set(rows.flatMap((r) => (r.email === null ? [] : [r.email])));
    },

    async list(kundeId, q: MemberQuery) {
      const rows = await run(kundeId, async (t) => {
        let qb = memberSelect(t)
          .select(
            sql<string>`m.nachname_sort || ${SEP} || m.vorname_sort || ${SEP} || m.id::text`.as(
              "_key",
            ),
          )
          .where("m.kunde_id", "=", kundeId)
          .where("m.status", "=", q.status);
        if (q.typ) qb = qb.where("m.typ", "=", q.typ);
        if (q.firmaId) qb = qb.where("m.firma_id", "=", q.firmaId);
        if (q.gruppeId) qb = qb.where("gm.gruppe_id", "=", q.gruppeId);
        if (q.ohneGruppe) qb = qb.where("gm.gruppe_id", "is", null);
        for (const token of searchTokens(q.q)) qb = qb.where(like("m.suchtext", token));
        if (q.after !== undefined) {
          const [n, v, id] = splitCursor(q.after, 3);
          qb = qb.where(
            sql<boolean>`(m.nachname_sort, m.vorname_sort, m.id) > (${n}::text COLLATE "C", ${v}::text COLLATE "C", ${id}::uuid)`,
          );
        }
        return qb
          .orderBy("m.nachname_sort")
          .orderBy("m.vorname_sort")
          .orderBy("m.id")
          .limit(q.limit + 1)
          .execute();
      });
      return page(
        rows.map((r) => ({ ...toMember(r), _key: r._key })),
        q.limit,
      );
    },
  };

  const gruppen: PeopleStore["gruppen"] = {
    async insert(g: Gruppe) {
      await run(g.kundeId, (t) =>
        t.insertInto("gruppe").values({ kunde_id: g.kundeId, id: g.id, name: g.name }).execute(),
      );
    },

    async get(kundeId, id) {
      const r = await run(kundeId, (t) =>
        t
          .selectFrom("gruppe")
          .selectAll()
          .where("kunde_id", "=", kundeId)
          .where("id", "=", id)
          .executeTakeFirst(),
      );
      return r && { id: r.id, kundeId: r.kunde_id, name: r.name };
    },

    async list(kundeId) {
      const rows = await run(kundeId, (t) =>
        t
          .selectFrom("gruppe as g")
          .leftJoin("gruppe_mitgliedschaft as gm", (j) =>
            j.onRef("gm.kunde_id", "=", "g.kunde_id").onRef("gm.gruppe_id", "=", "g.id"),
          )
          .select(["g.id", "g.kunde_id", "g.name"])
          .select((eb) => eb.fn.count<string>("gm.mitglied_id").as("mitglieder"))
          .where("g.kunde_id", "=", kundeId)
          .groupBy(["g.kunde_id", "g.id", "g.name"])
          .orderBy(sql`suchtext_normalisieren(g.name) COLLATE "C"`)
          .orderBy("g.id")
          .execute(),
      );
      return rows.map((r) => ({
        id: r.id,
        kundeId: r.kunde_id,
        name: r.name,
        mitglieder: Number(r.mitglieder),
      }));
    },

    async rename(kundeId, id, name) {
      const r = await run(kundeId, (t) =>
        t
          .updateTable("gruppe")
          .set({ name })
          .where("kunde_id", "=", kundeId)
          .where("id", "=", id)
          .executeTakeFirst(),
      );
      return r.numUpdatedRows > 0n;
    },

    async dissolve(kundeId, id) {
      // Die Mitgliedschaften verschwinden per ON DELETE CASCADE.
      const r = await run(kundeId, (t) =>
        t
          .deleteFrom("gruppe")
          .where("kunde_id", "=", kundeId)
          .where("id", "=", id)
          .executeTakeFirst(),
      );
      return r.numDeletedRows > 0n;
    },

    async assign(kundeId, memberId, gruppeId) {
      await run(kundeId, async (t) => {
        // Der PRIMARY KEY (kunde_id, mitglied_id) erzwingt "höchstens eine Gruppe", auch parallel.
        const inserted = await t
          .insertInto("gruppe_mitgliedschaft")
          .values({ kunde_id: kundeId, mitglied_id: memberId, gruppe_id: gruppeId })
          .onConflict((oc) => oc.columns(["kunde_id", "mitglied_id"]).doNothing())
          .returning("gruppe_id")
          .executeTakeFirst();
        if (inserted) return;
        const current = await t
          .selectFrom("gruppe_mitgliedschaft")
          .select("gruppe_id")
          .where("kunde_id", "=", kundeId)
          .where("mitglied_id", "=", memberId)
          .executeTakeFirst();
        if (current?.gruppe_id !== gruppeId) {
          throw new AppError(409, CONFLICTS.gruppe_mitgliedschaft_pkey);
        }
      });
    },

    async unassign(kundeId, memberId) {
      await run(kundeId, (t) =>
        t
          .deleteFrom("gruppe_mitgliedschaft")
          .where("kunde_id", "=", kundeId)
          .where("mitglied_id", "=", memberId)
          .execute(),
      );
    },
  };

  const firmen: PeopleStore["firmen"] = {
    async insert(f) {
      await run(f.kundeId, (t) => t.insertInto("firma").values(firmaValues(f)).execute());
    },

    async get(kundeId, id) {
      const r = await run(kundeId, (t) =>
        t
          .selectFrom("firma")
          .selectAll()
          .where("kunde_id", "=", kundeId)
          .where("id", "=", id)
          .executeTakeFirst(),
      );
      return r && toFirma(r);
    },

    async getMany(kundeId, ids) {
      if (ids.length === 0) return [];
      const rows = await run(kundeId, (t) =>
        t
          .selectFrom("firma")
          .selectAll()
          .where("kunde_id", "=", kundeId)
          .where("id", "in", ids)
          .execute(),
      );
      return rows.map(toFirma);
    },

    async save(f) {
      const { kunde_id, id, ...changes } = firmaValues(f);
      const r = await run(kunde_id, (t) =>
        t
          .updateTable("firma")
          .set(changes)
          .where("kunde_id", "=", kunde_id)
          .where("id", "=", id)
          .executeTakeFirst(),
      );
      if (r.numUpdatedRows === 0n) throw new AppError(404);
    },

    async list(kundeId, q: FirmaQuery) {
      const rows = await run(kundeId, async (t) => {
        let qb = t
          .selectFrom("firma as f")
          .selectAll("f")
          .select(sql<string>`f.name_sort || ${SEP} || f.id::text`.as("_key"))
          .where("f.kunde_id", "=", kundeId);
        if (q.status) qb = qb.where("f.status", "=", q.status);
        for (const token of searchTokens(q.q)) qb = qb.where(like("f.suchtext", token));
        if (q.after !== undefined) {
          const [n, id] = splitCursor(q.after, 2);
          qb = qb.where(sql<boolean>`(f.name_sort, f.id) > (${n}::text COLLATE "C", ${id}::uuid)`);
        }
        return qb
          .orderBy("f.name_sort")
          .orderBy("f.id")
          .limit(q.limit + 1)
          .execute();
      });
      return page(
        rows.map((r) => ({ ...toFirma(r), _key: r._key })),
        q.limit,
      );
    },

    async listCandidates(kundeId) {
      const rows = await run(kundeId, (t) =>
        t
          .selectFrom("firma")
          .selectAll()
          .where("kunde_id", "=", kundeId)
          .where("status", "in", ["ausstehend", "freigegeben"])
          .execute(),
      );
      return rows.map(toFirma);
    },

    async merge(kundeId, target, sourceId, now) {
      await run(kundeId, async (t) => {
        // Beide Zeilen in fester Reihenfolge sperren (keine Deadlocks bei gegenläufigen Aufrufen)
        // und den Stand unter Sperre prüfen: der Dienst hat ihn vorher ohne Sperre gelesen.
        const locked = await t
          .selectFrom("firma")
          .select(["id", "status"])
          .where("kunde_id", "=", kundeId)
          .where("id", "in", [target.id, sourceId])
          .orderBy("id")
          .forUpdate()
          .execute();
        const status = new Map(locked.map((r) => [r.id, r.status]));
        if (!status.has(target.id) || !status.has(sourceId)) throw new AppError(404);
        if (
          status.get(target.id) !== "freigegeben" ||
          status.get(sourceId) === "zusammengefuehrt"
        ) {
          throw new AppError(409, "Die Firmen wurden inzwischen geändert.");
        }
        // Erst die Quelle ausser Kraft setzen: Sonst kollidiert die übernommene UID mit dem
        // Index "firma_uid_gueltig".
        await t
          .updateTable("firma")
          .set({ status: "zusammengefuehrt", zusammengefuehrt_mit: target.id })
          .where("kunde_id", "=", kundeId)
          .where("id", "=", sourceId)
          .execute();
        await t
          .updateTable("mitglied")
          .set({ firma_id: target.id, geaendert_am: now })
          .where("kunde_id", "=", kundeId)
          .where("firma_id", "=", sourceId)
          .execute();
        const { kunde_id, id, ...changes } = firmaValues(target);
        await t
          .updateTable("firma")
          .set(changes)
          .where("kunde_id", "=", kunde_id)
          .where("id", "=", id)
          .execute();
      });
    },
  };

  return { members, gruppen, firmen, registrations: createPostgresRegistrations(db) };
}

function createPostgresRegistrations(db: Datenbank): RegistrationRepository {
  const run = runner(db);
  return {
    async put(p) {
      await run(p.kundeId, async (t) => {
        // Abgelaufene Einträge dieses Kunden gleich mit wegräumen: kein eigener Aufräum-Job nötig.
        await t
          .deleteFrom("registrierung_offen")
          .where("kunde_id", "=", p.kundeId)
          .where("ablauf_am", "<", new Date())
          .execute();
        await t
          .insertInto("registrierung_offen")
          .values({
            token_hash: p.tokenHash,
            kunde_id: p.kundeId,
            art: p.art,
            daten: sql`${JSON.stringify(p.daten)}::jsonb`,
            ablauf_am: p.ablaufAm,
          })
          .execute();
      });
    },

    /** Läuft ohne Mandant: Der Token liefert ihn. Löschen und Lesen in einem Statement, also einmalig. */
    async take(tokenHash) {
      const { rows } = await sql<{
        kunde_id: string;
        art: "person" | "firma";
        daten: unknown;
        ablauf_am: Date;
      }>`SELECT * FROM registrierung_einloesen(${tokenHash})`.execute(db.kysely);
      const r = rows[0];
      return (
        r && { tokenHash, kundeId: r.kunde_id, art: r.art, daten: r.daten, ablaufAm: r.ablauf_am }
      );
    },
  };
}

/** Öffentliche Kennung -> Kunden-ID, über eine schmale Funktion am RLS vorbei (kein Tabellenzugriff). */
export function createTenantResolver(db: Datenbank) {
  return async (slug: string): Promise<string | undefined> => {
    const { rows } = await sql<{
      id: string | null;
    }>`SELECT kunde_id_fuer_slug(${slug}) AS id`.execute(db.kysely);
    return rows[0]?.id ?? undefined;
  };
}
