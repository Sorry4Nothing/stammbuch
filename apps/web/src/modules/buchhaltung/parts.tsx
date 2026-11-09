import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { t } from "../../i18n";
import { useOnTabActivate } from "../../shell/useOnTabActivate";
import { Button, ErrorState, Icon, Message, newErrorId } from "../../ui";
import { useImports } from "./importStore";
import { useBuchhaltung } from "./service";
import { ApiError, NotAvailableError, type BuchhaltungService, type ImportResult } from "./types";

/** Text für den Nutzer zu einem Fehler. Nie Rohdaten der Antwort, nur feste Sätze (SR-51). */
export function errorText(e: unknown): string {
  if (e instanceof NotAvailableError) return t("bh.err.unavailable");
  if (e instanceof ApiError) {
    if (e.code === "DUPLICATE_FILE") return t("bh.err.duplicate");
    if (e.code === "FILE_TOO_LARGE") return t("bh.err.tooLarge");
    if (
      e.code &&
      ["INVALID_UPLOAD", "INVALID_XML", "UNSUPPORTED_FORMAT", "INVALID_CONTENT"].includes(e.code)
    ) {
      return t("bh.err.invalidFile");
    }
    // Fachfehler tragen einen festen Satz der API; sonst der allgemeine Text.
    if ((e.status === 409 || e.status === 422) && e.code && e.message) return e.message;
  }
  return t("bh.err.generic");
}

/** Lädt Daten beim Einblenden und bei Änderung von `deps`; `reload` lädt erneut. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({
    loading: true,
  });
  const [tick, setTick] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    let alive = true;
    setState((s) => ({ data: s.data, loading: true }));
    loader.current().then(
      (data) => alive && setState({ data, loading: false }),
      (error: unknown) => alive && setState({ error, loading: false }),
    );
    return () => {
      alive = false;
    };
  }, [tick, ...deps]);
  const reload = () => setTick((n) => n + 1);
  useOnTabActivate(reload);
  return { ...state, reload };
}

/** Zeile der Importliste. Die API speichert keinen Dateinamen: ohne Namen aus dieser Sitzung steht die Nachrichtenkennung. */
export interface ImportRow {
  importId: string;
  fileName: string;
  importedAt: number;
  counts: ImportResult["counts"];
}

/** Importe des Mandanten aus der API; Dateinamen der Importe dieser Sitzung ergänzen sie. */
export function useImportRows(service: BuchhaltungService): readonly ImportRow[] {
  const session = useImports();
  const { data } = useLoad(() => service.listImports(), [service, session.length]);
  return useMemo(() => {
    if (!data) return session;
    const names = new Map(session.map((s) => [s.importId, s.fileName]));
    return data.map((i) => ({
      importId: i.importId,
      fileName: names.get(i.importId) ?? i.messageId,
      importedAt: i.importedAt,
      counts: i.counts,
    }));
  }, [data, session]);
}

/** Fehlerzustand einer Ansicht (Design 2.6). */
export function LoadError({
  error,
  what,
  onRetry,
}: {
  error: unknown;
  what: string;
  onRetry: () => void;
}) {
  const [shown] = useState(() => ({ at: new Date(), id: newErrorId() }));
  return (
    <>
      <div className="state-page__alert">
        <Message tone="error" title={t("error.view.alertTitle", { title: what })}>
          {t("error.view.alertText")}
        </Message>
      </div>
      <ErrorState
        message={
          error instanceof ApiError ? `${t("bh.err.load")} (${error.status})` : t("bh.err.load")
        }
        at={shown.at}
        errorId={shown.id}
        onRetry={onRetry}
      />
    </>
  );
}

/** Suchfeld der Werkzeugleiste: Symbol und Platzhalter wie im Design, Beschriftung für Screenreader. */
export function SearchBox({
  placeholder,
  value,
  onChange,
}: {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="in bh-search">
      <Icon name="search" />
      <input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** Auswahlfeld der Werkzeugleiste. Die sichtbare Beschriftung steht in den Optionen («Klasse: Alle»). */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <span className="sel bh-filter">
      <select
        className="in"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
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

/** «14 von 74» rechts in der Werkzeugleiste. */
export function Summary({ shown, total }: { shown: number; total: number | string }) {
  return (
    <span className="bh-sub" aria-live="polite">
      {t("bh.common.of", { n: shown, total })}
    </span>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="bh-tool">{children}</div>;
}

/** Seitenwechsel unter der Tabelle. */
export function Pager({
  text,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: {
  text: string;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="bh-pg">
      <Button
        variant="ghost"
        small
        icon="chevronLeft"
        aria-label={t("bh.common.prev")}
        disabled={!hasPrev}
        onClick={onPrev}
      />
      <span>{text}</span>
      <Button
        variant="ghost"
        small
        icon="chevronRight"
        aria-label={t("bh.common.next")}
        disabled={!hasNext}
        onClick={onNext}
      />
    </div>
  );
}

/** Drei Schritte des Zahlungsimports (Design 5.7 bis 5.9). */
export function Steps({ current }: { current: 1 | 2 | 3 }) {
  const steps = [t("bh.import.step1"), t("bh.import.step2"), t("bh.import.step3")];
  return (
    <div className="bh-steps" role="list" aria-label={t("bh.import.steps")}>
      {steps.map((label, i) => {
        const n = i + 1;
        const state = n < current ? "done" : n === current ? "current" : "todo";
        return (
          <span key={label} className="bh-steps__item" role="listitem">
            {i > 0 && <span className="bh-steps__line" aria-hidden="true" />}
            <span className={`opt bh-step bh-step--${state}`}>
              <span className="bh-step__dot" aria-hidden="true">
                {state === "done" ? <Icon name="check" size={14} /> : n}
              </span>
              <span aria-current={state === "current" ? "step" : undefined}>{label}</span>
            </span>
          </span>
        );
      })}
    </div>
  );
}

/** Lesbare Zeile «Beschriftung» + Wert in einem kv-Block. */
export function Kv({ rows }: { rows: readonly [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** Schliessen-Schaltfläche oben rechts im Dialog (Design 5.3). */
export function DialogClose({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      icon="close"
      className="bh-dlg-x"
      aria-label={t("bh.common.dialogClose")}
      onClick={onClick}
    />
  );
}

/** Zeile in der Tabelle wählen: Schaltfläche in der ersten Zelle, damit die Auswahl per Tastatur geht. */
export function RowPick({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="bh-pick"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Rechnungsnummern zu Rechnungs-IDs, einzeln nachgeladen (die CAMT-Antwort nennt nur die ID). */
export function useInvoiceNumbers(
  ids: readonly (string | undefined)[],
): ReadonlyMap<string, string> {
  const service = useBuchhaltung();
  const [numbers, setNumbers] = useState<ReadonlyMap<string, string>>(new Map());
  const asked = useRef(new Set<string>());
  const key = ids.filter(Boolean).join(",");
  useEffect(() => {
    const missing = key.split(",").filter((id) => id && !asked.current.has(id));
    missing.forEach((id) => asked.current.add(id));
    void Promise.all(
      missing.map(
        async (id) => [id, (await service.getInvoice(id).catch(() => null))?.number] as const,
      ),
    ).then((found) => {
      setNumbers((prev) => {
        const next = new Map(prev);
        for (const [id, nr] of found) if (nr) next.set(id, nr);
        return next;
      });
    });
  }, [key, service]);
  return numbers;
}
