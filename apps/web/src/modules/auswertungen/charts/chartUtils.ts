import { useEffect, useState, type CSSProperties } from "react";
import { formatAmount } from "../format";

/** Standardmass der Zeichenfläche (Tests, erste Darstellung); im Browser gilt die gemessene Kartenfläche. */
export const PLOT = { width: 560, height: 220, left: 64, right: 12, top: 12, bottom: 28 } as const;

export interface Dims {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Zeichenfläche in Bildschirmpixeln: die Grafik füllt ihre Karte, die Schrift bleibt 12 px. */
export function dimsFor(width: number, height: number, tickChars: number): Dims {
  const left = Math.max(40, Math.round(tickChars * 7.2) + 20);
  return { width, height, left, right: 12, top: 14, bottom: 30 };
}

export interface Scale {
  min: number;
  max: number;
  ticks: number[];
  /** Wert zu y-Koordinate in der viewBox. */
  y: (value: number) => number;
}

/** Runde Achsenwerte (1, 2, 2.5, 5 × 10ⁿ), die 0 und alle Werte einschliessen. Werte sind Rappen. */
export function niceScale(values: readonly number[], count = 4, dims: Dims = PLOT): Scale {
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
  const top = dims.top;
  const bottom = dims.height - dims.bottom;
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
 * Misst die Fläche des Diagramms (Breite des Kartenkörpers, Höhe soweit die Karte Platz lässt, mindestens `minHeight`).
 * Ohne Messung (Tests, erster Durchlauf) gilt das Standardmass `PLOT`.
 */
export function useBox(minHeight = 200): {
  ref: (el: HTMLElement | null) => void;
  width: number;
  height: number;
  style: CSSProperties;
} {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.clientWidth);
      const h = Math.round(el.clientHeight);
      setBox((b) => (b.width === w && b.height === h ? b : { width: w, height: h }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  const width = box.width > 0 ? box.width : PLOT.width;
  const height = box.width > 0 ? Math.max(minHeight, box.height) : PLOT.height;
  return { ref: setEl, width, height, style: { "--chart-fs": "12px", minHeight } as CSSProperties };
}

/** Beschriftungen der x-Achse: jede n-te, sodass jede mindestens `minPx` Platz hat. */
export const labelEvery = (slot: number, minPx = 30): number =>
  Math.max(1, Math.ceil(minPx / Math.max(1, slot)));

/** Gemessene Zeichenfläche samt Wertachse für Balken- und Liniendiagramme. */
export function useChartGeometry(values: readonly number[]) {
  const box = useBox();
  const first = niceScale(values);
  const chars = Math.max(...first.ticks.map((v) => formatTick(v).length));
  const dims = dimsFor(box.width, box.height, chars);
  const scale = niceScale(values, Math.max(3, Math.min(5, Math.round(dims.height / 56))), dims);
  return { ref: box.ref, style: box.style, dims, scale };
}
