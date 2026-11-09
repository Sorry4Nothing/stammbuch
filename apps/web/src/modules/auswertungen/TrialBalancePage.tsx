import { useMemo, useState } from "react";
import { t } from "../../i18n";
import { useOnTabActivate } from "../../shell/useOnTabActivate";
import { Badge, Message, type Sort } from "../../ui";
import { fiscalRanges } from "./fiscal";
import { formatAmount, formatChf, formatDate } from "./format";
import {
  Counter,
  LoadState,
  ReportHeader,
  ReportTable,
  Tool,
  ToolSearch,
  ToolSelect,
  ToolSpacer,
  useLoad,
  useToday,
  type ReportColumn,
} from "./parts";
import { useReports } from "./service";
import type { AccountClass, TrialBalanceReport, TrialBalanceRow } from "./types";

const CLASSES: readonly AccountClass[] = ["asset", "liability", "equity", "revenue", "expense"];

/** Zeile der Liste; die Summenzeile trägt beide Saldoseiten getrennt. */
type Line = TrialBalanceRow & { total?: { debit: number; credit: number } };

const side = (cents: number, sign: 1 | -1) => (cents * sign > 0 ? formatAmount(cents * sign) : "");

const columns: ReportColumn<Line>[] = [
  {
    key: "account",
    header: t("trialBalance.col.account"),
    width: "85px",
    sortable: true,
    cell: (r) => r.number,
  },
  {
    key: "name",
    header: t("trialBalance.col.name"),
    wrap: true,
    cell: (r) => (r.total ? t("reports.total") : <b>{r.name}</b>),
  },
  {
    key: "class",
    header: t("trialBalance.col.class"),
    width: "107px",
    cell: (r) => (r.total ? "" : t(`class.${r.type}`)),
  },
  {
    key: "debit",
    header: t("trialBalance.col.debit"),
    width: "151px",
    align: "right",
    cell: (r) => formatAmount(r.debitCents),
  },
  {
    key: "credit",
    header: t("trialBalance.col.credit"),
    width: "151px",
    align: "right",
    cell: (r) => formatAmount(r.creditCents),
  },
  {
    key: "balanceDebit",
    header: t("trialBalance.col.balanceDebit"),
    width: "162px",
    align: "right",
    cell: (r) => (r.total ? formatAmount(r.total.debit) : side(r.balanceCents, 1)),
  },
  {
    key: "balanceCredit",
    header: t("trialBalance.col.balanceCredit"),
    width: "173px",
    align: "right",
    cell: (r) => (r.total ? formatAmount(r.total.credit) : side(r.balanceCents, -1)),
  },
];

const sum = (rows: readonly TrialBalanceRow[], pick: (r: TrialBalanceRow) => number) =>
  rows.reduce((s, r) => s + pick(r), 0);

/** Saldenliste (Board 6.3): Soll, Haben und Saldo je Konto mit Probe, ob die Liste aufgeht. */
export function TrialBalancePage() {
  const svc = useReports();
  const today = useToday();
  const settings = useLoad(() => svc.settings(), [svc]);
  const [range, setRange] = useState<"current" | "previous">("current");

  return (
    <div className="page">
      <LoadState load={settings}>
        {(s) => {
          const ranges = fiscalRanges(today, s.fiscalYearStartMonth);
          const chosen = ranges.find((r) => r.key === range)!;
          return (
            <Report
              from={chosen.from}
              to={chosen.to}
              years={ranges}
              range={range}
              onRange={setRange}
            />
          );
        }}
      </LoadState>
    </div>
  );
}

