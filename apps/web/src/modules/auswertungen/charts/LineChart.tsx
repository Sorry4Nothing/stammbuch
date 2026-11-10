import {
  Area,
  AreaChart,
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
import { ChartCard, Legend, useChartId, type TableData } from "./parts";

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

/** Fläche mit Linie (z. B. kumuliertes Ergebnis), gezeichnet mit Recharts. */
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
  const id = useChartId();
  const scale = niceScale(points.map((p) => p.value));
  const data = points.map((p) => ({ label: p.label, fullLabel: p.fullLabel, v0: p.value }));
  const table: TableData = {
    caption: title,
    head: [categoryHead, seriesLabel],
    rows: points.map((p) => [p.fullLabel, format(p.value)]),
  };
  const animate = !prefersReducedMotion();

  return (
    <ChartCard title={title} onOpen={onOpen} table={table} empty={empty} className={className}>
      <div className="chart__plot" role="img" aria-label={summary}>
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 560, height: 260 }}
        >
          <AreaChart
            data={data}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            accessibilityLayer
          >
            <defs>
              <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-0)" stopOpacity={0.32} />
                <stop offset="100%" stopColor="var(--chart-0)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid {...gridProps} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={10}
              tick={axisTick}
              interval={0}
              padding={{ left: 12, right: 12 }}
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
              cursor={{ stroke: "var(--border-strong)", strokeDasharray: "3 4" }}
              content={<ChartTooltip format={format} />}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="v0"
              name={seriesLabel}
              stroke="var(--chart-0)"
              strokeWidth={2.5}
              fill={`url(#${id}-fill)`}
              dot={false}
              activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--surface)", fill: "var(--chart-0)" }}
              isAnimationActive={animate}
              animationDuration={600}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <Legend items={[{ id: "s", label: seriesLabel, value: format(points.at(-1)?.value ?? 0) }]} />
    </ChartCard>
  );
}
