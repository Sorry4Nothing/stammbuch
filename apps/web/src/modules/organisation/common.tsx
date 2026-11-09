import { useEffect, useState, type DependencyList, type ReactNode } from "react";
import { t } from "../../i18n";
import { Badge, ErrorState, Icon, Message, newErrorId, type IconName, type Tone } from "../../ui";

export type Load<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; errorId: string; at: Date };

/** Lädt Daten beim Einblenden und bei «Erneut laden». Abgebrochene Anfragen ändern nichts mehr. */
export function useLoad<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
): [Load<T>, () => void, (data: T) => void] {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    setState({ status: "loading" });
    load(abort.signal).then(
      (data) => !abort.signal.aborted && setState({ status: "ready", data }),
      () =>
        !abort.signal.aborted &&
        setState({ status: "error", errorId: newErrorId(), at: new Date() }),
    );
    return () => abort.abort();
  }, [...deps, attempt]);

  return [state, () => setAttempt((n) => n + 1), (data) => setState({ status: "ready", data })];
}

/** Fehlerzustand einer Ansicht (Design 2.6) für eine Einstellungsseite. */
export function LoadError({
  state,
  onRetry,
}: {
  state: Extract<Load<unknown>, { status: "error" }>;
  onRetry: () => void;
}) {
  return (
    <>
      <div className="state-page__alert">
        <Message tone="error" title={t("settings.error.title")}>
          {t("settings.error.text")}
        </Message>
      </div>
      <ErrorState
        message={t("settings.error.message")}
        at={state.at}
        errorId={state.errorId}
        onRetry={onRetry}
      />
    </>
  );
}

/** Pflichtfeld: Stern nur sichtbar, `aria-required` am Feld sagt es dem Screenreader. */
export const req = (label: string): ReactNode => (
  <>
    {label} <span aria-hidden="true">*</span>
  </>
);

/** Badge mit Symbol (Board: 12 px) und Text. */
export function IconBadge({
  tone,
  icon,
  children,
}: {
  tone: Tone;
  icon: IconName;
  children: ReactNode;
}) {
  return (
    <Badge tone={tone}>
      <Icon name={icon} size={12} />
      {children}
    </Badge>
  );
}

/** «2026-11-02» wird «02.11.2026». */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

const dateTimeFmt = new Intl.DateTimeFormat("de-CH", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Europe/Zurich",
});

/** ISO-Zeitpunkt als «02.11.2026 14:52» (Zeit Zürich). */
export function formatDateTime(iso: string): string {
  const p = Object.fromEntries(
    dateTimeFmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]),
  );
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}
