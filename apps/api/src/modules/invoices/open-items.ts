import type { Datenbank } from "@stammbuch/db";
import { sql } from "kysely";

/**
 * Schnittstelle für den CAMT-Import (Issue #9): offene Posten zu Zahlungsreferenzen. Die Form entspricht
 * `OpenItemLookup` des CAMT-Moduls, damit dort `createOpenItemLookup(db, mandant)` direkt eingesetzt werden kann.
 */
export interface OpenItem {
  /** Rechnungs-ID; damit erfasst der Import die Zahlung (`InvoiceService.recordPayment`). */
  id: string;
  /** Normalisierte QR-/Creditor-Referenz der Rechnung (ohne Leerzeichen, Grossbuchstaben). */
  reference: string;
  /** Offener Betrag in Rappen: Rechnungsbetrag minus Zahlungen minus Gutschriften. */
  amountRappen: number;
  currency: string;
}

export interface OpenItemLookup {
  findByReferences(references: string[]): Promise<OpenItem[]>;
}

/** "RF18 5390 0754 7034" und "rf18539007547034" sind dieselbe Referenz. */
export const normalizeReference = (ref: string) => ref.replace(/\s+/g, "").toUpperCase();

const MAX_REFERENCES = 5000;

/**
 * Offene Posten eines Mandanten aus den Rechnungstabellen: versendete Rechnungen (keine Entwürfe, keine
 * Gutschriften, nicht bezahlt, nicht storniert) mit einem Restbetrag über null.
 */
export function createOpenItemLookup(db: Datenbank, tenantId: string): OpenItemLookup {
  return {
    async findByReferences(references) {
      const refs = [...new Set(references.map(normalizeReference).filter((r) => r !== ""))];
      if (refs.length === 0) return [];
      if (refs.length > MAX_REFERENCES) throw new Error("Zu viele Referenzen in einer Abfrage.");
      return db.withKunde(tenantId, async (trx) => {
        // Gutschriften sind negativ: Summe addieren. Zahlungen sind positiv: abziehen.
        const { rows } = await sql<{
          id: string;
          referenz: string;
          waehrung: string;
          offen: string;
        }>`
          SELECT r.id, r.referenz, r.waehrung,
                 r.total_rappen
                   - COALESCE((SELECT sum(z.betrag_rappen) FROM rechnung_zahlung z WHERE z.rechnung_id = r.id), 0)
                   + COALESCE((SELECT sum(g.total_rappen) FROM rechnung g
                               WHERE g.gutschrift_zu = r.id AND g.status <> 'entwurf'), 0) AS offen
          FROM rechnung r
          WHERE r.kunde_id = ${tenantId}
            AND r.art = 'rechnung' AND r.status = 'versendet'
            AND r.referenz = ANY(${refs}::text[])
          ORDER BY r.referenz, r.id`.execute(trx);
        return rows
          .filter((r) => Number(r.offen) > 0)
          .map((r) => ({
            id: r.id,
            reference: r.referenz,
            amountRappen: Number(r.offen),
            currency: r.waehrung,
          }));
      });
    },
  };
}
