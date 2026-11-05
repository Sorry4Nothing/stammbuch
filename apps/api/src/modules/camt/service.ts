import { createHash, randomUUID } from "node:crypto";
import { parseCamt } from "./parser.js";
import { UniquenessError } from "./repository.js";
import type {
  BookMatched,
  CamtRepository,
  ImportCounts,
  ImportedPayment,
  ImportRecord,
  RestReason,
} from "./repository.js";
import type { ManualAssignPort } from "./rest.js";
import { CamtError } from "./types.js";
import type { CamtDocument, CamtTransaction } from "./types.js";
import { checkUpload } from "./upload.js";

/** Offener Posten (Rechnung), gegen den eine Zahlung geprüft wird. Kommt aus dem Rechnungsmodul. */
export interface OpenItem {
  id: string;
  /** Normalisierte QR-/Creditor-Referenz der Rechnung. */
  reference: string;
  amountRappen: number;
  currency: string;
}

export interface OpenItemLookup {
  /** Liefert nur offene (unbezahlte) Posten zu den gegebenen Referenzen. */
  findByReferences(references: string[]): Promise<OpenItem[]>;
}

export interface ImportResult {
  import: ImportRecord;
  matched: ImportedPayment[];
  rest: ImportedPayment[];
  duplicates: CamtTransaction[];
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Fester Schlüssel einer Buchung; die Zählung trennt identische Buchungen innerhalb einer Datei. */
function bookingKeys(txs: CamtTransaction[]): string[] {
  const seen = new Map<string, number>();
  return txs.map((t) => {
    const base = [
      t.accountIban,
      t.bookingDate,
      t.bankReference ?? "",
      t.amountRappen,
      t.currency,
      t.direction,
      t.reversal,
      t.reference?.value ?? "",
      t.endToEndId ?? "",
    ].join("|");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return sha256(Buffer.from(`${base}|${n}`));
  });
}

export class CamtImportService {
  constructor(
    private readonly repo: CamtRepository,
    private readonly openItems: OpenItemLookup,
    /** Bucht automatisch zugeordnete Zahlungen. Ohne Angabe wird nur zugeordnet (Tests, Entwicklung). */
    private readonly booker?: ManualAssignPort,
  ) {}

