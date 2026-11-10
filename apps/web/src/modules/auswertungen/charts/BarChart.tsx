import {
  Bar,
  BarChart as RBarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartTooltip } from "./ChartTooltip";
import {
  axisTick,
  formatTick,
  gridProps,
  niceScale,
  prefersReducedMotion,
  yAxisWidth,
} from "./chartUtils";
import { ChartCard, Legend, SeriesDefs, useChartId, type TableData } from "./parts";

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

/** Gruppierte Balken (eine Gruppe je Kategorie, ein Balken je Serie), gezeichnet mit Recharts. */
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
  const data = categories.map((c) => ({
    label: c.label,
    fullLabel: c.fullLabel,
    ...Object.fromEntries(c.values.map((v, k) => [`v${k}`, v])),
  }));
  const table: TableData = {
    caption: title,
    head: [categoryHead, ...series.map((s) => s.label)],
    rows: categories.map((c) => [c.fullLabel, ...c.values.map(format)]),
  };
  const animate = !prefersReducedMotion();

  return (
    <ChartCard
      title={title}
      onOpen={onOpen}
      table={table}
      empty={empty}
      note={note}
      className={className}
    >
      <div className="chart__plot" role="img" aria-label={summary}>
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 560, height: 260 }}
        >
          <RBarChart
            data={data}
            margin={{ top: 8, right: 4, bottom: 0, left: 0 }}
            barGap={3}
            barCategoryGap="26%"
            accessibilityLayer
          >
            <SeriesDefs id={id} />
            <CartesianGrid {...gridProps} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={10}
              tick={axisTick}
              interval={0}
            />
            <YAxis
              width={yAxisWidth(scale.ticks)}
              tickLine={false}
              axisLine={false}
              tick={axisTick}
              tickFormatter={formatTick}
              domain={[scale.min, scale.max]}
              ticks={scale.ticks}
            />
            <Tooltip
              cursor={{ fill: "var(--surface-2)", opacity: 0.7 }}
              content={<ChartTooltip format={format} />}
              isAnimationActive={false}
            />
            {series.map((s, k) => (
              <Bar
                key={s.label}
                dataKey={`v${k}`}
                name={s.label}
                fill={k === 0 ? "var(--chart-0)" : `url(#${id}-p${k})`}
                radius={[5, 5, 0, 0]}
                maxBarSize={26}
                isAnimationActive={animate}
                animationDuration={500}
              />
            ))}
          </RBarChart>
        </ResponsiveContainer>
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
