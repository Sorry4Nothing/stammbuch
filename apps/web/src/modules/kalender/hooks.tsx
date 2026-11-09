import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { ErrorState, Message, newErrorId } from "../../ui";
import { CalendarApiError, type CalEvent, type Participants } from "./calendarService";
import { useCalendar } from "./CalendarContext";

// ---------- Änderungen zwischen Tabs ----------

const listeners = new Set<() => void>();

/** Meldet, dass ein Event gespeichert wurde: offene Kalender- und Listenansichten laden neu. */
export const notifyCalendarChanged = () => listeners.forEach((l) => l());

export function useCalendarChanged(onChange: () => void): void {
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => {
    const l = () => ref.current();
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
}

// ---------- Laden ----------

export const statusOf = (e: unknown): number => (e instanceof CalendarApiError ? e.status : 0);

/** Fehlerzustand einer Ansicht (Design 2.6) mit «Erneut laden». */
export function LoadError({ onRetry }: { status: number; onRetry: () => void }) {
  const [info] = useState(() => ({ id: newErrorId(), at: new Date() }));
  return (
    <>
      <div className="state-page__alert">
        <Message tone="error" title={t("kalender.error.alert")}>
          {t("error.view.alertText")}
        </Message>
      </div>
      <ErrorState at={info.at} errorId={info.id} onRetry={onRetry} />
    </>
  );
}

export type Loaded<T> =
  { state: "loading" } | { state: "error"; status: number } | { state: "ready"; value: T };

/** Lädt einen Event; `reload` holt ihn neu (z. B. nach dem Speichern). */
export function useEvent(id: string | undefined) {
  const { service } = useCalendar();
  const [result, setResult] = useState<Loaded<CalEvent>>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!id) return;
    let active = true;
    setResult({ state: "loading" });
    service.getEvent(id).then(
      (value) => active && setResult({ state: "ready", value }),
      (e: unknown) => active && setResult({ state: "error", status: statusOf(e) }),
    );
    return () => {
      active = false;
    };
  }, [id, service, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { result, reload };
}

/** Zeit zwischen zwei Abrufen der Teilnehmerliste («Live»). */
export const POLL_MS = 30_000;

/**
 * Teilnehmer eines Events. Mit `live` wird alle `POLL_MS` neu abgefragt; `at` ist der Zeitpunkt
 * des letzten erfolgreichen Abrufs (Millisekunden). Ein Fehler beim Nachladen behält den letzten Stand.
 */
export function useParticipants(id: string | undefined, live: boolean) {
  const { service } = useCalendar();
  const [result, setResult] = useState<Loaded<Participants>>({ state: "loading" });
  const [at, setAt] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!id) return;
    let active = true;
    const load = () =>
      service.participants(id).then(
        (value) => {
          if (!active) return;
          setResult({ state: "ready", value });
          setAt(Date.now());
        },
        (e: unknown) => {
          if (active)
            setResult((r) => (r.state === "ready" ? r : { state: "error", status: statusOf(e) }));
        },
      );
    void load();
    const timer = live ? setInterval(() => void load(), POLL_MS) : undefined;
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [id, service, live, attempt]);

  const reload = useCallback(() => {
    setResult({ state: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return { result, at, reload };
}
