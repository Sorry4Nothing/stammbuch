import { sql } from "kysely";
import type { Datenbank } from "@stammbuch/db";
import type {
  Account,
  Debtor,
  JournalLine,
  LedgerReadPort,
  OpenItem,
  Settlement,
} from "../reports/ledger-port.js";
import { DEBTOR_CONTROL_ACCOUNT } from "./domain.js";
import { vatTransactionsOf } from "./vat-lines.js";
import type { VatLine } from "./vat-lines.js";

// bigint liefert pg als string. Beträge sind ganze Rappen unter 10^12 und bleiben als Summe weit unter 2^53.
const num = (v: string | number): number => Number(v);

/**
 * Lesender Zugang der Auswertungen (#42) zu den Buchhaltungs-Tabellen `buchhaltung_*`. Jede Methode läuft
 * in einer Transaktion des Kunden (RLS über `withKunde`) und filtert zusätzlich selbst auf `kunde_id`:
 * ein Mandant sieht nie Zeilen eines anderen (SR-11). Nur lesend, es wird nichts gebucht.
 */
export function createPostgresLedger(db: Datenbank): LedgerReadPort {
  return {
    listAccounts: (k) =>
      db.withKunde(k, async (trx) => {
        const { rows } = await sql<{
          nummer: string;
          name: string;
          art: Account["type"];
          steuersatz_bp: number | null;
        }>`
          SELECT nummer, name, art, steuersatz_bp FROM buchhaltung_konto
          WHERE kunde_id = ${k} ORDER BY nummer`.execute(trx);
        return rows.map((r): Account => ({
          id: r.nummer,
          number: r.nummer,
          name: r.name,
          type: r.art,
          ...(r.nummer === DEBTOR_CONTROL_ACCOUNT ? { debtorControl: true } : {}),
          ...(r.steuersatz_bp === null ? {} : { taxRateBp: r.steuersatz_bp }),
        }));
      }),

    listJournalLines: (k, range) =>
      db.withKunde(k, async (trx) => {
        const { rows } = await sql<{
          buchung_id: string;
          zeilennr: number;
          datum: string;
          konto: string;
          seite: "debit" | "credit";
          betrag: string;
          text: string;
        }>`
          SELECT z.buchung_id, z.zeilennr, b.buchungsdatum AS datum, z.konto_nummer AS konto,
                 z.seite, z.betrag, b.beschreibung AS text
          FROM buchhaltung_buchungszeile z
          JOIN buchhaltung_buchung b ON b.kunde_id = z.kunde_id AND b.id = z.buchung_id
          WHERE z.kunde_id = ${k}
            AND b.buchungsdatum <= ${range.to}::date
            AND (${range.from ?? null}::date IS NULL OR b.buchungsdatum >= ${range.from ?? null}::date)
          ORDER BY b.buchungsdatum, b.belegnummer, z.zeilennr`.execute(trx);
        return rows.map((r): JournalLine => ({
          id: `${r.buchung_id}:${r.zeilennr}`,
          bookingId: r.buchung_id,
          date: r.datum,
          accountId: r.konto,
          side: r.seite,
          amountCents: num(r.betrag),
          text: r.text,
        }));
      }),

    // Personen mit Debitorenzeilen; der Name stammt aus Mitglied oder Firma desselben Kunden, sonst «Unbekannt».
    listDebtors: (k) =>
      db.withKunde(k, async (trx) => {
        const { rows } = await sql<{
          person_id: string;
          name: string | null;
          mitglied_typ: string | null;
          mitgliedsnr: string | null;
          ist_firma: boolean;
        }>`
          SELECT d.person_id,
                 coalesce(nullif(trim(m.vorname || ' ' || m.nachname), ''), f.name) AS name,
                 m.typ AS mitglied_typ, m.mitgliedsnr, f.id IS NOT NULL AS ist_firma
          FROM (SELECT DISTINCT person_id FROM buchhaltung_buchungszeile
                WHERE kunde_id = ${k} AND person_id IS NOT NULL) d
          LEFT JOIN mitglied m ON m.kunde_id = ${k} AND m.id::text = d.person_id
          LEFT JOIN firma f ON f.kunde_id = ${k} AND f.id::text = d.person_id
          ORDER BY d.person_id`.execute(trx);
        // Eine Debitorennummer führt die Buchhaltung nicht; es gilt die Mitgliedsnummer (Firmen haben keine).
        return rows.map((r): Debtor => ({
          id: r.person_id,
          number: r.mitgliedsnr ?? "",
          name: r.name ?? "Unbekannt",
          // Firmen und Mitglieder vom Typ Firma sind Firmen, Einzelmitglieder Personen; unbekannte IDs bleiben ohne Art.
          ...(r.ist_firma || r.mitglied_typ === "firma"
            ? { type: "company" as const }
            : r.mitglied_typ
              ? { type: "person" as const }
              : {}),
        }));
      }),

    /**
     * Rechnungen sind positive, Zahlungen und Gutschriften negative Posten; Zuordnungen verringern beide
     * (Datum = Zeitpunkt der Zuordnung, UTC). So ergibt die Summe der offenen Beträge zu jedem Stichtag
     * den Saldo des Debitoren-Sammelkontos. Stornierte Belege entfallen ab dem Stornodatum.
     */
    listOpenItems: (k, asOf) =>
      db.withKunde(k, async (trx) => {
        const items = await sql<{
          id: string;
          person_id: string;
          referenz: string;
          beleg: string;
          faellig: string;
          betrag: string;
          negativ: boolean;
          mahnstufe: number;
        }>`
          SELECT * FROM (
            SELECT p.lfd, p.id, p.person_id, p.referenz, p.belegdatum AS beleg, p.faellig_am AS faellig,
                   p.betrag, false AS negativ, p.buchung_id, p.kunde_id,
                   -- Höchste Mahnstufe der Rechnung (Referenz des Postens = Rechnungsnummer) zum Stichtag.
                   coalesce((SELECT max(m.stufe) FROM mahnung m
                             JOIN rechnung r ON r.kunde_id = m.kunde_id AND r.id = m.rechnung_id
                             WHERE m.kunde_id = p.kunde_id AND r.nummer = p.referenz
                               AND m.ausgestellt_am <= ${asOf}::date), 0)::int AS mahnstufe
            FROM buchhaltung_offener_posten p
            UNION ALL
            SELECT g.lfd, g.id, g.person_id, g.referenz, g.valuta, g.valuta, g.betrag, true, g.buchung_id, g.kunde_id, 0
            FROM buchhaltung_guthaben g
          ) s
          WHERE s.kunde_id = ${k} AND s.beleg <= ${asOf}::date
            AND NOT EXISTS (
              SELECT FROM buchhaltung_buchung r
              WHERE r.kunde_id = s.kunde_id AND r.storno_von = s.buchung_id
                AND r.buchungsdatum <= ${asOf}::date)
          ORDER BY s.negativ, s.lfd`.execute(trx);
        const allocations = await sql<{
          posten_id: string;
          guthaben_id: string;
          datum: string;
          betrag: string;
        }>`
          SELECT posten_id, guthaben_id, (erstellt_am AT TIME ZONE 'UTC')::date AS datum, betrag
          FROM buchhaltung_zuordnung WHERE kunde_id = ${k} ORDER BY lfd`.execute(trx);

        const settlements = new Map<string, Settlement[]>();
        const add = (id: string, s: Settlement) =>
          settlements.set(id, [...(settlements.get(id) ?? []), s]);
        for (const z of allocations.rows) {
          add(z.posten_id, { date: z.datum, amountCents: num(z.betrag) });
          add(z.guthaben_id, { date: z.datum, amountCents: -num(z.betrag) });
        }
        return items.rows.map((r): OpenItem => ({
          id: r.id,
          debtorId: r.person_id,
          reference: r.referenz,
          issueDate: r.beleg,
          dueDate: r.faellig,
          amountCents: r.negativ ? -num(r.betrag) : num(r.betrag),
          settlements: settlements.get(r.id) ?? [],
          dunningLevel: r.mahnstufe,
        }));
      }),

    /**
     * Umsatz und Vorsteuer je Buchung aus den Zeilen, siehe `vatTransactionsOf`: Zeilen mit Satz (das Konto trug beim
     * Buchen einen) zählen zu diesem Satz, die übrigen nach der Regel für 2200 und 1170.
     */
    listVatTransactions: (k, range) =>
      db.withKunde(k, async (trx) => {
        const { rows } = await sql<{
          buchung_id: string;
          datum: string;
          buchungsart: string;
          konto: string;
          kontoart: VatLine["accountType"];
          seite: "debit" | "credit";
          betrag: string;
          satz: number | null;
        }>`
          SELECT z.buchung_id, b.buchungsdatum AS datum, b.art AS buchungsart, z.konto_nummer AS konto,
                 c.art AS kontoart, z.seite, z.betrag, z.steuersatz_bp AS satz
          FROM buchhaltung_buchungszeile z
          JOIN buchhaltung_buchung b ON b.kunde_id = z.kunde_id AND b.id = z.buchung_id
          JOIN buchhaltung_konto c ON c.kunde_id = z.kunde_id AND c.nummer = z.konto_nummer
          WHERE z.kunde_id = ${k} AND b.buchungsdatum BETWEEN ${range.from}::date AND ${range.to}::date
          ORDER BY b.buchungsdatum, b.belegnummer, z.zeilennr`.execute(trx);
        return vatTransactionsOf(
          rows.map((r): VatLine => ({
            bookingId: r.buchung_id,
            date: r.datum,
            bookingKind: r.buchungsart,
            account: r.konto,
            accountType: r.kontoart,
            side: r.seite,
            cents: num(r.betrag),
            rateBp: r.satz,
          })),
        );
      }),

    earliestBookingDate: (k) =>
      db.withKunde(k, async (trx) => {
        const { rows } = await sql<{ datum: string | null }>`
          SELECT min(buchungsdatum)::text AS datum FROM buchhaltung_buchung
          WHERE kunde_id = ${k}`.execute(trx);
        return rows[0]?.datum ?? undefined;
      }),
  };
}
