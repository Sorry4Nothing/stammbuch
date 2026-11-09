import type { Datenbank } from "@stammbuch/db";
import { sql } from "kysely";

/**
 * Port zum Rechnungsmodul: Das Personenmodul liest Rechnungen, Zahlungen und Mahnungen einer Person, ohne das
 * Rechnungsmodul zu kennen (kein Importzyklus; `invoices` benutzt `people`). Zugeordnet wird über die Kundennummer
 * der Rechnung: die Sammelrechnung setzt die Mitglied-ID, von Hand erfasste Rechnungen können die Mitgliedsnummer
 * tragen. Alle Methoden sind auf den Mandanten begrenzt (SR-11).
 */
export interface FinanceInvoice {
  id: string;
  nr: string;
  /** ISO-Datum der Rechnung. */
  datum: string;
  /** Rappen. */
  betrag: number;
  /** Noch offen nach Zahlungen und Gutschriften, Rappen. */
  offen: number;
  versendetAm: Date;
}

export interface FinanceData {
  /** Versendete und bezahlte Rechnungen (keine Entwürfe, keine stornierten, keine Gutschriften). */
  rechnungen: FinanceInvoice[];
  zahlungen: Array<{ datum: string; betrag: number; rechnungNr: string }>;
  mahnungen: Array<{ datum: string; stufe: number; rechnungId: string; rechnungNr: string }>;
  /** Versendete Mails an die E-Mail-Adresse. */
  mails: number;
}

export interface PersonFinance {
  /** `keys`: Kundennummern, die zur Person gehören (Mitglied-IDs, Mitgliedsnummer). */
  forPerson(kundeId: string, keys: string[], email: string | null): Promise<FinanceData>;
  /** Je Schlüssel: alle Rechnungen und davon die nicht abgeschlossenen (Entwurf, versendet). */
  counts(kundeId: string, keys: string[]): Promise<Map<string, { gesamt: number; offen: number }>>;
}

const num = (v: string | number) => Number(v);

export function createPostgresPersonFinance(db: Datenbank): PersonFinance {
  return {
    async forPerson(kundeId, keys, email) {
      if (keys.length === 0) return { rechnungen: [], zahlungen: [], mahnungen: [], mails: 0 };
      return db.withKunde(kundeId, async (trx) => {
        const invoices = await sql<{
          id: string;
          nummer: string;
          datum: string;
          total: string;
          offen: string;
          versendet_am: Date;
        }>`
          SELECT r.id, r.nummer, r.rechnungsdatum::text AS datum, r.total_rappen::text AS total, r.versendet_am,
                 (r.total_rappen
                   - COALESCE((SELECT sum(z.betrag_rappen) FROM rechnung_zahlung z WHERE z.rechnung_id = r.id), 0)
                   + COALESCE((SELECT sum(g.total_rappen) FROM rechnung g
                               WHERE g.gutschrift_zu = r.id AND g.status <> 'entwurf'), 0))::text AS offen
          FROM rechnung r
          WHERE r.kunde_id = ${kundeId} AND r.art = 'rechnung' AND r.status IN ('versendet', 'bezahlt')
            AND r.kundennummer = ANY(${keys}::text[])
          ORDER BY r.rechnungsdatum DESC, r.nummer DESC`.execute(trx);
        const payments = await sql<{ betrag: string; datum: string; nummer: string }>`
          SELECT z.betrag_rappen::text AS betrag, z.bezahlt_am::text AS datum, r.nummer
          FROM rechnung_zahlung z
          JOIN rechnung r ON r.kunde_id = z.kunde_id AND r.id = z.rechnung_id
          WHERE z.kunde_id = ${kundeId} AND r.art = 'rechnung' AND r.kundennummer = ANY(${keys}::text[])
          ORDER BY z.bezahlt_am, z.lfd`.execute(trx);
        const reminders = await sql<{
          stufe: number;
          datum: string;
          rechnung_id: string;
          nummer: string;
        }>`
          SELECT m.stufe, m.ausgestellt_am::text AS datum, m.rechnung_id, r.nummer
          FROM mahnung m
          JOIN rechnung r ON r.kunde_id = m.kunde_id AND r.id = m.rechnung_id
          WHERE m.kunde_id = ${kundeId} AND r.kundennummer = ANY(${keys}::text[])
          ORDER BY m.ausgestellt_am, m.stufe`.execute(trx);
        const mails = email
          ? await sql<{ n: string }>`
              SELECT count(*)::text AS n FROM mail_zustellung
              WHERE kunde_id = ${kundeId} AND status = 'sent' AND lower(empfaenger->>'email') = ${email.toLowerCase()}`.execute(
              trx,
            )
          : undefined;
        return {
          rechnungen: invoices.rows.map((r) => ({
            id: r.id,
            nr: r.nummer,
            datum: r.datum,
            betrag: num(r.total),
            offen: num(r.offen),
            versendetAm: r.versendet_am,
          })),
          zahlungen: payments.rows.map((p) => ({
            datum: p.datum,
            betrag: num(p.betrag),
            rechnungNr: p.nummer,
          })),
          mahnungen: reminders.rows.map((m) => ({
            datum: m.datum,
            stufe: m.stufe,
            rechnungId: m.rechnung_id,
            rechnungNr: m.nummer,
          })),
          mails: num(mails?.rows[0]?.n ?? 0),
        };
      });
    },

    async counts(kundeId, keys) {
      const out = new Map(keys.map((k) => [k, { gesamt: 0, offen: 0 }]));
      if (keys.length === 0) return out;
      const rows = await db.withKunde(kundeId, async (trx) => {
        const { rows } = await sql<{ kundennummer: string; gesamt: string; offen: string }>`
          SELECT kundennummer, count(*)::text AS gesamt,
                 count(*) FILTER (WHERE status IN ('entwurf', 'versendet'))::text AS offen
          FROM rechnung
          WHERE kunde_id = ${kundeId} AND art = 'rechnung' AND status <> 'storniert'
            AND kundennummer = ANY(${keys}::text[])
          GROUP BY kundennummer`.execute(trx);
        return rows;
      });
      for (const r of rows) out.set(r.kundennummer, { gesamt: num(r.gesamt), offen: num(r.offen) });
      return out;
    },
  };
}

/** Ohne Rechnungsmodul (Tests, Entwicklung ohne Datenbank): keine Rechnungen. */
export const noFinance: PersonFinance = {
  async forPerson() {
    return { rechnungen: [], zahlungen: [], mahnungen: [], mails: 0 };
  },
  async counts(_kundeId, keys) {
    return new Map(keys.map((k) => [k, { gesamt: 0, offen: 0 }]));
  },
};
