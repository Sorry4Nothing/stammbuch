import { useMemo, useState } from "react";
import { tp, t } from "../../i18n";
import { useOnTabActivate } from "../../shell/useOnTabActivate";
import { Badge, Panel, type Sort } from "../../ui";
import { formatChf, formatDate } from "./format";
import {
  Counter,
  LoadState,
  Pager,
  ReportHeader,
  ReportTable,
  Tool,
  ToolDate,
  ToolSearch,
  ToolSelect,
  ToolSpacer,
  useLoad,
  usePaging,
  useToday,
  type ReportColumn,
} from "./parts";
import { useReports } from "./service";
import type { DebtorAccountSummary, DebtorRow, DebtorsReport } from "./types";

const dunningLabel = (level: number) =>
  level <= 0
    ? t("dunning.none")
    : level === 1
      ? t("dunning.reminder")
      : t("dunning.notice", { level, n: level - 1 });

type SummaryRow = DebtorAccountSummary & { total?: boolean };

const summaryColumns: ReportColumn<SummaryRow>[] = [
  {
    key: "account",
    header: t("debtors.summary.account"),
    wrap: true,
    cell: (r) =>
      r.total ? (
        t("reports.total")
      ) : (
        <>
          <b>{r.number}</b> {r.name}
        </>
      ),
  },
  {
    key: "debtors",
    header: t("debtors.summary.debtors"),
    width: "140px",
    align: "right",
    cell: (r) => r.debtors,
  },
  {
    key: "items",
    header: t("debtors.summary.items"),
    width: "118px",
    align: "right",
    cell: (r) => r.items,
  },
  {
    key: "balance",
    header: t("debtors.summary.balance"),
    width: "162px",
    align: "right",
    cell: (r) => formatChf(r.balanceCents),
  },
];

const compare = (a: DebtorRow, b: DebtorRow) =>
  a.oldestDueDate.localeCompare(b.oldestDueDate) || a.number.localeCompare(b.number);

/** Debitorenliste (Board 6.2): Saldo je Debitor mit Summe je Debitorenkonto. */
export function DebtorsPage() {
  const svc = useReports();
  const today = useToday();
  const [asOf, setAsOf] = useState(today);
  const load = useLoad<DebtorsReport>(() => svc.debtors(asOf), [svc, asOf]);
  useOnTabActivate(load.reload);

  return (
    <div className="page">
      <ReportHeader
        title={t("reports.tab.debtors")}
        status={<Badge>{t("reports.asOf", { date: formatDate(asOf) })}</Badge>}
        onExport={async (format) => [await svc.exportReport("debtors", { asOf }, format)]}
      />
      <LoadState load={load}>
        {(report) => <Debtors report={report} asOf={asOf} onAsOf={setAsOf} />}
      </LoadState>
    </div>
  );
}

