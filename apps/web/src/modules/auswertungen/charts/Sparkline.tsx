/**
 * Kleine Verlaufslinie ohne Achsen für die Kennzahlen-Kacheln. Rein ergänzend: dieselben Zahlen stehen
 * im Monatsdiagramm und seiner Tabelle, darum für Hilfsmittel ausgeblendet.
 */
export function Sparkline({ values }: { values: readonly number[] }) {
  if (values.length < 2) return null;
  const W = 100;
  const H = 28;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const y = (v: number) => (hi === lo ? H / 2 : H - 3 - ((v - lo) / (hi - lo)) * (H - 6));
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
