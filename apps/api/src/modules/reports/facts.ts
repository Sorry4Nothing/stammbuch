import type { LedgerReadPort } from "./ledger-port.js";
import type { Cents } from "./money.js";

/**
 * Angaben aus Rechnungen, Zahlungsimport und Benutzerverwaltung, die der Periodenabschluss braucht (#111). Die
 * Auswertungen kennen deren Tabellen nicht; `facts-postgres.ts` liest sie, `InMemoryPeriodFacts` dient Tests und
 * der Entwicklung. Jede Methode ist auf einen Mandanten beschränkt.
 */

export interface PeriodRange {
  from: string;
  to: string;
}

/** Zahlungseingang aus dem Import, den noch niemand einer Rechnung zugeordnet hat. */
export interface Leftover {
  id: string;
  /** Valuta (ISO). */
  valueDate: string;
  payer: string;
  amountCents: Cents;
  /** Fester Satz zum Grund, nie Text aus der Bankdatei. */
  reason: string;
}

export interface PeriodFacts {
  /** Versendete Belege mit Rechnungsdatum in der Periode und davon die ohne Buchung in der Buchhaltung. */
  invoices: { total: number; unbooked: number };
  /** Entwürfe mit Rechnungsdatum in der Periode. */
  drafts: number;
  /** Offene Restposten mit Buchungsdatum in der Periode; `rows` ist auf `LEFTOVER_LIMIT` gekürzt. */
  leftovers: { count: number; totalCents: Cents; rows: Leftover[] };
  /** Gebuchte Buchungen mit Datum in der Periode, nach Art. */
  stats: { bookings: number; invoices: number; payments: number; reversals: number };
}

export const LEFTOVER_LIMIT = 200;

export interface PeriodFactsPort {
  periodFacts(tenantId: string, range: PeriodRange): Promise<PeriodFacts>;
  /** Anzahl Buchungen je Zeitraum, in der Reihenfolge der Eingabe. */
  bookingCounts(tenantId: string, ranges: PeriodRange[]): Promise<number[]>;
  /** Anzeigenamen zu Benutzerkennungen; unbekannte Kennungen fehlen im Ergebnis. */
  userNames(tenantId: string, ids: string[]): Promise<Map<string, string>>;
}

export const emptyFacts = (): PeriodFacts => ({
  invoices: { total: 0, unbooked: 0 },
  drafts: 0,
  leftovers: { count: 0, totalCents: 0, rows: [] },
  stats: { bookings: 0, invoices: 0, payments: 0, reversals: 0 },
});

export interface FactsData {
  facts?: Partial<PeriodFacts>;
  users?: Record<string, string>;
}

/**
 * In-Memory-Umsetzung für Tests und Entwicklung. Die Buchungszahlen kommen aus dem Hauptbuch (verschiedene
 * Buchungen mit Datum im Zeitraum), alles andere aus `seed`.
 */
export class InMemoryPeriodFacts implements PeriodFactsPort {
  private readonly data = new Map<string, FactsData>();

  constructor(private readonly ledger?: LedgerReadPort) {}

  seed(tenantId: string, data: FactsData): this {
    this.data.set(tenantId, data);
    return this;
  }

  private async bookings(tenantId: string, r: PeriodRange): Promise<number> {
    if (!this.ledger) return 0;
    const lines = await this.ledger.listJournalLines(tenantId, r);
    return new Set(lines.map((l) => l.bookingId)).size;
  }

  periodFacts = async (tenantId: string, range: PeriodRange): Promise<PeriodFacts> => {
    const seeded = this.data.get(tenantId)?.facts ?? {};
    const base = { ...emptyFacts(), ...seeded };
    const bookings = await this.bookings(tenantId, range);
    return { ...base, stats: { ...base.stats, bookings: seeded.stats?.bookings ?? bookings } };
  };

  bookingCounts = (tenantId: string, ranges: PeriodRange[]) =>
    Promise.all(ranges.map((r) => this.bookings(tenantId, r)));

  userNames = async (tenantId: string, ids: string[]) => {
    const users = this.data.get(tenantId)?.users ?? {};
    return new Map(
      ids.flatMap((id) => (users[id] !== undefined ? [[id, users[id]] as const] : [])),
    );
  };
}
