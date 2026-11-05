import { CamtError } from "./types.js";
import type { CamtRepository, ImportedPayment, RestPage } from "./repository.js";

/**
 * Anbindung an das Rechnungsmodul (#7): bucht eine Zahlung auf einen offenen Posten des Kunden.
 * Die Implementierung ist an den Kunden der Anfrage gebunden und prüft selbst, ob der Posten
 * zu diesem Kunden gehört und noch offen ist. Der Betrag darf abweichen: die manuelle Zuordnung ist gerade für
 * Teil- und Überzahlungen da, über deren Folgen entscheidet das Rechnungsmodul. Die Währung muss passen.
 */
export interface ManualAssignPort {
  /**
   * `tx` ist die offene Transaktion des CAMT-Repositories: die Buchung läuft darauf und wird mit der Zuordnung
   * bestätigt oder verworfen. `expectOpenRappen` (automatische Zuordnung): nur buchen, wenn genau dieser Betrag
   * offen ist. Bei einem anderen Ergebnis als "ASSIGNED" darf der Aufrufer nichts davon übernehmen.
   */
  assign(
    openItemId: string,
    payment: { paymentId: string; amountRappen: number; currency: string; bookingDate: string },
    tx: unknown,
    options?: { expectOpenRappen?: number },
  ): Promise<
    "ASSIGNED" | "NOT_FOUND" | "NOT_OPEN" | "CURRENCY_MISMATCH" | "AMOUNT_CHANGED" | "REJECTED"
  >;
}

export class CamtRestService {
  constructor(
    private readonly repo: CamtRepository,
    private readonly assigner: ManualAssignPort,
  ) {}

  list(page: { limit: number; after?: string }): Promise<RestPage> {
    return this.repo.listRestPayments(page);
  }

  /** Ordnet einen Restposten einem offenen Posten zu. Wirft `CamtError`, wenn das nicht möglich ist. */
  async assign(paymentId: string, openItemId: string): Promise<void> {
    const result = await this.repo.assignRest({ paymentId, openItemId }, (p, tx) =>
      this.book(p, openItemId, tx),
    );
    if (result === "NOT_FOUND") {
      throw new CamtError("PAYMENT_NOT_FOUND", "Zahlung nicht gefunden.");
    }
    if (result === "NOT_REST") {
      throw new CamtError("PAYMENT_NOT_REST", "Zahlung ist kein offener Restposten.");
    }
  }

  private async book(p: ImportedPayment, openItemId: string, tx: unknown): Promise<void> {
    const t = p.transaction;
    // Zuordenbar sind Zahlungseingänge und deren Rückbuchungen (Belastung mit Storno-Kennzeichen); gewöhnliche
    // Belastungen und Stornos von Belastungen sind keine Zahlungen auf eine Rechnung.
    const returned = t.direction === "DEBIT" && t.reversal;
    if (!returned && (t.direction !== "CREDIT" || t.reversal)) {
      throw new CamtError("PAYMENT_NOT_ASSIGNABLE", "Diese Buchung kann nicht zugeordnet werden.");
    }
    const outcome = await this.assigner.assign(
      openItemId,
      {
        paymentId: p.id,
        amountRappen: returned ? -t.amountRappen : t.amountRappen,
        currency: t.currency,
        bookingDate: t.bookingDate,
      },
      tx,
    );
    if (outcome === "NOT_FOUND") {
      throw new CamtError("OPEN_ITEM_NOT_FOUND", "Offener Posten nicht gefunden.");
    }
    if (outcome === "NOT_OPEN") {
      throw new CamtError("OPEN_ITEM_NOT_OPEN", "Posten ist nicht mehr offen.");
    }
    if (outcome === "CURRENCY_MISMATCH") {
      throw new CamtError("CURRENCY_MISMATCH", "Währung der Zahlung passt nicht zur Rechnung.");
    }
    if (outcome !== "ASSIGNED") {
      throw new CamtError("BOOKING_REJECTED", "Die Zahlung konnte nicht gebucht werden.");
    }
  }
}
