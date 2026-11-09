import type { CamtImportTable, CamtZahlungTable, Database, Datenbank } from "@stammbuch/db";
import { type Selectable, type Transaction, sql } from "kysely";
import { UniquenessError, bookMatched } from "./repository.js";
import type {
  AssignResult,
  BookMatched,
  CamtRepository,
  ImportCounts,
  ImportedPayment,
  ImportRecord,
  ImportSummary,
  PostponeResult,
  RestPage,
  RestReason,
} from "./repository.js";
import { CamtError } from "./types.js";
import type { CamtTransaction } from "./types.js";

/** Mandant und Benutzer der Anfrage, aus der serverseitigen Sitzung (SR-13), nie aus dem Request. */
export interface CamtContext {
  kundeId: string;
  benutzerId: string;
}

const UNIQUE_VIOLATION = "23505";
const INSERT_CHUNK = 500;

function toRecord(row: Selectable<CamtImportTable>): ImportRecord {
  return {
    id: row.id,
    fileHash: row.datei_hash,
    kind: row.art,
    version: row.version,
    messageId: row.nachricht_id,
    importedAt: row.importiert_am.toISOString(),
    counts: row.zaehler as unknown as ImportCounts,
  };
}

function toPayment(row: Selectable<CamtZahlungTable>): ImportedPayment {
  return {
    id: row.id,
    importId: row.import_id,
    bookingKey: row.buchungsschluessel,
    transaction: row.transaktion as unknown as CamtTransaction,
    status: row.status,
    ...(row.offener_posten_id ? { openItemId: row.offener_posten_id } : {}),
    ...(row.rest_grund ? { restReason: row.rest_grund as RestReason } : {}),
    ...(row.zurueckgestellt_am ? { postponed: true } : {}),
  };
}

/**
 * Kapselt eine Buchung in einem Savepoint: wird sie abgelehnt, bleiben keine Teilschreibungen zurück. Ein Fehler
 * (Exception) verwirft dagegen die ganze Transaktion, also den ganzen Import.
 */
const savepoint =
  (trx: Transaction<Database>) =>
  async (run: () => Promise<RestReason | undefined>): Promise<RestReason | undefined> => {
    await sql`SAVEPOINT zahlung_buchen`.execute(trx);
    const rejected = await run();
    if (rejected) await sql`ROLLBACK TO SAVEPOINT zahlung_buchen`.execute(trx);
    await sql`RELEASE SAVEPOINT zahlung_buchen`.execute(trx);
    return rejected;
  };

const isUniqueViolation = (err: unknown) =>
  typeof err === "object" && err !== null && "code" in err && err.code === UNIQUE_VIOLATION;

/** PostgreSQL-Persistenz für einen Kunden. Alle Zugriffe laufen in `withKunde` (RLS, SR-10). */
export class PgCamtRepository implements CamtRepository {
  constructor(
    private readonly db: Datenbank,
    private readonly ctx: CamtContext,
  ) {}

  private run<T>(fn: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
    return this.db.withKunde(this.ctx.kundeId, fn);
  }

  findImportByFileHash(fileHash: string) {
    return this.run(async (trx) => {
      const row = await trx
        .selectFrom("camt_import")
        .selectAll()
        .where("datei_hash", "=", fileHash)
        .executeTakeFirst();
      return row && toRecord(row);
    });
  }

  existingBookingKeys(keys: string[]) {
    if (keys.length === 0) return Promise.resolve(new Set<string>());
    return this.run(async (trx) => {
      const found = new Set<string>();
      for (let i = 0; i < keys.length; i += 5000) {
        const rows = await trx
          .selectFrom("camt_zahlung")
          .select("buchungsschluessel")
          .where("buchungsschluessel", "in", keys.slice(i, i + 5000))
          .execute();
        for (const r of rows) found.add(r.buchungsschluessel);
      }
      return found;
    });
  }

