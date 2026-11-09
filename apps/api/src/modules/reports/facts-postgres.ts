import { sql } from "kysely";
import type { Datenbank } from "@stammbuch/db";
import { LEFTOVER_LIMIT } from "./facts.js";
import type { Leftover, PeriodFacts, PeriodFactsPort } from "./facts.js";

// Feste Sätze zu den Restposten-Gründen des Zahlungsimports (`RestReason` im Modul camt). Unbekannte Gründe fallen
// auf den allgemeinen Satz zurück; der Text aus der Bankdatei erreicht nie die Antwort.
const REASONS: Record<string, string> = {
  REVERSAL: "Rückbuchung der Bank",
  NO_REFERENCE: "Referenz fehlt",
  INVALID_REFERENCE: "Referenz ungültig",
  NO_OPEN_ITEM: "Kein offener Posten",
  AMBIGUOUS_OPEN_ITEM: "Mehrere offene Posten möglich",
  AMOUNT_MISMATCH: "Betrag weicht ab",
  OPEN_ITEM_ALREADY_PAID: "Rechnung bereits bezahlt",
  BOOKING_REJECTED: "Buchung abgelehnt",
};
const UNKNOWN_REASON = "Nicht zugeordnet";

const num = (v: string | number): number => Number(v);

/**
 * Lesender Zugang des Periodenabschlusses (#111) zu Rechnungen (`rechnung`), Zahlungsimport (`camt_zahlung`),
 * Buchungen und Benutzern. Jede Methode läuft in einer Transaktion des Kunden (RLS über `withKunde`) und filtert
 * zusätzlich selbst auf `kunde_id` (SR-11). Nur lesend.
 */
export function createPostgresPeriodFacts(db: Datenbank): PeriodFactsPort {
  return {
    periodFacts: (k, range) =>
      db.withKunde(k, async (trx): Promise<PeriodFacts> => {
        // Ein versendeter Beleg über 0.00 begründet keine Forderung und wird nicht gebucht. Rechnung und Gutschrift
        // stehen als offener Posten bzw. Gutschrift-Guthaben unter der Belegnummer als Referenz im Nebenbuch.
        const invoices = await sql<{ total: number; unbooked: number }>`
          SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE NOT EXISTS (
                   SELECT 1 FROM buchhaltung_offener_posten p
                   WHERE p.kunde_id = r.kunde_id AND p.referenz = r.nummer)
                 AND NOT EXISTS (
                   SELECT 1 FROM buchhaltung_guthaben g
                   WHERE g.kunde_id = r.kunde_id AND g.art = 'credit_note' AND g.referenz = r.nummer)
                 )::int AS unbooked
          FROM rechnung r
          WHERE r.kunde_id = ${k} AND r.nummer IS NOT NULL AND r.total_rappen <> 0
            AND r.rechnungsdatum BETWEEN ${range.from}::date AND ${range.to}::date`.execute(trx);

        const drafts = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM rechnung
          WHERE kunde_id = ${k} AND status = 'entwurf'
            AND rechnungsdatum BETWEEN ${range.from}::date AND ${range.to}::date`.execute(trx);

        const leftoverSum = await sql<{ n: number; summe: string }>`
          SELECT count(*)::int AS n, coalesce(sum(betrag_rappen), 0)::text AS summe
          FROM camt_zahlung
          WHERE kunde_id = ${k} AND status = 'REST'
            AND buchungsdatum BETWEEN ${range.from}::date AND ${range.to}::date`.execute(trx);
        const leftoverRows = await sql<{
          id: string;
          valuta: string;
          zahler: string | null;
          betrag: string;
          grund: string | null;
        }>`
          SELECT id::text, coalesce(transaktion->>'valueDate', buchungsdatum::text) AS valuta,
                 transaktion->>'debtorName' AS zahler, betrag_rappen::text AS betrag, rest_grund AS grund
          FROM camt_zahlung
          WHERE kunde_id = ${k} AND status = 'REST'
            AND buchungsdatum BETWEEN ${range.from}::date AND ${range.to}::date
          ORDER BY buchungsdatum DESC, lfd DESC
          LIMIT ${LEFTOVER_LIMIT}`.execute(trx);

        const stats = await sql<{ b: number; r: number; z: number; g: number }>`
          SELECT count(*)::int AS b,
                 count(*) FILTER (WHERE art IN ('invoice', 'credit_note'))::int AS r,
                 count(*) FILTER (WHERE art = 'payment')::int AS z,
                 count(*) FILTER (WHERE art = 'reversal')::int AS g
          FROM buchhaltung_buchung
          WHERE kunde_id = ${k}
            AND buchungsdatum BETWEEN ${range.from}::date AND ${range.to}::date`.execute(trx);

        const inv = invoices.rows[0];
        const sum = leftoverSum.rows[0];
        const st = stats.rows[0];
        return {
          invoices: { total: inv?.total ?? 0, unbooked: inv?.unbooked ?? 0 },
          drafts: drafts.rows[0]?.n ?? 0,
          leftovers: {
            count: sum?.n ?? 0,
            totalCents: num(sum?.summe ?? 0),
            rows: leftoverRows.rows.map((r): Leftover => ({
              id: r.id,
              valueDate: r.valuta,
              payer: r.zahler?.trim() || "Unbekannt",
              amountCents: num(r.betrag),
              reason: (r.grund && REASONS[r.grund]) || UNKNOWN_REASON,
            })),
          },
          stats: {
            bookings: st?.b ?? 0,
            invoices: st?.r ?? 0,
            payments: st?.z ?? 0,
            reversals: st?.g ?? 0,
          },
        };
      }),

    bookingCounts: (k, ranges) =>
      ranges.length === 0
        ? Promise.resolve([])
        : db.withKunde(k, async (trx) => {
            const { rows } = await sql<{ n: string; anzahl: number }>`
              SELECT p.n::text AS n, count(b.id)::int AS anzahl
              FROM unnest(${ranges.map((r) => r.from)}::date[], ${ranges.map((r) => r.to)}::date[])
                   WITH ORDINALITY AS p(von, bis, n)
              LEFT JOIN buchhaltung_buchung b
                ON b.kunde_id = ${k} AND b.buchungsdatum BETWEEN p.von AND p.bis
              GROUP BY p.n`.execute(trx);
            const byIndex = new Map(rows.map((r) => [Number(r.n), r.anzahl]));
            return ranges.map((_, i) => byIndex.get(i + 1) ?? 0);
          }),

    userNames: (k, ids) =>
      ids.length === 0
        ? Promise.resolve(new Map<string, string>())
        : db.withKunde(k, async (trx) => {
            const { rows } = await sql<{ id: string; name: string }>`
              SELECT id::text AS id, name FROM benutzer
              WHERE kunde_id = ${k} AND id::text = ANY(${ids}::text[])`.execute(trx);
            return new Map(rows.map((r) => [r.id, r.name]));
          }),
  };
}
