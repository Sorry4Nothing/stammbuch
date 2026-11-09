/**
 * Kleine Verlaufslinie ohne Achsen für die Kennzahlen-Kacheln. Rein ergänzend: dieselben Zahlen stehen
 * im Monatsdiagramm und seiner Tabelle, darum für Hilfsmittel ausgeblendet.
 */
export function Sparkline({ values }: { values: readonly number[] }) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // Ein Punkt oder eine flache Linie (z. B. alles 0) sagt nichts aus.
  if (values.length < 2 || hi === lo) return null;
  const W = 100;
  const H = 28;
  const y = (v: number) => H - 3 - ((v - lo) / (hi - lo)) * (H - 6);
  const d = values
    .map(
      (v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * W).toFixed(1)} ${y(v).toFixed(1)}`,
    )
    .join("");
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <path className="spark__line" d={d} pathLength={1} />
    </svg>
  );
}