  async importFile(bytes: Uint8Array): Promise<ImportResult> {
    const xml = checkUpload(bytes);
    const fileHash = sha256(bytes);
    const known = await this.repo.findImportByFileHash(fileHash);
    if (known) {
      throw new CamtError("DUPLICATE_FILE", "Datei wurde bereits importiert.", {
        importId: known.id,
      });
    }

    const doc = parseCamt(xml);
    // Ein paralleler Import kann zwischen Prüfung und Speichern dazwischenkommen. Die Datenbank
    // lehnt ihn ab (UNIQUE); dann entscheidet ein neuer Durchlauf: dieselbe Datei = Duplikat,
    // überlappende Buchungen werden jetzt als Duplikate erkannt.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.importOnce(doc, fileHash);
      } catch (err) {
        if (!(err instanceof UniquenessError)) throw err;
        const raced = await this.repo.findImportByFileHash(fileHash);
        if (raced) {
          throw new CamtError("DUPLICATE_FILE", "Datei wurde bereits importiert.", {
            importId: raced.id,
          });
        }
        if (attempt >= 3) throw err;
      }
    }
  }

  private async importOnce(doc: CamtDocument, fileHash: string): Promise<ImportResult> {
    const importId = randomUUID();
    const keys = bookingKeys(doc.transactions);
    const existing = await this.repo.existingBookingKeys(keys);

    const fresh: { tx: CamtTransaction; key: string }[] = [];
    const duplicates: CamtTransaction[] = [];
    let ignored = doc.ignoredEntries;
    doc.transactions.forEach((tx, i) => {
      const key = keys[i] as string;
      if (existing.has(key)) duplicates.push(tx);
      // Normale Belastungen sind keine Zahlungseingänge; Stornos bleiben sichtbar.
      else if (tx.direction === "DEBIT" && !tx.reversal) ignored++;
      else fresh.push({ tx, key });
    });

    const refs = [
      ...new Set(
        fresh
          .filter(({ tx }) => isMatchCandidate(tx))
          .map(({ tx }) => tx.reference?.value as string),
      ),
    ];
    const items = refs.length ? await this.openItems.findByReferences(refs) : [];
    const byRef = new Map<string, OpenItem[]>();
    for (const item of items)
      byRef.set(item.reference, [...(byRef.get(item.reference) ?? []), item]);

    const claimed = new Set<string>();
    const payments: ImportedPayment[] = fresh.map(({ tx, key }) => {
      const base = { id: randomUUID(), importId, bookingKey: key, transaction: tx };
      const outcome = matchOne(tx, byRef, claimed);
      if ("item" in outcome) {
        claimed.add(outcome.item.id);
        return { ...base, status: "MATCHED", openItemId: outcome.item.id };
      }
      return {
        ...base,
        status: "REST",
        restReason: outcome.reason,
        openItemId: outcome.suggestion,
      };
    });

    const matched = payments.filter((p) => p.status === "MATCHED");
    const rest = payments.filter((p) => p.status === "REST");
    const counts: ImportCounts = {
      total: doc.transactions.length,
      matched: matched.length,
      rest: rest.length,
      duplicates: duplicates.length,
      ignored,
    };
    const record: ImportRecord = {
      id: importId,
      fileHash,
      kind: doc.kind,
      version: doc.version,
      messageId: doc.messageId,
      importedAt: new Date().toISOString(),
      counts,
    };
    const saved = await this.repo.saveImport(record, payments, this.bookMatched());
    return {
      import: saved.record,
      matched: saved.payments.filter((p) => p.status === "MATCHED"),
      rest: saved.payments.filter((p) => p.status === "REST"),
      duplicates,
    };
  }

  /** Bucht jede automatisch zugeordnete Zahlung in der Transaktion des Imports; Abgelehntes wird Restposten. */
  private bookMatched(): BookMatched | undefined {
    const booker = this.booker;
    if (!booker) return undefined;
    return async (p, tx) => {
      const t = p.transaction;
      const outcome = await booker.assign(
        p.openItemId as string,
        {
          paymentId: p.id,
          amountRappen: t.amountRappen,
          currency: t.currency,
          bookingDate: t.bookingDate,
        },
        tx,
        // Der offene Betrag kann sich seit der Abfrage geändert haben: nur der erwartete Betrag wird gebucht.
        { expectOpenRappen: t.amountRappen },
      );
      return outcome === "ASSIGNED" ? undefined : BOOKING_FAILURE[outcome];
    };
  }
}

const BOOKING_FAILURE = {
  NOT_FOUND: "NO_OPEN_ITEM",
  NOT_OPEN: "OPEN_ITEM_ALREADY_PAID",
  CURRENCY_MISMATCH: "AMOUNT_MISMATCH",
  AMOUNT_CHANGED: "AMOUNT_MISMATCH",
  REJECTED: "BOOKING_REJECTED",
} as const satisfies Record<
  Exclude<Awaited<ReturnType<ManualAssignPort["assign"]>>, "ASSIGNED">,
  RestReason
>;

/** Nur echte Gutschriften mit gültiger Referenz werden automatisch geprüft. */
function isMatchCandidate(tx: CamtTransaction): boolean {
  return tx.direction === "CREDIT" && !tx.reversal && tx.reference?.valid === true;
}

type Outcome = { item: OpenItem } | { reason: RestReason; suggestion?: string };

function matchOne(
  tx: CamtTransaction,
  byRef: Map<string, OpenItem[]>,
  claimed: Set<string>,
): Outcome {
  if (tx.reversal) return { reason: "REVERSAL" };
  if (!tx.reference) return { reason: "NO_REFERENCE" };
  if (!tx.reference.valid) return { reason: "INVALID_REFERENCE" };
  const candidates = byRef.get(tx.reference.value) ?? [];
  if (candidates.length === 0) return { reason: "NO_OPEN_ITEM" };
  if (candidates.length > 1) return { reason: "AMBIGUOUS_OPEN_ITEM" };
  const item = candidates[0] as OpenItem;
  if (claimed.has(item.id)) return { reason: "OPEN_ITEM_ALREADY_PAID", suggestion: item.id };
  // Nur exakte Übereinstimmung wird automatisch gebucht; Teil- und Überzahlungen prüft ein Mensch.
  if (item.amountRappen !== tx.amountRappen || item.currency !== tx.currency) {
    return { reason: "AMOUNT_MISMATCH", suggestion: item.id };
  }
  return { item };
}
