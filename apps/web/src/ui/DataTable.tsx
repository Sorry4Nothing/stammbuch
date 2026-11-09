import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { t } from "../i18n";
import { Checkbox } from "./Field";
import { Icon } from "./Icon";

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Zahlen und Beträge rechtsbündig (gleich breite Ziffern). */
  align?: "left" | "right";
  /** CSS-Breite, z. B. "120px". Ohne Angabe teilt die Spalte den Rest. */
  width?: string;
  sortable?: boolean;
  /** Kopfzelle nur für Screenreader sichtbar (Spalte mit Symbol-Schaltflächen). */
  srOnlyHeader?: boolean;
  /** Kein Zeilenumbruch in der Zelle (Daten, Nummern, Beträge). Rechtsbündige Spalten brechen nie um. */
  nowrap?: boolean;
}

export interface Sort {
  key: string;
  direction: "asc" | "desc";
}

interface DataTableProps<T> {
  /** Zugänglicher Name der Tabelle. */
  label: string;
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  selectable?: boolean;
  selected?: ReadonlySet<string>;
  onSelectedChange?: (selected: Set<string>) => void;
  sort?: Sort;
  onSortChange?: (sort: Sort) => void;
  /** Enter oder Doppelklick auf eine Zeile. */
  onRowActivate?: (row: T) => void;
  /** Klick oder Fokus auf eine Zeile (Liste mit Seitenfenster). Zusammen mit `selected` hebt sie die Zeile hervor. */
  onRowSelect?: (row: T) => void;
  /** Anzeige, wenn keine Zeilen vorhanden sind. */
  empty?: ReactNode;
  /** Kopfzeile nur für Screenreader (kurze Tabellen wie die Kürzel-Übersicht). */
  hideHeader?: boolean;
  /** Summenzeile unter den Zeilen: eine Zelle je Spalte (ohne Auswahlspalte). */
  totalRow?: readonly ReactNode[];
}

/**
 * Tabelle nach Design-Guide 11.4: Zeilenhöhe 32 px, Kopf mit Sortierung, Auswahlspalte.
 * Tastatur (Dialog 2.4, «Listen»): ↑/↓ Zeile wechseln, Enter öffnen, Leertaste wählen, Strg+A alle.
 */
export function DataTable<T>({
  label,
  columns,
  rows,
  rowKey,
  selectable,
  selected,
  onSelectedChange,
  sort,
  onSortChange,
  onRowActivate,
  onRowSelect,
  empty,
  hideHeader,
  totalRow,
}: DataTableProps<T>) {
  const body = useRef<HTMLTableSectionElement>(null);
  const [focusKey, setFocusKey] = useState<string | undefined>();
  const keys = rows.map(rowKey);
  const current = focusKey && keys.includes(focusKey) ? focusKey : keys[0];
  const sel = selected ?? new Set<string>();
  const allOn = keys.length > 0 && keys.every((k) => sel.has(k));
  const someOn = keys.some((k) => sel.has(k));

  const setSel = (next: Set<string>) => onSelectedChange?.(next);
  const toggle = (key: string) => {
    const next = new Set(sel);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSel(next);
  };
  const toggleAll = () => setSel(allOn ? new Set() : new Set(keys));

  const moveTo = (index: number) => {
    const key = keys[Math.max(0, Math.min(keys.length - 1, index))];
    if (key === undefined) return;
    setFocusKey(key);
    Array.from(body.current?.rows ?? [])
      .find((r) => r.dataset.rowKey === key)
      ?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTableRowElement>, row: T, key: string, index: number) => {
    if (e.target !== e.currentTarget) return; // Eingaben in Zellen nicht abfangen
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveTo(index + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveTo(index - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      moveTo(0);
    } else if (e.key === "End") {
      e.preventDefault();
      moveTo(keys.length - 1);
    } else if (e.key === "Enter" && onRowActivate) {
      e.preventDefault();
      onRowActivate(row);
    } else if (e.key === " " && selectable) {
      e.preventDefault();
      toggle(key);
    } else if ((e.key === "a" || e.key === "A") && (e.ctrlKey || e.metaKey) && selectable) {
      e.preventDefault();
      toggleAll();
    }
  };

  const sortDir = (c: Column<T>) => (sort?.key === c.key ? sort.direction : undefined);
  const cellClass = (c: Column<T>) =>
    [c.align === "right" && "r", c.nowrap && "nw"].filter(Boolean).join(" ") || undefined;

  return (
    <table className={hideHeader ? "tbl tbl--nohead" : "tbl"} aria-label={label}>
      <colgroup>
        {selectable && <col style={{ width: "40px" }} />}
        {columns.map((c) => (
          <col key={c.key} style={c.width ? { width: c.width } : undefined} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {selectable && (
            <th scope="col" className="tbl__check">
              <Checkbox
                label=""
                aria-label={t("ui.table.selectAll")}
                checked={allOn}
                ref={(el) => {
                  if (el) el.indeterminate = !allOn && someOn;
                }}
                onChange={toggleAll}
              />
            </th>
          )}
          {columns.map((c) => {
            const dir = sortDir(c);
            const mark = dir && (
              <span className="so">
                <Icon name={dir === "asc" ? "chevronUp" : "chevronDown"} size={12} />
              </span>
            );
            return (
              <th
                key={c.key}
                scope="col"
                className={c.align === "right" ? "r" : undefined}
                aria-sort={dir ? (dir === "asc" ? "ascending" : "descending") : undefined}
              >
                {c.sortable && onSortChange ? (
                  <button
                    type="button"
                    className="tbl__sort"
                    onClick={() =>
                      onSortChange({
                        key: c.key,
                        direction: dir === "asc" ? "desc" : "asc",
                      })
                    }
                  >
                    {c.header}
                    {mark}
                  </button>
                ) : c.srOnlyHeader ? (
                  <span className="visually-hidden">{c.header}</span>
                ) : (
                  <>
                    {c.header}
                    {mark}
                  </>
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody ref={body}>
        {rows.length === 0 && empty !== undefined && (
          <tr>
            <td colSpan={columns.length + (selectable ? 1 : 0)} className="tbl__empty">
              {empty}
            </td>
          </tr>
        )}
        {rows.map((row, index) => {
          const key = keys[index]!;
          const on = sel.has(key);
          return (
            <tr
              key={key}
              data-row-key={key}
              className={on ? "is-selected" : undefined}
              tabIndex={key === current ? 0 : -1}
              onFocus={(e) => {
                if (e.target !== e.currentTarget) return;
                setFocusKey(key);
                onRowSelect?.(row);
              }}
              onClick={() => onRowSelect?.(row)}
              onKeyDown={(e) => onKeyDown(e, row, key, index)}
              onDoubleClick={() => onRowActivate?.(row)}
            >
              {selectable && (
                <td className="tbl__check">
                  <Checkbox
                    label=""
                    aria-label={t("ui.table.selectRow")}
                    checked={on}
                    onChange={() => toggle(key)}
                  />
                </td>
              )}
              {columns.map((c) => (
                <td key={c.key} className={cellClass(c)}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
      {totalRow && (
        <tfoot>
          <tr className="tot">
            {selectable && <td className="tbl__check" />}
            {columns.map((c, i) => (
              <td key={c.key} className={cellClass(c)}>
                {totalRow[i]}
              </td>
            ))}
          </tr>
        </tfoot>
      )}
    </table>
  );
}
