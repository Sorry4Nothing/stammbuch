import { t } from "../../i18n";
import { Icon } from "../../ui";
import { useCountUp } from "./charts/chartUtils";
import { Sparkline } from "./charts/Sparkline";
import { formatPercent, percentChange } from "./dashboardData";

export type KpiState = "ok" | "loading" | "failed" | "unavailable";

export interface KpiProps {
  label: string;
  state: KpiState;
  /** Wert der Periode (Rappen bzw. Anzahl); fehlt bei Laden, Fehler oder wenn die Quelle ihn nicht liefert. */
  value?: number;
  /** Wert des gleichen Zeitraums im Vorjahr; fehlt, wenn er nicht geladen werden konnte. */
  prev?: number;
  format: (n: number) => string;
  /** Welche Richtung gut ist; «neutral» färbt die Veränderung nicht. */
  good: "up" | "down" | "neutral";
  /** Ergänzung unter dem Wert, z. B. «12 Posten». */
  note?: string;
  spark?: readonly number[];
  onOpen: () => void;
}

function Value({ value, format }: { value: number; format: (n: number) => string }) {
  return <>{format(useCountUp(value))}</>;
}

/** Veränderung als Pfeil, Prozent und Text («gestiegen um +12.3 %»), nie nur als Farbe. */
function Delta({ value, prev, good }: { value: number; prev: number; good: KpiProps["good"] }) {
  const pct = percentChange(value, prev);
  if (pct === undefined) return null;
  const flat = Math.abs(pct) < 0.05;
  const dir = flat ? "flat" : pct > 0 ? "up" : "down";
  const tone = flat || good === "neutral" ? "neutral" : dir === good ? "ok" : "bad";
  return (
    <span className={`kpi__delta kpi__delta--${tone}`}>
      <Icon
        name={dir === "up" ? "chevronUp" : dir === "down" ? "chevronDown" : "arrowRight"}
        size={14}
      />
      <span className="visually-hidden">{t(`dash.delta.${dir}`)} </span>
      <span className="num">{flat ? formatPercent(0, false) : formatPercent(pct)}</span>
    </span>
  );
}

/** Kennzahl-Kachel: ganze Fläche ist eine Schaltfläche (Klick oder Enter öffnet die Detailseite). */
export function Kpi({ label, state, value, prev, format, good, note, spark, onOpen }: KpiProps) {
  const ready = state === "ok" && value !== undefined;
  return (
    <button type="button" className="kpi" onClick={onOpen} aria-busy={state === "loading"}>
      <span className="kpi__label">{label}</span>{" "}
      <b className="kpi__value num">
        {ready ? (
          <Value value={value} format={format} />
        ) : state === "loading" ? (
          t("dash.value.loading")
        ) : (
          t("dash.value.none")
        )}
      </b>{" "}
      {ready && prev !== undefined && <Delta value={value} prev={prev} good={good} />}{" "}
      <span className="kpi__note muted">{state === "failed" ? t("dash.kpi.failed") : note}</span>{" "}
      {ready && prev !== undefined && (
        <span className="kpi__note muted num">{t("dash.kpi.prev", { value: format(prev) })}</span>
      )}
      {ready && spark && <Sparkline values={spark} />}
    </button>
  );
}
