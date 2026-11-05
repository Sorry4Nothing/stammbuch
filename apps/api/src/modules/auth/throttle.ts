import type { ThrottleState } from "./types.js";

/**
 * Sperre nach Fehlversuchen (SR-04) mit exponentiellem Backoff:
 * ab 5 Fehlversuchen 1 min, danach verdoppelt sich die Sperre bis höchstens 1 h.
 * Der Zähler gilt pro Konto-Schlüssel (auch für unbekannte E-Mails, damit die Antwort
 * nichts über die Existenz verrät, SR-05) und verfällt nach 24 h ohne Fehlversuch.
 * Zurückgesetzt wird er nur nach vollständiger Anmeldung (Passwort UND zweiter Faktor),
 * sonst könnte ein Angreifer mit bekanntem Passwort den TOTP-Zähler beliebig oft löschen.
 */
export const LOCK_THRESHOLD = 5;
export const LOCK_BASE_MS = 60_000;
export const LOCK_MAX_MS = 3_600_000;
export const FAILURE_DECAY_MS = 24 * 3_600_000;

export function nextFailureState(prev: ThrottleState | null, now: Date): ThrottleState {
  const fresh = prev && now.getTime() - prev.lastFailureAt.getTime() < FAILURE_DECAY_MS;
  const failures = (fresh ? prev.failures : 0) + 1;
  const lockMs =
    failures >= LOCK_THRESHOLD
      ? Math.min(LOCK_BASE_MS * 2 ** (failures - LOCK_THRESHOLD), LOCK_MAX_MS)
      : 0;
  return {
    failures,
    lastFailureAt: now,
    lockedUntil: lockMs > 0 ? new Date(now.getTime() + lockMs) : null,
  };
}

/** Restsekunden der Sperre, sonst 0. */
export function lockedForSeconds(state: ThrottleState | null, now: Date): number {
  if (!state?.lockedUntil) return 0;
  const ms = state.lockedUntil.getTime() - now.getTime();
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}
