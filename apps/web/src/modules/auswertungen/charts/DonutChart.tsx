import { useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { t } from "../../../i18n";
import { prefersReducedMotion } from "./chartUtils";
import { ChartTooltip } from "./ChartTooltip";
import { ChartCard, Legend, SeriesDefs, useChartId, type TableData } from "./parts";

export interface Slice {
  key: string;
  label: string;
  /** Ganze Rappen, nur positive Werte. */
  value: number;
}

interface Props {
  title: string;
  summary: string;
  slices: Slice[];
  format: (cents: number) => string;
  onOpen?: () => void;
  empty?: { title: string; text: string };
  note?: string;
  head: [string, string, string];
  className?: string;
}

/** Ring mit gerundeten Segmenten und Legende; die Mitte zeigt das Total bzw. den gewählten Anteil. */
export function DonutChart({
  title,
  summary,
  slices,
  format,
  onOpen,
  empty,
  note,
  head,
  className,
}: Props) {
  const id = useChartId();
  const [active, setActive] = useState<number | null>(null);
  const total = slices.reduce((s, x) => s + x.value, 0);
  const percent = (v: number) => (total ? Math.round((v / total) * 1000) / 10 : 0);
  const shown = active === null ? undefined : slices[active];
  const data = slices.map((s) => ({ name: s.label, fullLabel: s.label, value: s.value }));
  const table: TableData = {
    caption: title,
    head,
    rows: [
      ...slices.map((s) => [s.label, format(s.value), `${percent(s.value)} %`]),
      [t("dash.total"), format(total), "100 %"],
    ],
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
      <div className="chart__donut">
        <div className="chart__ring" role="img" aria-label={summary}>
          <ResponsiveContainer
            width="100%"
            height="100%"
            initialDimension={{ width: 200, height: 200 }}
          >
            <PieChart accessibilityLayer>
              <SeriesDefs id={id} />
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                innerRadius="72%"
                outerRadius="94%"
                paddingAngle={slices.length > 1 ? 3 : 0}
                cornerRadius={slices.length > 1 ? 5 : 0}
                startAngle={90}
                endAngle={-270}
                stroke="none"
                isAnimationActive={animate}
                animationDuration={600}
                onMouseEnter={(_, i) => setActive(i)}
                onMouseLeave={() => setActive(null)}
              >
                {slices.map((s, i) => (
                  <Cell
                    key={s.key}
                    fill={i === 0 ? "var(--chart-0)" : `url(#${id}-p${i})`}
                    fillOpacity={active === null || active === i ? 1 : 0.45}
                  />
                ))}
              </Pie>
              <Tooltip content={<ChartTooltip format={format} />} isAnimationActive={false} />
            </PieChart>
          </ResponsiveContainer>
          <div className="chart__ring-center" aria-hidden="true">
            <b className="num">{format(shown?.value ?? total)}</b>
            <span>{shown ? `${percent(shown.value)} %` : t("dash.total")}</span>
          </div>
        </div>
        <Legend
          items={slices.map((s) => ({
            id: s.key,
            label: s.label,
            value: `${format(s.value)} · ${percent(s.value)} %`,
          }))}
          active={active}
          onActive={setActive}
          onOpen={onOpen}
        />
      </div>
    </ChartCard>
  );
}
