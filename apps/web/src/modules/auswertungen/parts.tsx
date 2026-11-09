import { Fragment, useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import { useAuth } from "../../auth/auth";
import { t } from "../../i18n";
import { useCurrentTab } from "../../shell/tabs";
import { Button, ErrorState, Icon, Message, newErrorId, useToast, type Sort } from "../../ui";
import { isoDate } from "./format";
import type { ExportFile } from "./types";
import "./auswertungen.css";

/** Zeilen je Seite der Listen (Boards 6.1 und 6.2: «12 von 74», «Seite 1 von 7»). */
export const PAGE_SIZE = 12;

/** Heutiges Datum (ISO), minütlich aus der Sitzung. */
export function useToday(): string {
  return isoDate(useAuth().now);
}

export interface Loaded<T> {
  data?: T;
  error?: unknown;
  loading: boolean;
  reload: () => void;
}

/** Lädt Daten beim Öffnen und bei jeder Änderung von `deps`; ein veraltetes Ergebnis wird verworfen. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({
    loading: true,
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, error: undefined, loading: true }));
    load().then(
      (data) => live && setState({ data, loading: false }),
      (error: unknown) => live && setState({ error, loading: false }),
    );
    return () => {
      live = false;
    };
  }, [...deps, attempt]);
  return { ...state, reload: () => setAttempt((n) => n + 1) };
}

/** Zeigt den Fehlerzustand (Design 2.6) bzw. den Ladehinweis, sonst den Inhalt. */
export function LoadState<T>({
  load,
  children,
}: {
  load: Loaded<T>;
  children: (data: T) => ReactNode;
}) {
  if (load.error !== undefined) return <LoadError onRetry={load.reload} />;
  if (load.data === undefined) {
    return (
      <p className="rep__banner muted is-loading" role="status">
        {t("reports.loading")}
      </p>
    );
  }
  return <>{children(load.data)}</>;
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  const [info] = useState(() => ({ at: new Date(), id: newErrorId() }));
  return (
    <>
      <div className="state-page__alert">
        <Message tone="error" title={t("reports.loadFailed")}>
          {t("error.view.alertText")}
        </Message>
      </div>
      <ErrorState at={info.at} errorId={info.id} onRetry={onRetry} />
    </>
  );
}

/** Speichert eine Datei über einen Download des Browsers. */
export function saveFile(file: ExportFile): void {
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

interface ReportHeaderProps {
  title: string;
  status?: ReactNode;
  /** Erzeugt die Dateien für «Als Excel-Datei exportieren» und «Als PDF speichern». */
  onExport: (format: "xlsx" | "pdf") => Promise<ExportFile[]>;
}

/** Kopf einer Auswertung: Brotkrumen, Titel, Drucken, PDF und Export (Boards 6.1 bis 6.5). */
export function ReportHeader({ title, status, onExport }: ReportHeaderProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (format: "xlsx" | "pdf") => {
    setBusy(true);
    try {
      for (const file of await onExport(format)) saveFile(file);
    } catch {
      toast.show({ tone: "error", title: t("reports.exportFailed") });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="crumb">{`${t("reports.crumb")} / ${title}`}</div>
      <div className="phead">
        <h1>{title}</h1>
        <span className="phead__spacer" />
        <div className="rep-actions">
          <Button icon="print" onClick={() => window.print()}>
            {t("reports.action.print")}
          </Button>
          <Button icon="download" disabled={busy} onClick={() => void run("pdf")}>
            {t("reports.action.pdf")}
          </Button>
          <Button variant="primary" icon="table" disabled={busy} onClick={() => void run("xlsx")}>
            {t("reports.action.xlsx")}
          </Button>
        </div>
      </div>
      {status && <div className="rep-badges">{status}</div>}
    </>
  );
}

// ---- Werkzeugleiste ------------------------------------------------------------------------

export function Tool({ children }: { children: ReactNode }) {
  return <div className="rep-tool">{children}</div>;
}

export const ToolSpacer = () => <span className="rep-tool__spacer" />;

export function ToolSearch({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="in rep-tool__search">
      <Icon name="search" />
      <input
        type="search"
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function ToolSelect({
  label,
  value,
  options,
  onChange,
}: {
  /** Zugänglicher Name; sichtbar ist der gewählte Eintrag («Altersklasse: Alle»). */
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <span className="rep-tool__sel">
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

export function ToolDate({
  prefix,
  label,
  value,
  onChange,
}: {
  prefix: string;
  label: string;
  value: string;
  onChange: (iso: string) => void;
}) {
  return (
    <label className="in rep-tool__date">
      <span>{prefix}</span>
      <input
        type="date"
        aria-label={label}
        value={value}
        onChange={(e) => e.target.value && onChange(e.target.value)}
      />
    </label>
  );
}

/** «12 von 74 · sortiert nach Fälligkeit, aufsteigend» */
export function Counter({ text, sorted }: { text: string; sorted?: string }) {
  return (
    <>
      <span className="rep__sub" aria-live="polite">
        {text}
      </span>
      {sorted && <span className="rep__sub">{sorted}</span>}
    </>
  );
}

// ---- Tabelle -------------------------------------------------------------------------------

export interface ReportColumn<T> {
  key: string;
  header: string;
  align?: "right";
  /** CSS-Breite; ohne Angabe teilt die Spalte den Rest. */
  width?: string;
  sortable?: boolean;
  /** Text darf umbrechen; sonst eine Zeile mit Auslassung (Nr., Datum, Betrag brechen nie). */
  wrap?: boolean;
  cell: (row: T) => ReactNode;
}

interface ReportTableProps<T> {
  label: string;
  columns: readonly ReportColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Klasse der Zeile: `tot` für Summenzeilen, `is-selected` für die gewählte Zeile. */
  rowClass?: (row: T) => "tot" | "is-selected" | undefined;
  sort?: Sort;
  onSort?: (sort: Sort) => void;
  empty?: string;
  /** Mindestbreite der Tabelle, damit flexible Spalten nicht auf null schrumpfen. */
  minWidth?: string;
  /** Zusatzzeile unter einer Zeile, über die ganze Breite. */
  after?: (row: T) => ReactNode;
}

/** Tabelle der Auswertungen (Board `.tbl`): Kopf mit `scope`, Summenzeilen, sortierbare Spalten. */
export function ReportTable<T>({
  label,
  columns,
  rows,
  rowKey,
  rowClass,
  sort,
  onSort,
  empty,
  minWidth,
  after,
}: ReportTableProps<T>) {
  return (
    <table className="tbl" aria-label={label} style={minWidth ? { minWidth } : undefined}>
      <colgroup>
        {columns.map((c) => (
          <col key={c.key} style={c.width ? { width: c.width } : undefined} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {columns.map((c) => {
            const dir = sort?.key === c.key ? sort.direction : undefined;
            return (
              <th
                key={c.key}
                scope="col"
                className={c.align === "right" ? "r" : undefined}
                aria-sort={dir ? (dir === "asc" ? "ascending" : "descending") : undefined}
              >
                {c.sortable && onSort ? (
                  <button
                    type="button"
                    className="tbl__sort"
                    onClick={() =>
                      onSort({ key: c.key, direction: dir === "asc" ? "desc" : "asc" })
                    }
                  >
                    {c.header}
                    {dir && <Icon name={dir === "asc" ? "chevronUp" : "chevronDown"} size={12} />}
                  </button>
                ) : (
                  c.header
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && empty && (
          <tr>
            <td colSpan={columns.length} className="tbl__empty">
              {empty}
            </td>
          </tr>
        )}
        {rows.map((row) => {
          const extra = after?.(row);
          return (
            <Fragment key={rowKey(row)}>
              <tr className={rowClass?.(row)}>
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={
                      [c.align === "right" && "r", c.wrap ? "wrap" : "nw"]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
              {extra && (
                <tr>
                  <td colSpan={columns.length} className="rep-extra">
                    {extra}
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

// ---- Blättern ------------------------------------------------------------------------------

/** Seitenzähler einer Liste; meldet «Seite x von y» auch an die Fusszeile der Shell. */
export function usePaging(total: number) {
  const tab = useCurrentTab();
  const [requested, setRequested] = useState(1);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requested, pages);
  useEffect(() => tab.setPage(page, pages), [tab, page, pages]);
  return {
    page,
    pages,
    setPage: setRequested,
    slice: <T,>(rows: readonly T[]) => rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
  };
}

export function Pager({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (page: number) => void;
}) {
  // Eine einzige Seite braucht kein Blättern.
  if (pages <= 1) return null;
  return (
    <div className="rep-pager">
      <Button
        variant="ghost"
        small
        icon="chevronLeft"
        aria-label={t("reports.pager.prev")}
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      />
      <span>{t("reports.pager.page", { current: page, total: pages })}</span>
      <Button
        variant="ghost"
        small
        icon="chevronRight"
        aria-label={t("reports.pager.next")}
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
      />
      <span className="rep-pager__spacer" />
      <span />
    </div>
  );
}
