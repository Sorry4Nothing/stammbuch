import type { CamtKind, CamtTransaction } from "./types.js";

export type RestReason =
  | "REVERSAL"
  | "NO_REFERENCE"
  | "INVALID_REFERENCE"
  | "NO_OPEN_ITEM"
  | "AMBIGUOUS_OPEN_ITEM"
  | "AMOUNT_MISMATCH"
  | "OPEN_ITEM_ALREADY_PAID"
  /** Die Rechnung oder die Buchhaltung hat die Buchung abgelehnt (z. B. gesperrte Periode). */
  | "BOOKING_REJECTED";

export interface ImportCounts {
  /** Alle gebuchten Einzelbuchungen der Datei. */
  total: number;
  matched: number;
  rest: number;
  duplicates: number;
  /** Nicht gebuchte Einträge und normale Belastungen: für die Zuordnung ohne Belang. */
  ignored: number;
}

export interface ImportRecord {
  id: string;
  /** SHA-256 der Dateibytes (Hex): erkennt dieselbe Datei beim erneuten Hochladen. */
  fileHash: string;
  kind: CamtKind;
  version: string;
  messageId: string;
  importedAt: string;
  counts: ImportCounts;
}

export interface ImportedPayment {
  id: string;
  importId: string;
  /** Identität der Buchung über Dateigrenzen hinweg (siehe `bookingKey`). */
  bookingKey: string;
  transaction: CamtTransaction;
  /** MANUAL: ein Mensch hat einen Restposten zugeordnet. */
  status: "MATCHED" | "REST" | "MANUAL";
  /** Bei MATCHED/MANUAL der zugeordnete Posten; bei REST ggf. ein Vorschlag (z.B. AMOUNT_MISMATCH). */
  openItemId?: string;
  restReason?: RestReason;
}

/** Datei oder Buchung ist bereits gespeichert (UNIQUE verletzt), etwa durch einen parallelen Upload. */
export class UniquenessError extends Error {
  constructor() {
    super("Import verletzt Eindeutigkeit.");
    this.name = "UniquenessError";
  }
}

export interface RestPage {
  items: ImportedPayment[];
  /** Position hinter dem letzten Eintrag; fehlt auf der letzten Seite. */
  nextCursor?: string;
}

/**
 * Bucht eine automatisch zugeordnete Zahlung (im Rechnungsmodul und in der Buchhaltung) und liefert `undefined`
 * bei Erfolg oder den Grund, warum sie ein Restposten bleibt. `tx` ist die offene Transaktion des Repositories
 * (für die Datenbank: die Kysely-Transaktion), damit Zuordnung und Buchung zusammen bestätigt oder verworfen werden.
 */
export type BookMatched = (
  payment: ImportedPayment,
  tx: unknown,
) => Promise<RestReason | undefined>;

/**
 * Bucht alle MATCHED-Zahlungen; was nicht gebucht werden kann, wird zum Restposten (die Zähler im Import werden
 * angepasst). `isolate` kapselt eine Buchung so, dass eine abgelehnte keine Teilschreibungen hinterlässt.
 */
export async function bookMatched(
  record: ImportRecord,
  payments: ImportedPayment[],
  book: BookMatched,
  tx: unknown,
  isolate: (run: () => Promise<RestReason | undefined>) => Promise<RestReason | undefined> = (r) =>
    r(),
): Promise<{ record: ImportRecord; payments: ImportedPayment[] }> {
  let demoted = 0;
  const out: ImportedPayment[] = [];
  for (const p of payments) {
    const reason = p.status === "MATCHED" ? await isolate(() => book(p, tx)) : undefined;
    if (reason) {
      demoted++;
      out.push({ ...p, status: "REST", restReason: reason });
    } else out.push(p);
  }
  if (demoted === 0) return { record, payments: out };
  const { counts } = record;
  return {
    record: {
      ...record,
      counts: { ...counts, matched: counts.matched - demoted, rest: counts.rest + demoted },
    },
    payments: out,
  };
}

