import type { ReactNode } from "react";

export type Tone = "ok" | "warning" | "error" | "neutral";

/** Status immer als Text, nie nur über Farbe (Design-Guide 11.8). */
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}
