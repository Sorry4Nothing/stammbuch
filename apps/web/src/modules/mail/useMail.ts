import { useCallback, useEffect, useRef, useState } from "react";
import { t, type TextKey } from "../../i18n";
import { newErrorId } from "../../ui";
import { useMailService } from "./mailContext";
import { MailServiceError, type MailAccount } from "./mailService";

export type Load<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; errorId: string; at: Date; error: unknown };

/**
 * Lädt Daten beim Einhängen und bei jeder Änderung von `deps`. Ältere Antworten werden verworfen.
 * `reload` lädt erneut, `set` ersetzt die Daten nach einer lokalen Änderung.
 */
export function useLoad<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): [Load<T>, () => void, (data: T) => void] {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const refreshing = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    // Ein erneutes Laden behält die alten Daten, bis die neuen da sind (kein Flackern der Tabelle).
    if (!refreshing.current) setState({ status: "loading" });
    refreshing.current = false;
    load(abort.signal).then(
      (data) => !abort.signal.aborted && setState({ status: "ready", data }),
      (error: unknown) =>
        !abort.signal.aborted &&
        setState({ status: "error", errorId: newErrorId(), at: new Date(), error }),
    );
    return () => abort.abort();
    // `load` ist je Render neu; massgebend sind die genannten Abhängigkeiten.
  }, [...deps, attempt]);

  const reload = useCallback(() => {
    refreshing.current = true;
    setAttempt((n) => n + 1);
  }, []);
  const set = useCallback((data: T) => setState({ status: "ready", data }), []);
  return [state, reload, set];
}

/** Das erste Mail-Konto des Benutzers; `null`, wenn keines eingerichtet ist. */
export function useAccount(): [Load<MailAccount | null>, () => void] {
  const service = useMailService();
  const [load, reload] = useLoad(
    async (signal) => (await service.accounts(signal))[0] ?? null,
    [service],
  );
  return [load, reload];
}

/** Kurzer Text zu einem Fehler des Mail-Dienstes, nie der Text der Antwort. */
export function errorText(error: unknown): string {
  const kind = error instanceof MailServiceError ? error.kind : "unavailable";
  return t(`mail.error.${kind}` as TextKey);
}
