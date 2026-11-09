import type { Database, Datenbank, FirmaTable, GruppeTable, MitgliedTable } from "@stammbuch/db";
import type { Address } from "@stammbuch/shared";
import { sql } from "kysely";
import type { Selectable, Transaction } from "kysely";
import { AppError } from "../../lib/errors.js";
import type { Firma, Gruppe, Member, MemberEreignis } from "./domain.js";
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

function page<T>(rows: Array<T & { _key: string }>, limit: number, total: number): Page<T> {
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  return { items, next: more ? (items.at(-1)?._key ?? null) : null, total };
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

type MemberRow = Selectable<MitgliedTable> & {
  gruppe_id: string | null;
  gruppe_seit: Date | null;
};

const toMember = (r: MemberRow): Member => ({
  id: r.id,
  kundeId: r.kunde_id,
  mitgliedsnr: r.mitgliedsnr,
  typ: r.typ,
  status: r.status,
  quelle: r.quelle,
  zusammengefuehrtMit: r.zusammengefuehrt_mit,
  anrede: r.anrede,
  vorname: r.vorname,
  nachname: r.nachname,
  email: r.email,
  telefon: r.telefon,
  mobil: r.mobil,
  adresse: addressOf(r),
  notiz: r.notiz,
  geburtsdatum: r.geburtsdatum,
  eintritt: r.eintritt,
  kanal: r.kanal,
  funktion: r.funktion,
  firmaId: r.firma_id,
  gruppeId: r.gruppe_id,
  gruppeSeit: r.gruppe_seit,
  erstelltAm: r.erstellt_am,
  geaendertAm: r.geaendert_am,
});

const memberValues = (m: Member) => ({
  kunde_id: m.kundeId,
  id: m.id,
  typ: m.typ,
  status: m.status,
  quelle: m.quelle,
  zusammengefuehrt_mit: m.zusammengefuehrtMit,
  anrede: m.anrede,
  vorname: m.vorname,
  nachname: m.nachname,
  email: m.email,
  telefon: m.telefon,
  mobil: m.mobil,
  ...addressColumns(m.adresse),
  notiz: m.notiz,
  geburtsdatum: m.geburtsdatum,
  eintritt: m.eintritt,
  kanal: m.kanal,
  funktion: m.funktion,
  firma_id: m.firmaId,
  erstellt_am: m.erstelltAm,
  geaendert_am: m.geaendertAm,
});

const toGruppe = (r: Selectable<GruppeTable>): Gruppe => ({
  id: r.id,
  kundeId: r.kunde_id,
  name: r.name,
  beschreibung: r.beschreibung,
  erstelltAm: r.erstellt_am,
  geaendertAm: r.geaendert_am,
});

/**
 * Reserviert `count` Mitgliedsnummern des Kunden mit einem UPDATE (ein Block statt einer Zeile je
 * Nummer) und gibt die erste zurück. Die Sperre hält bis zum Ende der Transaktion.
 */
async function reserveNumbers(t: Trx, kundeId: string, count: number): Promise<number> {
  const r = await t
    .insertInto("mitglied_nummernkreis")
    .values({ kunde_id: kundeId, letzte_nummer: 1000 + count })
    .onConflict((oc) =>
      oc.column("kunde_id").doUpdateSet((eb) => ({
        letzte_nummer: eb("mitglied_nummernkreis.letzte_nummer", "+", count),
      })),
    )
    .returning("letzte_nummer")
    .executeTakeFirstOrThrow();
  return r.letzte_nummer - count + 1;
}

/** Fügt Mitglieder in Blöcken ein und vergibt die Mitgliedsnummern der Reihe nach. */
async function insertChunks(t: Trx, kundeId: string, list: Member[]): Promise<Member[]> {
  if (list.length === 0) return [];
  let next = await reserveNumbers(t, kundeId, list.length);
  const out: Member[] = [];
  for (let i = 0; i < list.length; i += INSERT_CHUNK) {
    const chunk = list.slice(i, i + INSERT_CHUNK).map((m) => ({
      ...m,
      kundeId,
      mitgliedsnr: `M-${next++}`,
      gruppeId: null,
      gruppeSeit: null,
    }));
    await t
      .insertInto("mitglied")
      .values(chunk.map((m) => ({ ...memberValues(m), mitgliedsnr: m.mitgliedsnr })))
      .execute();
    out.push(...chunk);
  }
  return out;
}

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
  rechnungsEmail: r.rechnungs_email,
  notiz: r.notiz,
  quelle: r.quelle,
  erfasstVonId: r.erfasst_von,
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
  rechnungs_email: f.rechnungsEmail,
  notiz: f.notiz,
  quelle: f.quelle,
  erfasst_von: f.erfasstVonId,
});

