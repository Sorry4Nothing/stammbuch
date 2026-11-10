import type { ReactNode } from "react";

interface Entry {
  name?: string | number;
  value?: number | string | readonly (number | string)[];
  dataKey?: string | number;
  payload?: { fullLabel?: string };
}

/** Tooltip der Diagramme: Karte mit Titel und einer Zeile je Serie (Recharts reicht Zustand und Daten herein). */
export function ChartTooltip({
  active,
  payload,
  format,
  marks,
}: {
  active?: boolean;
  payload?: readonly Entry[];
  format: (cents: number) => string;
  /** Muster-/Farbfeld je Serie, damit die Zeile nie nur über Farbe zugeordnet wird. */
  marks?: (index: number) => ReactNode;
}) {
  if (!active || !payload?.length) return null;
  const title = payload[0]?.payload?.fullLabel;
  return (
    <div className="chart__tip" role="tooltip">
      {title && <b>{title}</b>}
      {payload.map((p, i) => (
        <span key={String(p.dataKey ?? i)} className="chart__tip-row">
          <span className="chart__tip-key">
            {marks?.(i)}
            {p.name}
          </span>
          <span className="num">{format(Number(p.value ?? 0))}</span>
        </span>
      ))}
    </div>
  );
}