export type AssignResult = "ASSIGNED" | "NOT_FOUND" | "NOT_REST";

/**
 * Persistenz des Imports, immer für genau einen Kunden (Mandant und Benutzer stehen im Repository,
 * nicht in den Argumenten). `saveImport` schreibt Import, Zahlungen und Audit-Ereignis atomar und
 * wirft `UniquenessError`, wenn Dateihash oder Buchungsschlüssel schon vorhanden sind: so erzeugen
 * parallele Uploads derselben Datei keine Doppelbuchung.
 */
export interface CamtRepository {
  findImportByFileHash(fileHash: string): Promise<ImportRecord | undefined>;
  existingBookingKeys(keys: string[]): Promise<Set<string>>;
  /**
   * Mit `book` werden die MATCHED-Zahlungen in derselben Transaktion gebucht; abgelehnte werden Restposten.
   * Liefert den gespeicherten Stand (Zähler und Status nach dem Buchen).
   */
  saveImport(
    record: ImportRecord,
    payments: ImportedPayment[],
    book?: BookMatched,
  ): Promise<{ record: ImportRecord; payments: ImportedPayment[] }>;
  /** Restposten in fester Reihenfolge; `after` ist der `nextCursor` der vorigen Seite. */
  listRestPayments(page: { limit: number; after?: string }): Promise<RestPage>;
  /**
   * Sperrt den Restposten, ruft `confirm` mit der offenen Transaktion auf (wirft = nichts wird gespeichert,
   * auch nichts von `confirm`) und markiert ihn dann als manuell zugeordnet, mit Audit-Ereignis, alles in
   * einer Transaktion.
   */
  assignRest(
    input: { paymentId: string; openItemId: string },
    confirm: (payment: ImportedPayment, tx: unknown) => Promise<void>,
  ): Promise<AssignResult>;
}

/** Für Tests und als Standard ohne Datenbank: ein Kunde, ohne Audit. */
export class InMemoryCamtRepository implements CamtRepository {
  private readonly imports = new Map<string, ImportRecord>();
  private readonly payments: ImportedPayment[] = [];
  private readonly keys = new Set<string>();

  findImportByFileHash(fileHash: string) {
    return Promise.resolve(this.imports.get(fileHash));
  }

  existingBookingKeys(keys: string[]) {
    return Promise.resolve(new Set(keys.filter((k) => this.keys.has(k))));
  }

  async saveImport(record: ImportRecord, payments: ImportedPayment[], book?: BookMatched) {
    if (this.imports.has(record.fileHash) || payments.some((p) => this.keys.has(p.bookingKey))) {
      throw new UniquenessError();
    }
    // Ohne Datenbank gibt es kein Rollback: `book` muss vor dem Speichern fertig sein.
    const saved = book
      ? await bookMatched(record, payments, book, undefined)
      : { record, payments };
    this.imports.set(saved.record.fileHash, saved.record);
    for (const p of saved.payments) {
      this.keys.add(p.bookingKey);
      this.payments.push(p);
    }
    return saved;
  }

  listRestPayments({ limit, after }: { limit: number; after?: string }) {
    const rest = this.payments.filter((p) => p.status === "REST");
    const start = after === undefined ? 0 : rest.findIndex((p) => p.id === after) + 1;
    const items = rest.slice(start, start + limit);
    const more = start + limit < rest.length;
    return Promise.resolve({ items, ...(more ? { nextCursor: items.at(-1)?.id } : {}) });
  }

  async assignRest(
    input: { paymentId: string; openItemId: string },
    confirm: (payment: ImportedPayment, tx: unknown) => Promise<void>,
  ): Promise<AssignResult> {
    const p = this.payments.find((x) => x.id === input.paymentId);
    if (!p) return "NOT_FOUND";
    if (p.status !== "REST") return "NOT_REST";
    await confirm(p, undefined);
    p.status = "MANUAL";
    p.openItemId = input.openItemId;
    return "ASSIGNED";
  }
}
