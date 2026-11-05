import type { CamtKind, CamtTransaction } from "./types.js";

export type RestReason =
  | "REVERSAL"
  | "NO_REFERENCE"
  | "INVALID_REFERENCE"
  | "NO_OPEN_ITEM"
  | "AMBIGUOUS_OPEN_ITEM"
  | "AMOUNT_MISMATCH"
  | "OPEN_ITEM_ALREADY_PAID";

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
  saveImport(record: ImportRecord, payments: ImportedPayment[]): Promise<void>;
  /** Restposten in fester Reihenfolge; `after` ist der `nextCursor` der vorigen Seite. */
  listRestPayments(page: { limit: number; after?: string }): Promise<RestPage>;
  /**
   * Sperrt den Restposten, ruft `confirm` auf (wirft = nichts wird gespeichert) und markiert ihn
   * dann als manuell zugeordnet, mit Audit-Ereignis, alles in einer Transaktion.
   */
  assignRest(
    input: { paymentId: string; openItemId: string },
    confirm: (payment: ImportedPayment) => Promise<void>,
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

  saveImport(record: ImportRecord, payments: ImportedPayment[]) {
    if (this.imports.has(record.fileHash) || payments.some((p) => this.keys.has(p.bookingKey))) {
      return Promise.reject(new UniquenessError());
    }
    this.imports.set(record.fileHash, record);
    for (const p of payments) {
      this.keys.add(p.bookingKey);
      this.payments.push(p);
    }
    return Promise.resolve();
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
    confirm: (payment: ImportedPayment) => Promise<void>,
  ): Promise<AssignResult> {
    const p = this.payments.find((x) => x.id === input.paymentId);
    if (!p) return "NOT_FOUND";
    if (p.status !== "REST") return "NOT_REST";
    await confirm(p);
    p.status = "MANUAL";
    p.openItemId = input.openItemId;
    return "ASSIGNED";
  }
}
