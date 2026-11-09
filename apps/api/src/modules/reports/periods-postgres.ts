import { sql } from "kysely";
import type { Datenbank } from "@stammbuch/db";
import { PeriodError } from "./periods.js";
import type {
  CheckIssue,
  Period,
  PeriodState,
  PeriodStore,
  PeriodTransition,
  VatConfirmation,
} from "./periods.js";

interface Row {
  id: string;
  bezeichnung: string;
  von: string;
  bis: string;
  status: PeriodState;
  version: number;
  befunde: CheckIssue[];
  verlauf: PeriodTransition[];
  pruef_fingerabdruck: string | null;
  mwst_bestaetigung: VatConfirmation | null;
}

const toPeriod = (r: Row): Period => ({
  id: r.id,
  label: r.bezeichnung,
  from: r.von,
  to: r.bis,
  state: r.status,
  version: r.version,
  issues: r.befunde,
  history: r.verlauf,
  ...(r.pruef_fingerabdruck ? { checkFingerprint: r.pruef_fingerabdruck } : {}),
  ...(r.mwst_bestaetigung ? { vatConfirmation: r.mwst_bestaetigung } : {}),
});

const COLUMNS = sql`id::text AS id, bezeichnung, von::text AS von, bis::text AS bis, status, version,
  befunde, verlauf, pruef_fingerabdruck, mwst_bestaetigung`;

/**
 * Perioden des Periodenabschlusses in `auswertung_periode`. Jede Methode läuft in einer Transaktion des Kunden
 * (RLS über `withKunde`) und filtert zusätzlich selbst auf `kunde_id` (SR-11). Schreiben prüft die Version
 * (optimistische Sperre); abgeschlossene Perioden verweigert schon die Datenbank (Trigger).
 */
export function createPostgresPeriodStore(db: Datenbank): PeriodStore {
  return {
    list: (k) =>
      db.withKunde(k, async (trx) => {
        const { rows } = await sql<Row>`
          SELECT ${COLUMNS} FROM auswertung_periode WHERE kunde_id = ${k} ORDER BY von`.execute(
          trx,
        );
        return rows.map(toPeriod);
      }),

    get: (k, id) =>
      db.withKunde(k, async (trx) => {
        // Keine UUID: keine Periode (statt eines Datenbankfehlers).
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
          return undefined;
        }
        const { rows } = await sql<Row>`
          SELECT ${COLUMNS} FROM auswertung_periode
          WHERE kunde_id = ${k} AND id = ${id}::uuid`.execute(trx);
        return rows[0] ? toPeriod(rows[0]) : undefined;
      }),

    save: (k, p, expectedVersion) =>
      db.withKunde(k, async (trx) => {
        const befunde = JSON.stringify(p.issues);
        const verlauf = JSON.stringify(p.history);
        const bestaetigung = p.vatConfirmation ? JSON.stringify(p.vatConfirmation) : null;
        if (expectedVersion === undefined) {
          try {
            await sql`
              INSERT INTO auswertung_periode
                (id, kunde_id, bezeichnung, von, bis, status, version, befunde, verlauf, pruef_fingerabdruck,
                 mwst_bestaetigung)
              VALUES (${p.id}::uuid, ${k}, ${p.label}, ${p.from}::date, ${p.to}::date, ${p.state},
                      ${p.version}, ${befunde}::jsonb, ${verlauf}::jsonb, ${p.checkFingerprint ?? null},
                      ${bestaetigung}::jsonb)
            `.execute(trx);
          } catch (e) {
            // Derselbe Beginn ist schon vergeben (paralleles Anlegen).
            if ((e as { code?: string }).code === "23505") {
              throw new PeriodError("CONFLICT", "Die Periode existiert bereits.");
            }
            throw e;
          }
          return;
        }
        const r = await sql`
          UPDATE auswertung_periode
          SET status = ${p.state}, version = ${p.version}, befunde = ${befunde}::jsonb,
              verlauf = ${verlauf}::jsonb, pruef_fingerabdruck = ${p.checkFingerprint ?? null},
              mwst_bestaetigung = ${bestaetigung}::jsonb
          WHERE kunde_id = ${k} AND id = ${p.id}::uuid AND version = ${expectedVersion}`.execute(
          trx,
        );
        if (Number(r.numAffectedRows ?? 0) !== 1) {
          throw new PeriodError("CONFLICT", "Die Periode wurde zwischenzeitlich geändert.");
        }
      }),
  };
}
