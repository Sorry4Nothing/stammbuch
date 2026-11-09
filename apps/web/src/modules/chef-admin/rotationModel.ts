import { createContext } from "react";

/** Arten von Geheimnissen, die der Chef-Admin rotiert (Design 10.7). */
export const ROTATION_KINDS = ["mail", "totp"] as const;
export type RotationKind = (typeof ROTATION_KINDS)[number];

/** Stand einer Art. `unreadable` sind Kennnummern (IDs), nie Schlüssel, Klartext oder Kundendaten. */
export interface RotationKindStatus {
  /** `false`: der Betreiber hat für diese Art keinen Schlüsselring eingerichtet. */
  configured: boolean;
  /** ISO-Zeitstempel des letzten abgeschlossenen Laufs oder `null` (noch kein Lauf). */
  lastRunAt: string | null;
  unreadable: string[];
}
export type RotationStatus = Record<RotationKind, RotationKindStatus>;

/** Ergebnis eines Laufs für eine Art. `failed` sind Kennnummern unlesbarer Objekte. */
export interface RotationOutcome {
  rotated: number;
  failed: string[];
  aborted: boolean;
}
/** `null`: die Art ist nicht eingerichtet und wurde nicht gestartet. */
export type RotationRun = Record<RotationKind, RotationOutcome | null>;

/** Die Route erlaubt höchstens 3 Läufe pro Minute (429). `retryAfterSeconds`: Wartezeit laut API. */
export class RotationLimitError extends Error {
  constructor(readonly retryAfterSeconds: number | null) {
    super("Rotationslimit erreicht");
  }
}

/** Zu viele falsche Einmalcodes: die API sperrt vorübergehend (423). */
export class RotationLockedError extends Error {
  constructor() {
    super("Einmalcode gesperrt");
  }
}

/**
 * Datenquelle der Schlüsselrotation. Die Umsetzung gegen die API steht in `httpRotationService.ts`,
 * für Tests und Entwicklung gibt es `memoryRotationService.ts`.
 */
export interface RotationService {
  status(signal?: AbortSignal): Promise<RotationStatus>;
  /**
   * Startet die Rotation aller eingerichteten Arten und wartet auf das Ende. `code` ist ein frischer Einmalcode des
   * Chef-Admins (Step-up). Wirft `CodeRejectedError` (Code falsch oder schon benutzt), `RotationLockedError`,
   * `RotationLimitError` oder `ApiError`.
   */
  run(code: string): Promise<RotationRun>;
}

export const RotationServiceContext = createContext<RotationService | null>(null);
