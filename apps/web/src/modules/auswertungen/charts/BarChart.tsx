import type { CSSProperties } from "react";
import { PLOT, formatTick, niceScale, usePlotFontSize } from "./chartUtils";
import {
  ChartCard,
  Legend,
  PlotHits,
  SeriesDefs,
  seriesFill,
  useChartId,
  type HitItem,
  type TableData,
} from "./parts";

export interface BarCategory {
  key: string;
  /** Kurzbeschriftung der Achse, z. B. «Jan». */
  label: string;
  /** Ausgeschriebener Name für Tooltip und Tabelle, z. B. «Januar 2026». */
  fullLabel: string;
  /** Ein Wert je Serie, ganze Rappen. */
  values: number[];
}

interface Props {
  title: string;
  /** Textalternative der Grafik (`aria-label`). */
  summary: string;
  series: { label: string }[];
  categories: BarCategory[];
  format: (cents: number) => string;
  onOpen?: () => void;
  empty?: { title: string; text: string };
  note?: string;
  className?: string;
  /** Kopf der ersten Tabellenspalte. */
  categoryHead: string;
}

/** Gruppierte Balken (eine Gruppe je Kategorie, ein Balken je Serie). */
export function BarChart({
  title,
  summary,
  series,
  categories,
  format,
  onOpen,
  empty,
  note,
  className,
  categoryHead,
}: Props) {
  const id = useChartId();
  const scale = niceScale(categories.flatMap((c) => c.values));
  const inner = PLOT.width - PLOT.left - PLOT.right;
  const slot = inner / Math.max(1, categories.length);
  const group = slot * 0.74;
  const bar = group / Math.max(1, series.length);
  const zero = scale.y(0);
  const every = Math.ceil(categories.length / 12);

  const hits: HitItem[] = categories.map((c, i) => ({
    id: c.key,
    label: `${c.fullLabel}: ${series.map((s, k) => `${s.label} ${format(c.values[k] ?? 0)}`).join(", ")}`,
    left: ((PLOT.left + i * slot) / PLOT.width) * 100,
    width: (slot / PLOT.width) * 100,
    tip: (
      <>
        <b>{c.fullLabel}</b>
        {series.map((s, k) => (
          <span key={s.label} className="chart__tip-row">
            <span>{s.label}</span>
            <span className="num">{format(c.values[k] ?? 0)}</span>
          </span>
        ))}
      </>
    ),
  }));

  const table: TableData = {
    caption: title,
    head: [categoryHead, ...series.map((s) => s.label)],
    rows: categories.map((c) => [c.fullLabel, ...c.values.map(format)]),
  };

  const plot = usePlotFontSize();

  return (
    <ChartCard
      title={title}
      onOpen={onOpen}
      table={table}
      empty={empty}
      note={note}
      className={className}
    >
      <div className="chart__plot" {...plot}>
        <svg
          className="chart__svg"
          viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
          role="img"
          aria-label={summary}
        >
          <title>{title}</title>
          <SeriesDefs id={id} />
          {scale.ticks.map((v) => (
            <g key={v}>
              <line
                className={v === 0 ? "chart__zero" : "chart__grid"}
                x1={PLOT.left}
                x2={PLOT.width - PLOT.right}
                y1={scale.y(v)}
                y2={scale.y(v)}
              />
              <text
                className="chart__tick num"
                x={PLOT.left - 8}
                y={scale.y(v)}
                textAnchor="end"
                dy="0.32em"
              >
                {formatTick(v)}
              </text>
            </g>
          ))}
          {categories.map((c, i) => (
            <g key={c.key}>
              {c.values.map((v, k) => {
                const y = scale.y(Math.max(v, 0));
                return (
                  <rect
                    key={k}
                    style={
                      { "--d": `${Math.round((i / categories.length) * 240)}ms` } as CSSProperties
                    }
                    x={PLOT.left + i * slot + (slot - group) / 2 + k * bar}
                    y={y}
                    width={Math.max(1, bar - 2)}
                    height={Math.max(v === 0 ? 0 : 1, Math.abs(scale.y(v) - zero))}
                    {...seriesFill(id, k, `chart__bar${v < 0 ? " chart__bar--neg" : ""}`)}
                  />
                );
              })}
              {i % every === 0 && (
                <text
                  className="chart__tick"
                  x={PLOT.left + i * slot + slot / 2}
                  y={PLOT.height - 8}
                  textAnchor="middle"
                >
                  {c.label}
                </text>
              )}
            </g>
          ))}
        </svg>
        <PlotHits items={hits} onOpen={onOpen} />
      </div>
      <Legend
        items={series.map((s, k) => ({
          id: s.label,
          label: s.label,
          value: format(categories.reduce((sum, c) => sum + (c.values[k] ?? 0), 0)),
        }))}
      />
    </ChartCard>
  );
}