function Debtors({
  report,
  asOf,
  onAsOf,
}: {
  report: DebtorsReport;
  asOf: string;
  onAsOf: (iso: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [dunning, setDunning] = useState("all");
  const [sort, setSort] = useState<Sort>({ key: "oldest", direction: "asc" });

  // Art und Mahnstufe liefert nicht jede Quelle: ohne diese Angaben bleiben die Filter ohne Wirkung.
  const hasType = report.rows.some((r) => r.type !== undefined);
  const levels = [...new Set(report.rows.map((r) => r.dunningLevel))]
    .filter((l): l is number => l !== undefined)
    .sort((a, b) => a - b);

  const summary = useMemo<SummaryRow[]>(() => {
    const items = report.rows.reduce((s, r) => s + r.items, 0);
    const balance = report.rows.reduce((s, r) => s + r.balanceCents, 0);
    const total: SummaryRow = {
      number: "",
      name: "",
      debtors: report.rows.length,
      items,
      balanceCents: balance,
      total: true,
    };
    return report.accounts ? [...report.accounts, total] : [total];
  }, [report]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return report.rows
      .filter(
        (r) =>
          (type === "all" || r.type === type) &&
          (dunning === "all" || String(r.dunningLevel ?? 0) === dunning) &&
          (!q || r.name.toLowerCase().includes(q) || r.number.toLowerCase().includes(q)),
      )
      .sort((a, b) => (sort.direction === "asc" ? 1 : -1) * compare(a, b));
  }, [report.rows, query, type, dunning, sort]);
  const paging = usePaging(rows.length);
  const shown = paging.slice(rows);

  const columns: ReportColumn<DebtorRow>[] = [
    { key: "number", header: t("debtors.col.number"), width: "96px", cell: (r) => r.number || "–" },
    { key: "name", header: t("debtors.col.debtor"), wrap: true, cell: (r) => <b>{r.name}</b> },
    {
      key: "type",
      header: t("debtors.col.type"),
      width: "96px",
      cell: (r) => (r.type ? t(`debtors.type.${r.type}`) : "–"),
    },
    {
      key: "items",
      header: t("debtors.col.items"),
      width: "76px",
      align: "right",
      cell: (r) => r.items,
    },
    {
      key: "oldest",
      header: t("debtors.col.oldest"),
      width: "130px",
      sortable: true,
      cell: (r) => formatDate(r.oldestDueDate),
    },
    {
      key: "overdue",
      header: t("debtors.col.overdue"),
      width: "108px",
      align: "right",
      cell: (r) => (r.overdueDays > 0 ? tp("debtors.days", r.overdueDays) : "–"),
    },
    {
      key: "balance",
      header: t("debtors.col.balance"),
      width: "130px",
      align: "right",
      cell: (r) => formatChf(r.balanceCents),
    },
    {
      key: "dunning",
      header: t("debtors.col.dunning"),
      width: "130px",
      cell: (r) =>
        r.dunningLevel === undefined ? (
          "–"
        ) : (
          <Badge tone={r.dunningLevel > 0 ? "error" : "neutral"}>
            {dunningLabel(r.dunningLevel)}
          </Badge>
        ),
    },
  ];

  return (
    <>
      <div className="rep__summary">
        <Panel title={t("openItems.summary")} flush>
          <ReportTable
            label={t("debtors.summary.label")}
            columns={summaryColumns}
            rows={summary}
            rowKey={(r) => r.number || "total"}
            rowClass={(r) => (r.total ? "tot" : undefined)}
          />
        </Panel>
      </div>
      <Tool>
        <ToolSearch
          label={t("debtors.search")}
          value={query}
          onChange={(v) => {
            setQuery(v);
            paging.setPage(1);
          }}
        />
        <ToolDate
          prefix={t("openItems.asOf")}
          label={t("openItems.asOf.label")}
          value={asOf}
          onChange={onAsOf}
        />
        {hasType && (
          <ToolSelect
            label={t("debtors.type.label")}
            value={type}
            onChange={(v) => {
              setType(v);
              paging.setPage(1);
            }}
            options={[
              { value: "all", label: t("debtors.type", { value: t("reports.all") }) },
              { value: "company", label: t("debtors.type", { value: t("debtors.type.company") }) },
              { value: "person", label: t("debtors.type", { value: t("debtors.type.person") }) },
            ]}
          />
        )}
        {levels.length > 0 && (
          <ToolSelect
            label={t("debtors.dunning.label")}
            value={dunning}
            onChange={(v) => {
              setDunning(v);
              paging.setPage(1);
            }}
            options={[
              { value: "all", label: t("debtors.dunning", { value: t("reports.all") }) },
              ...levels.map((l) => ({
                value: String(l),
                label: t("debtors.dunning", {
                  value:
                    l <= 0
                      ? t("dunning.none")
                      : l === 1
                        ? t("dunning.filter.reminder")
                        : t("dunning.filter.notice", { n: l - 1 }),
                }),
              })),
            ]}
          />
        )}
        <ToolSpacer />
        <Counter text={t("reports.count", { shown: shown.length, total: rows.length })} />
      </Tool>
      <div className="rep__list">
        <ReportTable
          label={t("debtors.table")}
          columns={columns}
          rows={shown}
          rowKey={(r) => r.id}
          sort={sort}
          onSort={setSort}
          empty={t("reports.emptyFiltered")}
        />
      </div>
      <Pager page={paging.page} pages={paging.pages} onPage={paging.setPage} />
    </>
  );
}