function memberFrom(trx: Trx) {
  return trx
    .selectFrom("mitglied as m")
    .leftJoin("gruppe_mitgliedschaft as gm", (j) =>
      j.onRef("gm.kunde_id", "=", "m.kunde_id").onRef("gm.mitglied_id", "=", "m.id"),
    );
}

function memberSelect(trx: Trx) {
  return memberFrom(trx).selectAll("m").select(["gm.gruppe_id", "gm.seit as gruppe_seit"]);
}

/** Filter einer Mitgliederliste ohne Cursor: Grundlage für die Seite und für die Gesamtzahl. */
function memberFilter(trx: Trx, kundeId: string, q: MemberQuery) {
  let qb = memberFrom(trx).where("m.kunde_id", "=", kundeId);
  qb =
    q.status === "alle"
      ? qb.where("m.status", "<>", "zusammengefuehrt")
      : qb.where("m.status", "=", q.status);
  if (q.quelle) qb = qb.where("m.quelle", "=", q.quelle);
  if (q.typ) qb = qb.where("m.typ", "=", q.typ);
  if (q.firmaId) qb = qb.where("m.firma_id", "=", q.firmaId);
  if (q.gruppeId) qb = qb.where("gm.gruppe_id", "=", q.gruppeId);
  if (q.ohneGruppe) qb = qb.where("gm.gruppe_id", "is", null);
  for (const token of searchTokens(q.q)) qb = qb.where(like("m.suchtext", token));
  return qb;
}

/**
 * PostgreSQL-Implementierung. Alle Zugriffe laufen über `Datenbank.withKunde`: RLS begrenzt auf den
 * Mandanten, `kunde_id` steht zusätzlich in jeder Abfrage (doppelte Absicherung, SR-10).
 */