  async saveImport(input: ImportRecord, all: ImportedPayment[], book?: BookMatched) {
    const { kundeId, benutzerId } = this.ctx;
    try {
      return await this.run(async (trx) => {
        // Erst buchen, dann speichern: Zähler und Status im Import sind der Stand nach dem Buchen.
        const saved = book
          ? await bookMatched(input, all, book, trx, savepoint(trx))
          : { record: input, payments: all };
        const { record, payments } = saved;
        await trx
          .insertInto("camt_import")
          .values({
            id: record.id,
            kunde_id: kundeId,
            datei_hash: record.fileHash,
            art: record.kind,
            version: record.version,
            nachricht_id: record.messageId,
            zaehler: JSON.stringify(record.counts),
            importiert_am: record.importedAt,
            importiert_von: benutzerId,
          })
          .execute();
        for (let i = 0; i < payments.length; i += INSERT_CHUNK) {
          await trx
            .insertInto("camt_zahlung")
            .values(
              payments.slice(i, i + INSERT_CHUNK).map((p) => ({
                id: p.id,
                kunde_id: kundeId,
                import_id: record.id,
                buchungsschluessel: p.bookingKey,
                status: p.status,
                rest_grund: p.restReason ?? null,
                offener_posten_id: p.openItemId ?? null,
                buchungsdatum: p.transaction.bookingDate,
                betrag_rappen: p.transaction.amountRappen,
                waehrung: p.transaction.currency,
                richtung: p.transaction.direction,
                storno: p.transaction.reversal,
                transaktion: JSON.stringify(p.transaction),
              })),
            )
            .execute();
        }
        // Nur Zähler und IDs, keine Personendaten (SR-50).
        await trx
          .insertInto("audit_log")
          .values({
            kunde_id: kundeId,
            benutzer_id: benutzerId,
            aktion: "camt.import",
            objekt_typ: "camt_import",
            objekt_id: record.id,
            details: { counts: record.counts, kind: record.kind },
          })
          .execute();
        return saved;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new UniquenessError();
      throw err;
    }
  }

  listRestPayments({ limit, after }: { limit: number; after?: string }): Promise<RestPage> {
    if (after !== undefined && !/^\d{1,18}$/.test(after)) {
      throw new CamtError("INVALID_CURSOR", "Ungültiger Cursor.");
    }
    return this.run(async (trx) => {
      let q = trx.selectFrom("camt_zahlung").selectAll().where("status", "=", "REST");
      if (after !== undefined) q = q.where("lfd", ">", after);
      const rows = await q
        .orderBy("lfd")
        .limit(limit + 1)
        .execute();
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toPayment),
        ...(rows.length > limit && last ? { nextCursor: last.lfd } : {}),
      };
    });
  }

  listImports({ limit, offset }: { limit: number; offset: number }): Promise<ImportSummary[]> {
    return this.run(async (trx) => {
      const rows = await trx
        .selectFrom("camt_import as i")
        .leftJoin("benutzer as b", (j) =>
          j.onRef("b.id", "=", "i.importiert_von").onRef("b.kunde_id", "=", "i.kunde_id"),
        )
        .select([
          "i.id",
          "i.art",
          "i.nachricht_id",
          "i.zaehler",
          "i.importiert_am",
          "b.name as benutzer_name",
        ])
        .where("i.kunde_id", "=", this.ctx.kundeId)
        .orderBy("i.importiert_am", "desc")
        .orderBy("i.id")
        .limit(limit)
        .offset(offset)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        kind: r.art,
        messageId: r.nachricht_id,
        importedAt: r.importiert_am.toISOString(),
        counts: r.zaehler as unknown as ImportCounts,
        ...(r.benutzer_name ? { importedByName: r.benutzer_name } : {}),
      }));
    });
  }

  setPostponed(paymentId: string, postponed: boolean): Promise<PostponeResult> {
    const { kundeId, benutzerId } = this.ctx;
    return this.run(async (trx) => {
      const row = await trx
        .selectFrom("camt_zahlung")
        .select("status")
        .where("id", "=", paymentId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return "NOT_FOUND";
      if (row.status !== "REST") return "NOT_REST";
      await trx
        .updateTable("camt_zahlung")
        .set({
          zurueckgestellt_am: postponed ? new Date() : null,
          zurueckgestellt_von: postponed ? benutzerId : null,
        })
        .where("id", "=", paymentId)
        .execute();
      await trx
        .insertInto("audit_log")
        .values({
          kunde_id: kundeId,
          benutzer_id: benutzerId,
          aktion: postponed ? "camt.zahlung_zurueckgestellt" : "camt.zahlung_wieder_aufgenommen",
          objekt_typ: "camt_zahlung",
          objekt_id: paymentId,
          details: {},
        })
        .execute();
      return "OK";
    });
  }

  assignRest(
    input: { paymentId: string; openItemId: string },
    confirm: (payment: ImportedPayment, tx: unknown) => Promise<void>,
  ): Promise<AssignResult> {
    const { kundeId, benutzerId } = this.ctx;
    return this.run(async (trx) => {
      // FOR UPDATE: zwei gleichzeitige Zuordnungen derselben Zahlung laufen nacheinander.
      const row = await trx
        .selectFrom("camt_zahlung")
        .selectAll()
        .where("id", "=", input.paymentId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return "NOT_FOUND";
      if (row.status !== "REST") return "NOT_REST";
      await confirm(toPayment(row), trx);
      await trx
        .updateTable("camt_zahlung")
        .set({
          status: "MANUAL",
          offener_posten_id: input.openItemId,
          zugeordnet_von: benutzerId,
          zugeordnet_am: new Date(),
          zurueckgestellt_am: null,
          zurueckgestellt_von: null,
        })
        .where("id", "=", input.paymentId)
        .execute();
      await trx
        .insertInto("audit_log")
        .values({
          kunde_id: kundeId,
          benutzer_id: benutzerId,
          aktion: "camt.zahlung_zugeordnet",
          objekt_typ: "camt_zahlung",
          objekt_id: input.paymentId,
          details: { offenerPostenId: input.openItemId, vorherigerGrund: row.rest_grund },
        })
        .execute();
      return "ASSIGNED";
    });
  }
}
