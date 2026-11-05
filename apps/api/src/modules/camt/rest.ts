import { CamtError } from "./types.js";
import type { CamtRepository, ImportedPayment, RestPage } from "./repository.js";

/**
 * Anbindung an das Rechnungsmodul (#7): bucht eine Zahlung auf einen offenen Posten des Kunden.
 * Die Implementierung ist an den Kunden der Anfrage gebunden und prüft selbst, ob der Posten
 * zu diesem Kunden gehört und noch offen ist. Betrag und Währung dürfen abweichen: die manuelle
 * Zuordnung ist gerade für Teil- und Überzahlungen da, über deren Folgen entscheidet das Rechnungsmodul.
 */
export interface ManualAssignPort {
  assign(
    openItemId: string,
    payment: { paymentId: string; amountRappen: number; currency: string; bookingDate: string },
  ): Promise<"ASSIGNED" | "NOT_FOUND" | "NOT_OPEN">;
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
    const result = await this.repo.assignRest({ paymentId, openItemId }, (p) =>
      this.book(p, openItemId),
    );
    if (result === "NOT_FOUND") {
      throw new CamtError("PAYMENT_NOT_FOUND", "Zahlung nicht gefunden.");
    }
    if (result === "NOT_REST") {
      throw new CamtError("PAYMENT_NOT_REST", "Zahlung ist kein offener Restposten.");
    }
  }

  private async book(p: ImportedPayment, openItemId: string): Promise<void> {
    const t = p.transaction;
    // Rückbuchungen und Belastungen sind keine Zahlungen auf eine Rechnung.
    if (t.direction !== "CREDIT" || t.reversal) {
      throw new CamtError("PAYMENT_NOT_ASSIGNABLE", "Diese Buchung kann nicht zugeordnet werden.");
    }
    const outcome = await this.assigner.assign(openItemId, {
      paymentId: p.id,
      amountRappen: t.amountRappen,
      currency: t.currency,
      bookingDate: t.bookingDate,
    });
    if (outcome === "NOT_FOUND") {
      throw new CamtError("OPEN_ITEM_NOT_FOUND", "Offener Posten nicht gefunden.");
    }
    if (outcome === "NOT_OPEN") {
      throw new CamtError("OPEN_ITEM_NOT_OPEN", "Posten ist nicht mehr offen.");
    }
  }
}