export function createPostgresStore(db: Datenbank): PeopleStore {
  const run = runner(db);

  const members: PeopleStore["members"] = {
    async insert(m) {
      const [stored] = await run(m.kundeId, (t) => insertChunks(t, m.kundeId, [m]));
      return stored as Member;
    },

    async insertMany(kundeId, list) {
      return run(kundeId, (t) => insertChunks(t, kundeId, list));
    },

    async importieren(kundeId, batch) {
      return run(kundeId, async (t) => {
        const created = await insertChunks(t, kundeId, batch.neu);
        for (const m of batch.geaendert) {
          const { kunde_id, id, ...changes } = memberValues(m);
          const r = await t
            .updateTable("mitglied")
            .set(changes)
            .where("kunde_id", "=", kunde_id)
            .where("id", "=", id)
            .executeTakeFirst();
          if (r.numUpdatedRows === 0n) throw new AppError(404);
        }
        const ids = batch.gruppen.map(([memberId]) => memberId);
        if (ids.length > 0) {
          await t
            .deleteFrom("gruppe_mitgliedschaft")
            .where("kunde_id", "=", kundeId)
            .where("mitglied_id", "in", ids)
            .execute();
          for (let i = 0; i < batch.gruppen.length; i += INSERT_CHUNK) {
            const chunk = batch.gruppen
              .slice(i, i + INSERT_CHUNK)
              .map(([mitglied_id, gruppe_id]) => ({
                kunde_id: kundeId,
                mitglied_id,
                gruppe_id,
              }));
            await t.insertInto("gruppe_mitgliedschaft").values(chunk).execute();
          }
        }
        return created;
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

    async existingByEmail(kundeId, emails) {
      if (emails.length === 0) return new Map();
      const rows = await run(kundeId, (t) =>
        memberSelect(t).where("m.kunde_id", "=", kundeId).where("m.email", "in", emails).execute(),
      );
      return new Map(rows.map((r) => [r.email as string, toMember(r)]));
    },

    async list(kundeId, q: MemberQuery) {
      const [rows, total] = await run(kundeId, async (t) => {
        const filtered = memberFilter(t, kundeId, q);
        const count = await filtered
          .select((eb) => eb.fn.countAll<string>().as("n"))
          .executeTakeFirstOrThrow();
        let qb = filtered
          .selectAll("m")
          .select(["gm.gruppe_id", "gm.seit as gruppe_seit"])
          .select(
            sql<string>`m.nachname_sort || ${SEP} || m.vorname_sort || ${SEP} || m.id::text`.as(
              "_key",
            ),
          );
        if (q.after !== undefined) {
          const [n, v, id] = splitCursor(q.after, 3);
          qb = qb.where(
            sql<boolean>`(m.nachname_sort, m.vorname_sort, m.id) > (${n}::text COLLATE "C", ${v}::text COLLATE "C", ${id}::uuid)`,
          );
        }
        const items = await qb
          .orderBy("m.nachname_sort")
          .orderBy("m.vorname_sort")
          .orderBy("m.id")
          .limit(q.limit + 1)
          .execute();
        return [items, Number(count.n)] as const;
      });
      return page(
        rows.map((r) => ({ ...toMember(r), _key: r._key })),
        q.limit,
        total,
      );
    },
    async listCandidates(kundeId) {
      const rows = await run(kundeId, (t) =>
        memberSelect(t)
          .where("m.kunde_id", "=", kundeId)
          .where("m.typ", "=", "einzel")
          .where("m.status", "in", ["aktiv", "ausstehend", "archiviert"])
          .execute(),
      );
      return rows.map(toMember);
    },

    async duplikatAusnahmen(kundeId) {
      const rows = await run(kundeId, (t) =>
        t
          .selectFrom("mitglied_duplikat_ausnahme")
          .select(["mitglied_a", "mitglied_b"])
          .where("kunde_id", "=", kundeId)
          .execute(),
      );
      return new Set(rows.map((r) => `${r.mitglied_a}_${r.mitglied_b}`));
    },

    async addDuplikatAusnahme(kundeId, a, b) {
      // Fremdschlüssel (kunde_id, id): eine Person eines anderen Mandanten wird zu 404.
      await run(kundeId, (t) =>
        t
          .insertInto("mitglied_duplikat_ausnahme")
          .values({ kunde_id: kundeId, mitglied_a: a, mitglied_b: b })
          .onConflict((oc) => oc.doNothing())
          .execute(),
      );
    },

    async merge(kundeId, target, sourceId, now) {
      await run(kundeId, async (t) => {
        // Beide Zeilen in fester Reihenfolge sperren (keine Deadlocks) und den Stand unter Sperre prüfen:
        // der Dienst hat ihn vorher ohne Sperre gelesen.
        const locked = await t
          .selectFrom("mitglied")
          .select(["id", "status"])
          .where("kunde_id", "=", kundeId)
          .where("id", "in", [target.id, sourceId])
          .orderBy("id")
          .forUpdate()
          .execute();
        const status = new Map(locked.map((r) => [r.id, r.status]));
        if (!status.has(target.id) || !status.has(sourceId)) throw new AppError(404);
        const sourceStatus = status.get(sourceId);
        if (
          status.get(target.id) !== "aktiv" ||
          sourceStatus === "zusammengefuehrt" ||
          sourceStatus === "abgelehnt"
        ) {
          throw new AppError(409, "Die Personen wurden inzwischen geändert.");
        }
        const groups = await t
          .selectFrom("gruppe_mitgliedschaft")
          .select(["mitglied_id", "gruppe_id", "seit"])
          .where("kunde_id", "=", kundeId)
          .where("mitglied_id", "in", [target.id, sourceId])
          .execute();
        const von = groups.find((g) => g.mitglied_id === sourceId);
        const nach = groups.find((g) => g.mitglied_id === target.id);
        if (von && nach && von.gruppe_id !== nach.gruppe_id) {
          throw new AppError(409, "Die Personen sind in verschiedenen Gruppen.");
        }
        // Die Quelle gibt ihre E-Mail-Adresse frei (UNIQUE je Kunde), bevor das Ziel sie übernimmt.
        await t
          .updateTable("mitglied")
          .set({
            status: "zusammengefuehrt",
            zusammengefuehrt_mit: target.id,
            email: null,
            geaendert_am: now,
          })
          .where("kunde_id", "=", kundeId)
          .where("id", "=", sourceId)
          .execute();
        if (von) {
          await t
            .deleteFrom("gruppe_mitgliedschaft")
            .where("kunde_id", "=", kundeId)
            .where("mitglied_id", "=", sourceId)
            .execute();
          if (!nach) {
            await t
              .insertInto("gruppe_mitgliedschaft")
              .values({
                kunde_id: kundeId,
                mitglied_id: target.id,
                gruppe_id: von.gruppe_id,
                seit: von.seit,
              })
              .execute();
          }
        }
        // Einladungen samt Antworten (hängen an der Einladung) zeigen danach auf das Ziel.
        await t
          .updateTable("kalender_einladung")
          .set({ mitglied_id: target.id })
          .where("kunde_id", "=", kundeId)
          .where("mitglied_id", "=", sourceId)
          .execute();
        const { kunde_id, id, ...changes } = memberValues(target);
        await t
          .updateTable("mitglied")
          .set(changes)
          .where("kunde_id", "=", kunde_id)
          .where("id", "=", id)
          .execute();
      });
    },

    async mergedInto(kundeId, id) {
      const rows = await run(kundeId, (t) =>
        t
          .selectFrom("mitglied")
          .select("id")
          .where("kunde_id", "=", kundeId)
          .where("zusammengefuehrt_mit", "=", id)
          .execute(),
      );
      return rows.map((r) => r.id);
    },

    async addEreignis(kundeId, e) {
      await run(kundeId, (t) =>
        t
          .insertInto("mitglied_ereignis")
          .values({
            kunde_id: kundeId,
            mitglied_id: e.memberId,
            art: e.art,
            detail: e.detail,
            erstellt_am: e.am,
          })
          .execute(),
      );
    },

    async ereignisse(kundeId, memberIds): Promise<MemberEreignis[]> {
      if (memberIds.length === 0) return [];
      const rows = await run(kundeId, (t) =>
        t
          .selectFrom("mitglied_ereignis")
          .select(["mitglied_id", "art", "detail", "erstellt_am"])
          .where("kunde_id", "=", kundeId)
          .where("mitglied_id", "in", memberIds)
          .orderBy("erstellt_am")
          .orderBy("id")
          .execute(),
      );
      return rows.map((r) => ({
        memberId: r.mitglied_id,
        art: r.art,
        detail: r.detail,
        am: r.erstellt_am,
      }));
    },
  };

  const gruppen: PeopleStore["gruppen"] = {
    async insert(g: Gruppe) {
      await run(g.kundeId, (t) =>
        t
          .insertInto("gruppe")
          .values({
            kunde_id: g.kundeId,
            id: g.id,
            name: g.name,
            beschreibung: g.beschreibung,
            erstellt_am: g.erstelltAm,
            geaendert_am: g.geaendertAm,
          })
          .execute(),
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
      return r && toGruppe(r);
    },

    async list(kundeId) {
      const [rows, listen] = await run(kundeId, async (t) => {
        const groups = await t
          .selectFrom("gruppe as g")
          .leftJoin("gruppe_mitgliedschaft as gm", (j) =>
            j.onRef("gm.kunde_id", "=", "g.kunde_id").onRef("gm.gruppe_id", "=", "g.id"),
          )
          .selectAll("g")
          .select((eb) => eb.fn.count<string>("gm.mitglied_id").as("mitglieder"))
          .where("g.kunde_id", "=", kundeId)
          .groupBy(["g.kunde_id", "g.id"])
          .orderBy(sql`suchtext_normalisieren(g.name) COLLATE "C"`)
          .orderBy("g.id")
          .execute();
        // Adresslisten des Mail-Moduls, die auf Gruppen verweisen (nur Namen).
        const lists = await t
          .selectFrom("mail_adressliste")
          .select(["name", "gruppen_ids"])
          .where("kunde_id", "=", kundeId)
          .orderBy("name")
          .execute();
        return [groups, lists] as const;
      });
      return rows.map((r) => ({
        ...toGruppe(r),
        mitglieder: Number(r.mitglieder),
        adresslisten: listen.filter((l) => l.gruppen_ids.includes(r.id)).map((l) => l.name),
      }));
    },

    async update(kundeId, id, patch, now) {
      const r = await run(kundeId, (t) =>
        t
          .updateTable("gruppe")
          .set({
            geaendert_am: now,
            ...(patch.name !== undefined && { name: patch.name }),
            ...(patch.beschreibung !== undefined && { beschreibung: patch.beschreibung }),
          })
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

    async countMitglieder(kundeId, ids) {
      const counts = new Map(ids.map((id) => [id, 0]));
      if (ids.length === 0) return counts;
      const rows = await run(kundeId, (t) =>
        t
          .selectFrom("mitglied")
          .select(["firma_id", (eb) => eb.fn.countAll<string>().as("n")])
          .where("kunde_id", "=", kundeId)
          .where("status", "=", "aktiv")
          .where("firma_id", "in", ids)
          .groupBy("firma_id")
          .execute(),
      );
      for (const r of rows) if (r.firma_id) counts.set(r.firma_id, Number(r.n));
      return counts;
    },

    async list(kundeId, q: FirmaQuery) {
      const [rows, total] = await run(kundeId, async (t) => {
        let filtered = t.selectFrom("firma as f").where("f.kunde_id", "=", kundeId);
        if (q.status) filtered = filtered.where("f.status", "=", q.status);
        if (q.quelle) filtered = filtered.where("f.quelle", "=", q.quelle);
        for (const token of searchTokens(q.q)) filtered = filtered.where(like("f.suchtext", token));
        const count = await filtered
          .select((eb) => eb.fn.countAll<string>().as("n"))
          .executeTakeFirstOrThrow();
        let qb = filtered
          .selectAll("f")
          .select(sql<string>`f.name_sort || ${SEP} || f.id::text`.as("_key"));
        if (q.after !== undefined) {
          const [n, id] = splitCursor(q.after, 2);
          qb = qb.where(sql<boolean>`(f.name_sort, f.id) > (${n}::text COLLATE "C", ${id}::uuid)`);
        }
        const items = await qb
          .orderBy("f.name_sort")
          .orderBy("f.id")
          .limit(q.limit + 1)
          .execute();
        return [items, Number(count.n)] as const;
      });
      return page(
        rows.map((r) => ({ ...toFirma(r), _key: r._key })),
        q.limit,
        total,
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

    async duplikatAusnahmen(kundeId) {
      const rows = await run(kundeId, (t) =>
        t
          .selectFrom("firma_duplikat_ausnahme")
          .select(["firma_a", "firma_b"])
          .where("kunde_id", "=", kundeId)
          .execute(),
      );
      return new Set(rows.map((r) => `${r.firma_a}_${r.firma_b}`));
    },

    async addDuplikatAusnahme(kundeId, a, b) {
      // Fremdschlüssel (kunde_id, id): eine Firma eines anderen Mandanten wird zu 404.
      await run(kundeId, (t) =>
        t
          .insertInto("firma_duplikat_ausnahme")
          .values({ kunde_id: kundeId, firma_a: a, firma_b: b })
          .onConflict((oc) => oc.doNothing())
          .execute(),
      );
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

  const benutzer: PeopleStore["benutzer"] = {
    async names(kundeId, ids) {
      if (ids.length === 0) return new Map();
      const rows = await run(kundeId, (t) =>
        t
          .selectFrom("benutzer")
          .select(["id", "name"])
          .where("kunde_id", "=", kundeId)
          .where("id", "in", ids)
          .execute(),
      );
      return new Map(rows.map((r) => [r.id, r.name]));
    },
  };

  return { members, gruppen, firmen, benutzer, registrations: createPostgresRegistrations(db) };
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
