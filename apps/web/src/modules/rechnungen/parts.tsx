import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { t, type TextKey } from "../../i18n";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  Message,
  newErrorId,
  type Tone,
} from "../../ui";
import { useTabs } from "../../shell/tabs";
import { date, dateTime, type DisplayStatus, type Invoice } from "./model";
import { NotSetUpError, UnavailableError, type HistoryEntry } from "./service";

// --- Laden ----------------------------------------------------------------------------------

export type Loaded<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: unknown; at: Date; errorId: string };

/** Lädt Daten beim Öffnen und bei `reload`. Eine veraltete Antwort wird verworfen. */
export function useLoad<T>(load: () => Promise<T>, key: string) {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const [round, setRound] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let live = true;
    setState((s) => (s.status === "ready" ? s : { status: "loading" }));
    loadRef.current().then(
      (data) => live && setState({ status: "ready", data }),
      (error: unknown) =>
        live && setState({ status: "error", error, at: new Date(), errorId: newErrorId() }),
    );
    return () => {
      live = false;
    };
  }, [key, round]);

  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { state, reload };
}

/** Fehlerzustand einer Ansicht (Design 2.6); fehlt dem Server die Funktion, steht das im Text. */
export function LoadError({
  what,
  state,
  onRetry,
}: {
  what: string;
  state: Extract<Loaded<unknown>, { status: "error" }>;
  onRetry: () => void;
}) {
  if (state.error instanceof NotSetUpError) return <SetupNeeded />;
  const unavailable = state.error instanceof UnavailableError;
  return (
    <>
      <div className="state-page__alert">
        <Message
          tone={unavailable ? "warning" : "error"}
          title={
            unavailable ? t("rechnungen.unavailable.title") : t("rechnungen.error.title", { what })
          }
        >
          {unavailable ? t("rechnungen.unavailable.text") : t("error.view.alertText")}
        </Message>
      </div>
      {!unavailable && (
        <ErrorState
          message={
            state.error instanceof Error && state.error.message ? state.error.message : undefined
          }
          at={state.at}
          errorId={state.errorId}
          onRetry={onRetry}
        />
      )}
    </>
  );
}

/** Ohne Organisation und Bankverbindung gibt es keine Rechnungseinstellungen: Weg zu den Einstellungen statt Fehlerseite. */
function SetupNeeded() {
  const { openTab } = useTabs();
  return (
    <EmptyState
      title={t("rechnungen.setup.title")}
      actions={
        <Button
          variant="primary"
          icon="gear"
          onClick={() => openTab("settings", { key: "settings" })}
        >
          {t("rechnungen.setup.action")}
        </Button>
      }
    />
  );
}

export function Loading() {
  return (
    <p className="muted rg-pad is-loading" role="status">
      {t("rechnungen.loading")}
    </p>
  );
}

/** Meldung eines fehlgeschlagenen Vorgangs: der Satz des Servers, sonst ein allgemeiner. */
export function errorText(error: unknown): string {
  if (error instanceof UnavailableError) return t("rechnungen.unavailable.text");
  return error instanceof Error && error.message ? error.message : t("rechnungen.error.generic");
}

// --- Anzeige --------------------------------------------------------------------------------

const statusTone: Record<DisplayStatus, Tone> = {
  draft: "neutral",
  open: "warning",
  reminded: "error",
  paid: "ok",
  cancelled: "neutral",
  credited: "neutral",
};

export function statusLabel(status: DisplayStatus): string {
  return t(`rechnungen.status.${status}` as TextKey);
}

export function StatusBadge({ status }: { status: DisplayStatus }) {
  return <Badge tone={statusTone[status]}>{statusLabel(status)}</Badge>;
}

/** Hinweis neben dem Status einer gebuchten Rechnung, deren Mail nicht zugestellt wurde. */
export function UndeliveredBadge() {
  return <Badge tone="error">{t("rechnungen.status.undelivered")}</Badge>;
}

/** «R-2026-0431», ein Entwurf hat noch keine Nummer. */
export function invoiceName(inv: Pick<Invoice, "number">): string {
  return inv.number ?? t("rechnungen.draftName");
}

/** Zeile einer Beschreibungsliste (`dl.kv`). */
export function Kv({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** Auswahlfeld in der Werkzeugleiste, z. B. «Empfänger: Alle». Der gewählte Text zeigt die Beschriftung. */
export function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <span className="sel rg-filter">
      <select
        className="in"
        aria-label={label}
        value={value}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" />
    </span>
  );
}

export function SearchBox({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="in rg-search">
      <Icon name="search" size={18} />
      <input
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function Pager({
  page,
  pages,
  onPage,
  summary,
}: {
  page: number;
  pages: number;
  onPage: (page: number) => void;
  summary: string;
}) {
  return (
    <div className="rg-pager">
      {pages > 1 && (
        <>
          <Button
            variant="ghost"
            small
            icon="chevronLeft"
            aria-label={t("rechnungen.pager.prev")}
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
          />
          <span>{t("rechnungen.pager.page", { page, pages })}</span>
          <Button
            variant="ghost"
            small
            icon="chevronRight"
            aria-label={t("rechnungen.pager.next")}
            disabled={page >= pages}
            onClick={() => onPage(page + 1)}
          />
        </>
      )}
      <span className="rg-pager__spacer" />
      <span>{summary}</span>
    </div>
  );
}

/** Verlauf einer Rechnung (4.4, 4.12). */
export function History({ entries, label }: { entries: readonly HistoryEntry[]; label: string }) {
  return (
    <ol className="rg-hist" aria-label={label}>
      {entries.map((e) => (
        <li key={e.id}>
          <time dateTime={e.at}>{e.dateOnly ? date(e.at) : dateTime(e.at)}</time>
          <span>
            {t(`rechnungen.history.${e.kind}` as TextKey, e.params)}
            {e.actor && <span className="rg-hist__who">{e.actor}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Schritte der Sammelrechnung (4.9 bis 4.11). */
export function Steps({ current }: { current: 1 | 2 | 3 }) {
  const names = [
    t("rechnungen.steps.configure"),
    t("rechnungen.steps.preview"),
    t("rechnungen.steps.confirm"),
  ];
  return (
    <ol className="rg-steps" aria-label={t("rechnungen.steps.label")}>
      {names.map((name, i) => {
        const n = i + 1;
        const done = n < current;
        return (
          <li
            key={name}
            className={done ? "rg-step rg-step--done" : "rg-step"}
            aria-current={n === current ? "step" : "false"}
          >
            <span className="rg-step__no" aria-hidden={done ? undefined : "true"}>
              {done ? <Icon name="check" /> : n}
            </span>
            {done && <span className="visually-hidden">{t("rechnungen.steps.done")}</span>}
            <span>{name}</span>
            {n < 3 && <span className="rg-step__line" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}
