import { useState } from "react";
import { t } from "../../../i18n";
import { ChartCard, Legend, SeriesDefs, seriesFill, useChartId, type TableData } from "./parts";

export interface Segment {
  key: string;
  label: string;
  /** Ganze Rappen; kleiner als 0 wird im Balken nicht gezeichnet, steht aber in Legende und Tabelle. */
  value: number;
  /** Anzahl Posten, falls bekannt. */
  count?: number;
}

interface Props {
  title: string;
  summary: string;
  segments: Segment[];
  format: (cents: number) => string;
  onOpen?: () => void;
  empty?: { title: string; text: string };
  note?: string;
  head: string[];
  className?: string;
}

const W = 400;
const H = 16;

/** Ein waagrechter, gestapelter Balken (z. B. Alterung) mit Legende je Klasse. */
export function StackedBar({
  title,
  summary,
  segments,
  format,
  onOpen,
  empty,
  note,
  head,
  className,
}: Props) {
  const id = useChartId();
  const [active, setActive] = useState<number | null>(null);
  const total = segments.reduce((s, x) => s + x.value, 0);
  const drawn = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  let x = 0;
  const rects = segments.map((s) => {
    const w = drawn ? (Math.max(0, s.value) / drawn) * W : 0;
    const r = { x, w };
    x += w;
    return r;
  });
  const table: TableData = {
    caption: title,
    head,
    rows: [
      ...segments.map((s) => [
        s.label,
        ...(s.count === undefined ? [] : [String(s.count)]),
        format(s.value),
      ]),
      [
        t("dash.total"),
        ...(segments.some((s) => s.count !== undefined)
          ? [String(segments.reduce((n, s) => n + (s.count ?? 0), 0))]
          : []),
        format(total),
      ],
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
      <p className="chart__total num">
        <span className="muted">{t("dash.total")}</span> <b>{format(total)}</b>
      </p>
      <svg
        className="chart__svg chart__svg--stack"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
      >
        <title>{title}</title>
        <SeriesDefs id={id} />
        {segments.map((s, i) =>
          rects[i]!.w > 0 ? (
            <rect
              key={s.key}
              x={rects[i]!.x}
              y={0}
              width={rects[i]!.w}
              height={H}
              vectorEffect="non-scaling-stroke"
              {...seriesFill(id, i, `chart__seg${active === i ? " is-active" : ""}`)}
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
            />
          ) : null,
        )}
      </svg>
      <Legend
        items={segments.map((s) => ({
          id: s.key,
          label: s.label,
          value:
            s.count === undefined
              ? format(s.value)
              : `${t("dash.items", { n: s.count })} · ${format(s.value)}`,
        }))}
        active={active}
        onActive={setActive}
        onOpen={onOpen}
        colors={[0, 1, 2, 3, 4]}
      />
    </ChartCard>
  );
}
