import { PLOT, formatTick, niceScale, usePlotFontSize } from "./chartUtils";
import { ChartCard, Legend, PlotHits, type HitItem, type TableData } from "./parts";

export interface LinePoint {
  key: string;
  label: string;
  fullLabel: string;
  /** Ganze Rappen. */
  value: number;
}

interface Props {
  title: string;
  summary: string;
  seriesLabel: string;
  points: LinePoint[];
  format: (cents: number) => string;
  onOpen?: () => void;
  empty?: { title: string; text: string };
  categoryHead: string;
  className?: string;
}

/** Linie mit Fläche zur Nulllinie (z. B. kumuliertes Ergebnis). */
export function LineChart({
  title,
  summary,
  seriesLabel,
  points,
  format,
  onOpen,
  empty,
  categoryHead,
  className,
}: Props) {
  const scale = niceScale(points.map((p) => p.value));
  const inner = PLOT.width - PLOT.left - PLOT.right;
  const slot = inner / Math.max(1, points.length);
  const xs = points.map((_, i) => PLOT.left + i * slot + slot / 2);
  const ys = points.map((p) => scale.y(p.value));
  const line = points
    .map((_, i) => `${i === 0 ? "M" : "L"}${xs[i]!.toFixed(1)} ${ys[i]!.toFixed(1)}`)
    .join("");
  const zero = scale.y(0);
  const area = points.length
    ? `${line}L${xs[xs.length - 1]!.toFixed(1)} ${zero.toFixed(1)}L${xs[0]!.toFixed(1)} ${zero.toFixed(1)}Z`
    : "";
  const every = Math.ceil(points.length / 12);

  const hits: HitItem[] = points.map((p, i) => ({
    id: p.key,
    label: `${p.fullLabel}: ${seriesLabel} ${format(p.value)}`,
    left: ((PLOT.left + i * slot) / PLOT.width) * 100,
    width: (slot / PLOT.width) * 100,
    tip: (
      <>
        <b>{p.fullLabel}</b>
        <span className="chart__tip-row">
          <span>{seriesLabel}</span>
          <span className="num">{format(p.value)}</span>
        </span>
      </>
    ),
  }));
  const table: TableData = {
    caption: title,
    head: [categoryHead, seriesLabel],
    rows: points.map((p) => [p.fullLabel, format(p.value)]),
  };

  const plot = usePlotFontSize();

  return (
    <ChartCard title={title} onOpen={onOpen} table={table} empty={empty} className={className}>
      <div className="chart__plot" {...plot}>
        <svg
          className="chart__svg"
          viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
          role="img"
          aria-label={summary}
        >
          <title>{title}</title>
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
          <path className="chart__area" d={area} />
          <path className="chart__line" d={line} pathLength={1} />
          {points.map((p, i) => (
            <g key={p.key}>
              <circle className="chart__point" cx={xs[i]} cy={ys[i]} r={3} />
              {i % every === 0 && (
                <text className="chart__tick" x={xs[i]} y={PLOT.height - 8} textAnchor="middle">
                  {p.label}
                </text>
              )}
            </g>
          ))}
        </svg>
        <PlotHits items={hits} onOpen={onOpen} />
      </div>
      <Legend items={[{ id: "s", label: seriesLabel, value: format(points.at(-1)?.value ?? 0) }]} />
    </ChartCard>
  );
}
