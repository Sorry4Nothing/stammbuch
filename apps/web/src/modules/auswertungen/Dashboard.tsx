import { useState, type ReactNode } from "react";
import { t } from "../../i18n";
import { useTabs } from "../../shell/tabs";
import { Badge, Button, Message, Panel } from "../../ui";
import { BarChart, DonutChart, LineChart, StackedBar } from "./charts";
import type { LinePoint } from "./charts/LineChart";
import { longMonth, shortMonth } from "./charts/chartUtils";
import { composition, shiftYear } from "./dashboardData";
import type { FiscalRange } from "./fiscal";
import { formatChf, formatDate, nextDay } from "./format";
import { Kpi, type KpiState } from "./Kpi";
import { Tool, ToolDate, ToolSelect, useLoad, type Loaded } from "./parts";
import { useReports } from "./service";
import { REPORT_TABS } from "./tabs";
import { BUCKETS, type DebtorsReport, type OpenItemsReport } from "./types";
import "./dashboard.css";

const count = (n: number) => String(n);
const sum = <T,>(rows: readonly T[], pick: (r: T) => number) =>
  rows.reduce((s, r) => s + pick(r), 0);

type RangeKey = FiscalRange["key"] | "last12" | "custom";

const stateOf = (l: Loaded<unknown>): KpiState =>
  l.error !== undefined ? "failed" : l.data === undefined ? "loading" : "ok";

/** Debitoren mit Mahnstufe 1 oder höher; fehlt die Stufe in der Quelle ganz, gibt es keine Zahl. */
function dunning(r: DebtorsReport | undefined): number | undefined {
  if (!r) return undefined;
  if (r.rows.length > 0 && r.rows.every((d) => d.dunningLevel === undefined)) return undefined;
  return r.rows.filter((d) => (d.dunningLevel ?? 0) >= 1).length;
}

const overdue = (r: OpenItemsReport | undefined) => r?.rows.filter((i) => i.daysOverdue > 0);

/** Karte, solange die Daten laden oder fehlen (der Fehler selbst steht oben als Meldung). */
function StatusCard({ title, failed }: { title: string; failed: boolean }) {
  return (
    <div className="chart">
      <Panel title={title}>
        <p className="muted" role={failed ? undefined : "status"}>
          {failed ? t("dash.kpi.failed") : t("dash.loading")}
        </p>
      </Panel>
    </div>
  );
}

/**
 * Dashboard der Auswertungen: Kennzahlen mit Vergleich zum gleichen Zeitraum des Vorjahres und Grafiken.
 * Jede Quelle lädt für sich; fällt eine aus, bleibt der Rest sichtbar und oben steht eine Meldung.
 */