function Report({
  from,
  to,
  years,
  range,
  onRange,
}: {
  from: string;
  to: string;
  years: ReturnType<typeof fiscalRanges>;
  range: "current" | "previous";
  onRange: (r: "current" | "previous") => void;
}) {
  const svc = useReports();
  const load = useLoad<TrialBalanceReport>(() => svc.trialBalance(from, to), [svc, from, to]);
  useOnTabActivate(load.reload);
  return (
    <>
      <ReportHeader
        title={t("reports.tab.trialBalance")}
        status={<Badge>{t("reports.range", { from: formatDate(from), to: formatDate(to) })}</Badge>}
        onExport={async (format) => [await svc.exportReport("trial-balance", { from, to }, format)]}
      />
      <LoadState load={load}>
        {(report) => <Body report={report} years={years} range={range} onRange={onRange} />}
      </LoadState>
    </>
  );
}

function Body({
  report,
  years,
  range,
  onRange,
}: {
  report: TrialBalanceReport;
  years: ReturnType<typeof fiscalRanges>;
  range: "current" | "previous";
  onRange: (r: "current" | "previous") => void;
}) {
  const [query, setQuery] = useState("");
  const [cls, setCls] = useState("all");
  const [sort, setSort] = useState<Sort>({ key: "account", direction: "asc" });

  const all = report.rows;
  const debit = sum(all, (r) => r.debitCents);
  const credit = sum(all, (r) => r.creditCents);
  const balanceDebit = sum(all, (r) => Math.max(r.balanceCents, 0));
  const balanceCredit = sum(all, (r) => Math.max(-r.balanceCents, 0));
  const balanced = debit === credit && balanceDebit === balanceCredit;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all
      .filter(
        (r) =>
          (cls === "all" || r.type === cls) &&
          (!q || r.number.includes(q) || r.name.toLowerCase().includes(q)),
      )
      .sort(
        (a, b) =>
          (sort.direction === "asc" ? 1 : -1) *
          a.number.localeCompare(b.number, "de", { numeric: true }),
      );
  }, [all, query, cls, sort]);

  const lines: Line[] = [
    ...rows,
    {
      number: "",
      name: "",
      type: "asset",
      debitCents: sum(rows, (r) => r.debitCents),
      creditCents: sum(rows, (r) => r.creditCents),
      balanceCents: 0,
      total: {
        debit: sum(rows, (r) => Math.max(r.balanceCents, 0)),
        credit: sum(rows, (r) => Math.max(-r.balanceCents, 0)),
      },
    },
  ];

  return (
    <>
      <div className="rep__banner">
        {balanced ? (
          <Message tone="ok" title={t("trialBalance.ok.title")}>
            {t("trialBalance.ok.text", {
              total: formatChf(debit),
              balance: formatChf(balanceDebit),
            })}
          </Message>
        ) : (
          <Message tone="error" title={t("trialBalance.off.title")}>
            {t("trialBalance.off.text", {
              debit: formatChf(debit),
              credit: formatChf(credit),
              diff: formatChf(Math.abs(debit - credit)),
            })}
          </Message>
        )}
      </div>
      <Tool>
        <ToolSearch label={t("trialBalance.search")} value={query} onChange={setQuery} />
        <ToolSelect
          label={t("trialBalance.period.label")}
          value={range}
          onChange={(v) => onRange(v as "current" | "previous")}
          options={years.map((y) => ({
            value: y.key,
            label: t("trialBalance.period", { year: y.year }),
          }))}
        />
        <ToolSelect
          label={t("trialBalance.class.label")}
          value={cls}
          onChange={setCls}
          options={[
            { value: "all", label: t("trialBalance.class", { value: t("reports.all") }) },
            ...CLASSES.map((c) => ({
              value: c,
              label: t("trialBalance.class", { value: t(`class.${c}`) }),
            })),
          ]}
        />
        <ToolSpacer />
        <Counter text={t("reports.count.accounts", { shown: rows.length, total: all.length })} />
      </Tool>
      <div className="rep__list">
        <ReportTable
          label={t("trialBalance.table")}
          columns={columns}
          rows={lines}
          rowKey={(r) => (r.total ? "total" : r.number)}
          rowClass={(r) => (r.total ? "tot" : undefined)}
          sort={sort}
          onSort={setSort}
        />
      </div>
    </>
  );
}
