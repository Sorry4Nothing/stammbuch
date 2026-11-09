import { useEffect, useRef, useState } from "react";
import { formatAmount } from "../format";

/** Abmessungen der Zeichenfläche (viewBox); die Grafik skaliert mit der Kartenbreite. */
export const PLOT = { width: 560, height: 220, left: 64, right: 12, top: 12, bottom: 28 } as const;

export interface Scale {
  min: number;
  max: number;
  ticks: number[];
  /** Wert zu y-Koordinate in der viewBox. */
  y: (value: number) => number;
}

/** Runde Achsenwerte (1, 2, 2.5, 5 × 10ⁿ), die 0 und alle Werte einschliessen. Werte sind Rappen. */
export function niceScale(values: readonly number[], count = 4): Scale {
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const span = hi - lo || 10_000;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag);
  const min = Math.floor(lo / step) * step;
  const max = Math.max(Math.ceil(hi / step) * step, min + step);
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Math.round(v));
  const top = PLOT.top;
  const bottom = PLOT.height - PLOT.bottom;
  return { min, max, ticks, y: (v) => bottom - ((v - min) / (max - min)) * (bottom - top) };
}

/** Achsenbeschriftung ohne Rappen: «12'500», «−5'000». */
export const formatTick = (cents: number): string => formatAmount(cents).replace(/\.00$/, "");

const monthFmt = new Intl.DateTimeFormat("de-CH", { month: "short", timeZone: "UTC" });
const monthLongFmt = new Intl.DateTimeFormat("de-CH", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** «2026-03» wird zu «Mär» bzw. «März 2026». */
export const shortMonth = (month: string): string =>
  monthFmt.format(new Date(`${month}-01T00:00:00Z`)).replace(/\.$/, "");
export const longMonth = (month: string): string =>
  monthLongFmt.format(new Date(`${month}-01T00:00:00Z`));

/** Sitzt die Systemeinstellung «Bewegung reduzieren»? Ohne `matchMedia` (Tests) gilt: ja, also keine Bewegung. */
export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia !== "function"
    ? true
    : window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Zählt beim ersten Erscheinen von 0 auf `target` (höchstens `ms`), danach springt der Wert sofort. */
export function useCountUp(target: number, ms = 480): number {
  const [value, setValue] = useState(() => (prefersReducedMotion() ? target : 0));
  const done = useRef(prefersReducedMotion());
  useEffect(() => {
    if (done.current) {
      setValue(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      setValue(Math.round(target * (1 - (1 - p) ** 3)));
      if (p < 1) frame = requestAnimationFrame(tick);
      else done.current = true;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}