export function Dashboard({
  ranges,
  today,
  children,
}: {
  /** Weitere Karte am Ende des Rasters. */
  children?: ReactNode;
  ranges: FiscalRange[];
  today: string;
}) {
  const svc = useReports();
  const { openTab } = useTabs();
  const last12 = { from: nextDay(shiftYear(today, -1)), to: today };
  const [range, setRange] = useState<RangeKey>("current");
  const [custom, setCustom] = useState(last12);
  const { from, to } =
    range === "last12"
      ? last12
      : range === "custom"
        ? custom
        : ranges.find((r) => r.key === range)!;
  const pf = shiftYear(from, -1);
  const pt = shiftYear(to, -1);
  const open = (tab: string) => () => openTab(tab, { key: tab });

  const stmt = useLoad(() => svc.statements(from, to), [svc, from, to]);
  const stmtPrev = useLoad(() => svc.statements(pf, pt), [svc, pf, pt]);
  const items = useLoad(() => svc.openItems(to), [svc, to]);
  const itemsPrev = useLoad(() => svc.openItems(pt), [svc, pt]);
  const debtors = useLoad(() => svc.debtors(to), [svc, to]);
  const debtorsPrev = useLoad(() => svc.debtors(pt), [svc, pt]);
  const vat = useLoad(() => svc.vat(from, to), [svc, from, to]);
  const vatPrev = useLoad(() => svc.vat(pf, pt), [svc, pf, pt]);
  const monthly = useLoad(() => svc.monthly(from, to), [svc, from, to]);

  // Der Vergleichswert ist Beigabe: fällt er aus, bleibt die Kennzahl ohne Pfeil stehen.
  const failed = [stmt, items, debtors, vat, monthly].filter((l) => l.error !== undefined);
  const income = stmt.data?.income;
  const prevIncome = stmtPrev.data?.income;
  const months = monthly.data?.rows;
  const overdueNow = overdue(items.data);
  const dunningNow = dunning(debtors.data);

  const points = (months ?? []).reduce<LinePoint[]>(
    (a, m) => [
      ...a,
      {
        key: m.month,
        label: shortMonth(m.month),
        fullLabel: longMonth(m.month),
        value: (a.at(-1)?.value ?? 0) + m.resultCents,
      },
    ],
    [],
  );
  const range0 = t("reports.range", { from: formatDate(from), to: formatDate(to) });
  const hasResult = months?.some((m) => m.revenueCents !== 0 || m.expenseCents !== 0) ?? false;
  const emptyPeriod = { title: t("dash.empty.title"), text: t("dash.empty.period") };

  const kpis = (
    <section className="dash__kpis" aria-label={t("dash.kpis")}>
      <Kpi
        label={t("dash.kpi.revenue")}
        state={stateOf(stmt)}
        value={income?.revenueCents}
        prev={prevIncome?.revenueCents}
        format={formatChf}
        good="up"
        onOpen={open(REPORT_TABS.statements)}
      />
      <Kpi
        label={t("dash.kpi.expense")}
        state={stateOf(stmt)}
        value={income?.expenseCents}
        prev={prevIncome?.expenseCents}
        format={formatChf}
        good="down"
        onOpen={open(REPORT_TABS.statements)}
      />
      <Kpi
        label={t("dash.kpi.result")}
        state={stateOf(stmt)}
        value={income?.resultCents}
        prev={prevIncome?.resultCents}
        format={formatChf}
        good="up"
        onOpen={open(REPORT_TABS.statements)}
      />
      <Kpi
        label={t("dash.kpi.open")}
        state={stateOf(items)}
        value={items.data && sum(items.data.rows, (r) => r.openCents)}
        prev={itemsPrev.data && sum(itemsPrev.data.rows, (r) => r.openCents)}
        format={formatChf}
        good="down"
        note={items.data && t("dash.items", { n: items.data.rows.length })}
        onOpen={open(REPORT_TABS.openItems)}
      />
      <Kpi
        label={t("dash.kpi.overdue")}
        state={stateOf(items)}
        value={overdueNow && sum(overdueNow, (r) => r.openCents)}
        prev={overdue(itemsPrev.data) && sum(overdue(itemsPrev.data)!, (r) => r.openCents)}
        format={formatChf}
        good="down"
        note={overdueNow && t("dash.items", { n: overdueNow.length })}
        onOpen={open(REPORT_TABS.openItems)}
      />
      <Kpi
        label={t("dash.kpi.dunning")}
        state={debtors.data && dunningNow === undefined ? "unavailable" : stateOf(debtors)}
        value={dunningNow}
        prev={dunning(debtorsPrev.data)}
        format={count}
        good="down"
        note={
          debtors.data &&
          (dunningNow === undefined
            ? t("dash.kpi.dunning.none")
            : t("dash.kpi.debtors", { n: debtors.data.rows.length }))
        }
        onOpen={open(REPORT_TABS.debtors)}
      />
      <Kpi
        label={t("dash.kpi.vat")}
        state={stateOf(vat)}
        value={vat.data?.payableCents}
        prev={vatPrev.data?.payableCents}
        format={formatChf}
        good="neutral"
        note={vat.data && t(vat.data.preview ? "dash.kpi.vat.preview" : "dash.kpi.vat.final")}
        onOpen={open(REPORT_TABS.vat)}
      />
    </section>
  );

  return (
    <div className="dash">
      <Tool>
        <ToolSelect
          label={t("trialBalance.period.label")}
          value={range}
          onChange={(v) => setRange(v as RangeKey)}
          options={[
            ...ranges.map((r) => ({
              value: r.key,
              label: t("trialBalance.period", { year: r.year }),
            })),
            { value: "last12", label: t("dash.period.last12") },
            { value: "custom", label: t("dash.period.custom") },
          ]}
        />
        {range === "custom" && (
          <>
            <ToolDate
              prefix={t("dash.custom.from")}
              label={t("dash.custom.from.label")}
              value={custom.from}
              onChange={(iso) => setCustom((c) => ({ from: iso, to: iso > c.to ? iso : c.to }))}
            />
            <ToolDate
              prefix={t("dash.custom.to")}
              label={t("dash.custom.to.label")}
              value={custom.to}
              onChange={(iso) => setCustom((c) => ({ from: iso < c.from ? iso : c.from, to: iso }))}
            />
          </>
        )}
        <Badge>{range0}</Badge>
        <span className="rep__sub">
          {t("dash.compare", { from: formatDate(pf), to: formatDate(pt) })}
        </span>
      </Tool>
      {failed.length > 0 && (
        <Message tone="error" title={t("dash.error.title")}>
          {t("dash.error.text")}{" "}
          <Button small onClick={() => failed.forEach((l) => l.reload())}>
            {t("dash.error.retry")}
          </Button>
        </Message>
      )}
      {kpis}
      <div className="grid dash__charts">
        {months ? (
          <BarChart
            title={t("dash.chart.monthly")}
            summary={t("dash.alt.bars", {
              title: t("dash.chart.monthly"),
              range: range0,
              totals: `${t("dash.kpi.revenue")} ${formatChf(sum(months, (m) => m.revenueCents))}, ${t("dash.kpi.expense")} ${formatChf(sum(months, (m) => m.expenseCents))}`,
            })}
            categoryHead={t("dash.col.month")}
            series={[{ label: t("dash.kpi.revenue") }, { label: t("dash.kpi.expense") }]}
            categories={months.map((m) => ({
              key: m.month,
              label: shortMonth(m.month),
              fullLabel: longMonth(m.month),
              values: [m.revenueCents, m.expenseCents],
            }))}
            format={formatChf}
            empty={hasResult ? undefined : emptyPeriod}
            onOpen={open(REPORT_TABS.statements)}
          />
        ) : (
          <StatusCard title={t("dash.chart.monthly")} failed={monthly.error !== undefined} />
        )}
        {months ? (
          <LineChart
            title={t("dash.chart.cumulative")}
            summary={t("dash.alt.line", {
              title: t("dash.chart.cumulative"),
              range: range0,
              last: formatChf(points.at(-1)?.value ?? 0),
              min: formatChf(Math.min(0, ...points.map((p) => p.value))),
              max: formatChf(Math.max(0, ...points.map((p) => p.value))),
            })}
            categoryHead={t("dash.col.month")}
            seriesLabel={t("dash.series.cumulative")}
            points={points}
            format={formatChf}
            empty={hasResult ? undefined : emptyPeriod}
            onOpen={open(REPORT_TABS.statements)}
          />
        ) : (
          <StatusCard title={t("dash.chart.cumulative")} failed={monthly.error !== undefined} />
        )}
        {income ? (
          (() => {
            const { slices, excludedCents } = composition(
              stmt.data!.income.revenue,
              t("dash.composition.other"),
            );
            return (
              <DonutChart
                title={t("dash.chart.composition")}
                summary={t("dash.alt.donut", {
                  title: t("dash.chart.composition"),
                  n: slices.length,
                  top: slices[0] ? `${slices[0].label} ${formatChf(slices[0].value)}` : "",
                })}
                slices={slices}
                format={formatChf}
                head={[t("dash.col.account"), t("dash.col.amount"), t("dash.col.share")]}
                note={
                  excludedCents < 0
                    ? t("dash.composition.note", { value: formatChf(excludedCents) })
                    : undefined
                }
                empty={
                  slices.length > 0
                    ? undefined
                    : { title: t("dash.empty.title"), text: t("dash.empty.revenue") }
                }
                onOpen={open(REPORT_TABS.statements)}
              />
            );
          })()
        ) : (
          <StatusCard title={t("dash.chart.composition")} failed={stmt.error !== undefined} />
        )}
        {items.data ? (
          (() => {
            const segments = BUCKETS.map((b) => {
              const rows = items.data!.rows.filter((r) => r.bucket === b);
              return {
                key: b,
                label: t(`reports.bucket.${b}`),
                value: sum(rows, (r) => r.openCents),
                count: rows.length,
              };
            });
            return (
              <StackedBar
                className="chart--aging"
                title={t("dash.chart.aging")}
                summary={t("dash.alt.stack", {
                  title: t("dash.chart.aging"),
                  total: formatChf(sum(segments, (s) => s.value)),
                  parts: segments.map((s) => `${s.label} ${formatChf(s.value)}`).join(", "),
                })}
                segments={segments}
                format={formatChf}
                head={[t("dash.col.class"), t("dash.col.count"), t("dash.col.amount")]}
                note={segments.some((s) => s.value < 0) ? t("dash.aging.note") : undefined}
                empty={
                  items.data.rows.length > 0
                    ? undefined
                    : { title: t("dash.empty.items.title"), text: t("dash.empty.items") }
                }
                onOpen={open(REPORT_TABS.openItems)}
              />
            );
          })()
        ) : (
          <StatusCard title={t("dash.chart.aging")} failed={items.error !== undefined} />
        )}
        {months ? (
          <BarChart
            title={t("dash.chart.paid")}
            summary={t("dash.alt.bars", {
              title: t("dash.chart.paid"),
              range: range0,
              totals: `${t("dash.series.invoiced")} ${formatChf(sum(months, (m) => m.invoicedCents))}, ${t("dash.series.settled")} ${formatChf(sum(months, (m) => m.settledCents))}`,
            })}
            categoryHead={t("dash.col.month")}
            series={[{ label: t("dash.series.invoiced") }, { label: t("dash.series.settled") }]}
            categories={months.map((m) => ({
              key: m.month,
              label: shortMonth(m.month),
              fullLabel: longMonth(m.month),
              values: [m.invoicedCents, m.settledCents],
            }))}
            format={formatChf}
            note={t("dash.paid.note")}
            empty={
              months.some((m) => m.invoicedCents !== 0 || m.settledCents !== 0)
                ? undefined
                : emptyPeriod
            }
            onOpen={open(REPORT_TABS.openItems)}
          />
        ) : (
          <StatusCard title={t("dash.chart.paid")} failed={monthly.error !== undefined} />
        )}
        {children}
      </div>
    </div>
  );
}
