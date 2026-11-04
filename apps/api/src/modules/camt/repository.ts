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
  status: "MATCHED" | "REST";
  /** Bei MATCHED der zugeordnete Posten; bei REST ggf. ein Vorschlag (z.B. AMOUNT_MISMATCH). */
  openItemId?: string;
  restReason?: RestReason;
}

/**
 * Persistenz des Imports. `saveImport` schreibt Import und Zahlungen atomar und muss
 * Dateihash sowie Buchungsschlüssel eindeutig halten (UNIQUE), damit parallele Uploads
 * derselben Datei keine Doppelbuchung erzeugen. Die DB-Implementierung folgt mit dem Schema.
 */
export interface CamtRepository {
  findImportByFileHash(fileHash: string): Promise<ImportRecord | undefined>;
  existingBookingKeys(keys: string[]): Promise<Set<string>>;
  saveImport(record: ImportRecord, payments: ImportedPayment[]): Promise<void>;
  listRestPayments(): Promise<ImportedPayment[]>;
}

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
      return Promise.reject(new Error("Import verletzt Eindeutigkeit."));
    }
    this.imports.set(record.fileHash, record);
    for (const p of payments) {
      this.keys.add(p.bookingKey);
      this.payments.push(p);
    }
    return Promise.resolve();
  }

  listRestPayments() {
    return Promise.resolve(this.payments.filter((p) => p.status === "REST"));
  }
}
