export type CamtKind = "camt.053" | "camt.054";
export type Direction = "CREDIT" | "DEBIT";
export type ReferenceKind = "QRR" | "SCOR";

/** Eine Einzelbuchung (TxDtls) aus einem Kontoauszug oder Avis, normalisiert. */
export interface CamtTransaction {
  accountIban: string;
  /** ISO-Datum YYYY-MM-DD */
  bookingDate: string;
  valueDate?: string;
  /** Betrag in Rappen (ganze Zahl, positiv); die Richtung steht in `direction`. */
  amountRappen: number;
  currency: string;
  /** Richtung der Buchung auf dem Konto: CREDIT = Gutschrift (Zahlungseingang). */
  direction: Direction;
  /** Storno bzw. Rückbuchung (RvslInd = true). */
  reversal: boolean;
  /** Bankreferenz der Buchung (AcctSvcrRef), falls vorhanden. */
  bankReference?: string;
  endToEndId?: string;
  reference?: { kind: ReferenceKind; value: string; valid: boolean };
  debtorName?: string;
  debtorIban?: string;
  remittanceInfo?: string;
  /** Position innerhalb der Datei; nur für Fehlersuche, nicht Teil der Identität. */
  ordinal: number;
}

export interface CamtDocument {
  kind: CamtKind;
  /** Schema-Version, z.B. "04" oder "08" */
  version: string;
  messageId: string;
  createdAt?: string;
  /** Nur gebuchte Einträge (Sts = BOOK). */
  transactions: CamtTransaction[];
  /** Anzahl nicht gebuchter Einträge (PDNG/INFO), die übersprungen wurden. */
  ignoredEntries: number;
}

export class CamtError extends Error {
  constructor(
    readonly code:
      | "INVALID_UPLOAD"
      | "FILE_TOO_LARGE"
      | "INVALID_XML"
      | "UNSUPPORTED_FORMAT"
      | "INVALID_CONTENT"
      | "DUPLICATE_FILE",
    message: string,
    readonly details?: { importId?: string },
  ) {
    super(message);
    this.name = "CamtError";
  }
}
