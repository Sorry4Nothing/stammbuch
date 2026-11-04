import { setTimeout as sleep } from "node:timers/promises";

export interface LoopOptions {
  /** Pause zwischen zwei Durchläufen. */
  intervalMs: number;
  /** Ein Durchlauf. Hier hängen später Jobs (Mailversand, CAMT-Import, Mahnlauf, ...). */
  tick: (signal: AbortSignal) => Promise<void>;
  onError: (err: unknown) => void;
}

/**
 * Platzhalter-Schleife mit Graceful Shutdown: läuft, bis `signal` abgebrochen wird,
 * und kehrt erst zurück, wenn der laufende Durchlauf beendet ist.
 * Ein Fehler in einem Durchlauf beendet den Worker nicht, er wird gemeldet und der
 * nächste Durchlauf startet regulär.
 */
export async function runLoop(signal: AbortSignal, { intervalMs, tick, onError }: LoopOptions) {
  while (!signal.aborted) {
    try {
      await tick(signal);
    } catch (err) {
      onError(err);
    }
    // Abbruch während der Pause weckt die Schleife sofort auf.
    await sleep(intervalMs, undefined, { signal }).catch(() => undefined);
  }
}
