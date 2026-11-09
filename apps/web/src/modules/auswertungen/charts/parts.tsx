import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { t } from "../../../i18n";
import { Button, Panel } from "../../../ui";
import "./charts.css";

/** Serien sind über Farbe, Muster und Beschriftung unterscheidbar (nie nur über Farbe). */
export const SERIES_COUNT = 6;

const MARKS: ReactNode[] = [
  null,
  <path key="d" d="M0 6L6 0" />,
  <circle key="o" cx="3" cy="3" r="1.1" className="chart__dot" />,
  <path key="h" d="M0 3H6" />,
  <path key="x" d="M0 3H6M3 0V6" />,
  <path key="v" d="M3 0V6" />,
];

/** Eindeutige Kennung für Muster-IDs einer Grafik. */
export function useChartId(): string {
  return `c${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
}

/** Füllung der Serie `i` für ein SVG-Element: Serie 0 voll, die übrigen mit Muster. */
export const seriesFill = (id: string, i: number, className = "") =>
  i === 0
    ? { className: `${className} chart-fill-0`.trim() }
    : { className: className || undefined, fill: `url(#${id}-p${i})` };

/** Musterdefinitionen der Serien; Serie 0 bleibt voll. */
export function SeriesDefs({ id }: { id: string }) {
  return (
    <defs>
      {MARKS.map((mark, i) =>
        i === 0 ? null : (
          <pattern key={i} id={`${id}-p${i}`} width="6" height="6" patternUnits="userSpaceOnUse">
            <rect width="6" height="6" className={`chart-fill-${i}`} />
            <g className="chart__mark">{mark}</g>
          </pattern>
        ),
      )}
    </defs>
  );
}

export interface TableData {
  caption: string;
  head: string[];
  rows: ReactNode[][];
}

interface CardProps {
  title: string;
  /** Öffnet die Detailseite; ohne Angabe fehlt die Schaltfläche. */
  onOpen?: () => void;
  table: TableData;
  /** Leerer Zustand statt Grafik. */
  empty?: { title: string; text: string };
  children: ReactNode;
  note?: ReactNode;
  className?: string;
}

/**
 * Karte einer Grafik: Titel, Sprung zur Detailseite, Grafik und die gleichen Zahlen als echte Tabelle
 * («Daten als Tabelle anzeigen»). Ohne Daten steht der Leer-Zustand, nie erfundene Werte.
 */
export function ChartCard({ title, onOpen, table, empty, children, note, className }: CardProps) {
  const [shown, setShown] = useState(false);
  const tableId = useChartId();
  return (
    <div className={["chart", className].filter(Boolean).join(" ")}>
      <Panel
        title={title}
        actions={
          onOpen &&
          !empty && (
            <Button
              variant="ghost"
              small
              icon="arrowRight"
              aria-label={t("dash.open.label", { title })}
              onClick={onOpen}
            >
              {t("dash.open")}
            </Button>
          )
        }
      >
        {empty ? (
          <div className="chart__empty">
            <b>{empty.title}</b>
            <span className="muted">{empty.text}</span>
          </div>
        ) : (
          <>
            {children}
            {note && <p className="chart__note muted">{note}</p>}
            <Button
              variant="ghost"
              small
              icon="table"
              aria-expanded={shown}
              aria-controls={tableId}
              onClick={() => setShown((s) => !s)}
            >
              {shown ? t("dash.table.hide") : t("dash.table.show")}
            </Button>
            <div id={tableId}>
              {shown && (
                <table className="tbl chart__table" aria-label={table.caption}>
                  <thead>
                    <tr>
                      {table.head.map((h, i) => (
                        <th key={h} scope="col" className={i > 0 ? "r" : undefined}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, i) =>
                          i === 0 ? (
                            <th key={i} scope="row">
                              {cell}
                            </th>
                          ) : (
                            <td key={i} className="r">
                              {cell}
                            </td>
                          ),
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}

export interface HitItem {
  id: string;
  /** Zugänglicher Name des Messpunkts, z. B. «Januar 2026: Ertrag CHF 100.00, Aufwand CHF 50.00». */
  label: string;
  /** Position und Breite in Prozent der Zeichenfläche. */
  left: number;
  width: number;
  tip: ReactNode;
}

/**
 * Bedienbare Messpunkte über der Grafik: Hover und Tastaturfokus zeigen die Werte als Tooltip,
 * Pfeiltasten wandern durch die Punkte (ein Tabstopp je Grafik), Enter öffnet die Detailseite.
 */
export function PlotHits({ items, onOpen }: { items: HitItem[]; onOpen?: () => void }) {
  const [stop, setStop] = useState(0);
  const [shown, setShown] = useState<number | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const tipId = useChartId();
  const go = (i: number) => refs.current[(i + items.length) % items.length]?.focus();
  const onKey = (e: KeyboardEvent, i: number) => {
    const next: Record<string, number> = {
      ArrowRight: i + 1,
      ArrowLeft: i - 1,
      Home: 0,
      End: items.length - 1,
    };
    if (e.key in next) {
      e.preventDefault();
      go(next[e.key]!);
    }
  };
  const item = shown === null ? undefined : items[shown];
  return (
    <div className="chart__hits" onMouseLeave={() => setShown(null)}>
      {items.map((it, i) => (
        <button
          key={it.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          className="chart__hit"
          style={{ left: `${it.left}%`, width: `${it.width}%` }}
          tabIndex={i === stop ? 0 : -1}
          aria-label={it.label}
          aria-describedby={shown === i ? tipId : undefined}
          onFocus={() => {
            setStop(i);
            setShown(i);
          }}
          onBlur={() => setShown((s) => (s === i ? null : s))}
          onMouseEnter={() => setShown(i)}
          onKeyDown={(e) => onKey(e, i)}
          onClick={onOpen}
        />
      ))}
      {item && (
        <div
          id={tipId}
          role="tooltip"
          className="chart__tip"
          style={{ left: `${Math.min(86, Math.max(14, item.left + item.width / 2))}%` }}
        >
          {item.tip}
        </div>
      )}
    </div>
  );
}

export interface LegendItem {
  id: string;
  label: string;
  /** Wert samt Anteil, z. B. «CHF 100.00 · 45 %». */
  value: string;
}

/** Legende mit Farbe, Muster, Beschriftung und Wert; Fokus und Hover heben den Eintrag in der Grafik hervor. */
export function Legend({
  items,
  active,
  onActive,
  onOpen,
  colors,
}: {
  items: LegendItem[];
  active?: number | null;
  onActive?: (i: number | null) => void;
  onOpen?: () => void;
  /** Serienindex je Eintrag; ohne Angabe die Reihenfolge. */
  colors?: number[];
}) {
  const id = useChartId();
  const interactive = Boolean(onActive || onOpen);
  const swatch = (i: number) => (
    <svg className="chart__swatch" viewBox="0 0 12 12" aria-hidden="true">
      <SeriesDefs id={`${id}${i}`} />
      <rect width="12" height="12" rx="2" {...seriesFill(`${id}${i}`, colors?.[i] ?? i)} />
    </svg>
  );
  return (
    <ul className="chart__legend">
      {items.map((it, i) => (
        <li key={it.id}>
          {!interactive ? (
            <span className="chart__key">
              {swatch(i)}
              <span className="chart__key-label">{it.label}</span>
              <span className="chart__key-value num">{it.value}</span>
            </span>
          ) : (
            <button
              type="button"
              className={["chart__key", active === i && "is-active"].filter(Boolean).join(" ")}
              onMouseEnter={() => onActive?.(i)}
              onMouseLeave={() => onActive?.(null)}
              onFocus={() => onActive?.(i)}
              onBlur={() => onActive?.(null)}
              onClick={onOpen}
            >
              {swatch(i)}
              <span className="chart__key-label">{it.label}</span>
              <span className="chart__key-value num">{it.value}</span>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
