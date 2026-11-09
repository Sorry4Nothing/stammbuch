import { useState } from "react";
import { t } from "../../../i18n";
import { ChartCard, Legend, SeriesDefs, seriesFill, useChartId, type TableData } from "./parts";

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

const C = 100;
const R1 = 84;
const R0 = 52;

function arc(a0: number, a1: number): string {
  const p = (r: number, a: number) =>
    `${(C + r * Math.sin(a)).toFixed(2)} ${(C - r * Math.cos(a)).toFixed(2)}`;
  const big = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(R1, a0)}A${R1} ${R1} 0 ${big} 1 ${p(R1, a1)}L${p(R0, a1)}A${R0} ${R0} 0 ${big} 0 ${p(R0, a0)}Z`;
}

/** Ring mit Legende; die Mitte zeigt das Total bzw. den gewählten Anteil. */
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
  let angle = 0;
  // Ein einzelner Anteil füllt den ganzen Ring; ein voller Bogen wäre ein leerer Pfad.
  const paths = slices.map((s) => {
    const a0 = angle;
    angle += (s.value / total) * Math.PI * 2;
    return arc(a0, Math.min(angle, a0 + Math.PI * 2 - 0.001));
  });
  const shown = active === null ? undefined : slices[active];
  const table: TableData = {
    caption: title,
    head,
    rows: [
      ...slices.map((s) => [s.label, format(s.value), `${percent(s.value)} %`]),
      [t("dash.total"), format(total), "100 %"],
    ],
  };

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
        <svg
          className="chart__svg chart__svg--donut"
          viewBox="0 0 200 200"
          role="img"
          aria-label={summary}
        >
          <title>{title}</title>
          <SeriesDefs id={id} />
          {slices.map((s, i) => (
            <path
              key={s.key}
              d={paths[i]}
              {...seriesFill(
                id,
                i,
                `chart__slice${active === i ? " is-active" : ""}${slices.length === 1 ? " chart__slice--only" : ""}`,
              )}
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
            />
          ))}
          <text className="chart__center num" x={C} y={C - 4} textAnchor="middle">
            {format(shown?.value ?? total)}
          </text>
          <text className="chart__center-sub" x={C} y={C + 14} textAnchor="middle">
            {shown ? `${percent(shown.value)} %` : t("dash.total")}
          </text>
        </svg>
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
