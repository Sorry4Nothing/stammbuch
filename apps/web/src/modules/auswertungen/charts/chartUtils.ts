import { useEffect, useState, type CSSProperties } from "react";
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

/**
 * Schriftgrösse für Achsenbeschriftungen in Einheiten der viewBox. Die Grafik skaliert mit der Kartenbreite;
 * die Schrift wird gegengerechnet, damit sie auf dem Bildschirm `px` gross bleibt (mindestens 12 px).
 */
export function usePlotFontSize(px = 12): {
  ref: (el: HTMLElement | null) => void;
  style: CSSProperties;
} {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  const size = width > 0 ? (px * PLOT.width) / width : px;
  return { ref: setEl, style: { "--chart-fs": `${size}px` } as CSSProperties };
}
