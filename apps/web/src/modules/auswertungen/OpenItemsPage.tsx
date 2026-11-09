import { useMemo, useState } from "react";
import { t } from "../../i18n";
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
import { BUCKETS, type Bucket, type OpenItemRow, type OpenItemsReport } from "./types";

const bucketLabel = (b: Bucket) => t(`reports.bucket.${b}`);

type SummaryRow = { id: "count" | "amount"; label: string; values: number[]; total: number };

function summaryOf(rows: readonly OpenItemRow[]): SummaryRow[] {
  const count = BUCKETS.map((b) => rows.filter((r) => r.bucket === b).length);
  const amount = BUCKETS.map((b) =>
    rows.filter((r) => r.bucket === b).reduce((s, r) => s + r.openCents, 0),
  );
  const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
  return [
    { id: "count", label: t("openItems.summary.count"), values: count, total: sum(count) },
    { id: "amount", label: t("openItems.summary.amount"), values: amount, total: sum(amount) },
  ];
}

const summaryColumns: ReportColumn<SummaryRow>[] = [
  {
    key: "label",
    header: t("openItems.summary.label"),
    cell: (r) => <b>{r.label}</b>,
  },
  ...BUCKETS.map((b, i): ReportColumn<SummaryRow> => ({
    key: b,
    header: bucketLabel(b),
    align: "right",
    width: "140px",
    cell: (r) => (r.id === "count" ? r.values[i] : formatChf(r.values[i]!)),
  })),
  {
    key: "total",
    header: t("reports.total"),
    align: "right",
    width: "140px",
    cell: (r) => <b>{r.id === "count" ? r.total : formatChf(r.total)}</b>,
  },
];

const columns: ReportColumn<OpenItemRow>[] = [
  {
    key: "reference",
    header: t("openItems.col.invoice"),
    width: "129px",
    cell: (r) => <b>{r.reference}</b>,
  },
  {
    key: "debtor",
    header: t("openItems.col.debtor"),
    wrap: true,
    cell: (r) => (
      <>
        {r.debtorName} <span className="rep__sub">{r.debtorNumber}</span>
      </>
    ),
  },
  {
    key: "issue",
    header: t("openItems.col.date"),
    width: "118px",
    cell: (r) => formatDate(r.issueDate),
  },
  {
    key: "due",
    header: t("openItems.col.due"),
    width: "118px",
    sortable: true,
    cell: (r) => formatDate(r.dueDate),
  },
  {
    key: "days",
    header: t("openItems.col.days"),
    width: "85px",
    align: "right",
    cell: (r) => (r.daysOverdue > 0 ? r.daysOverdue : "–"),
  },
  {
    key: "bucket",
    header: t("openItems.col.age"),
    width: "151px",
    cell: (r) => bucketLabel(r.bucket),
  },
  {
    key: "open",
    header: t("openItems.col.open"),
    width: "140px",
    align: "right",
    cell: (r) => formatChf(r.openCents),
  },
];

const compare = (a: OpenItemRow, b: OpenItemRow) =>
  a.dueDate.localeCompare(b.dueDate) || a.reference.localeCompare(b.reference);

/** Offene-Posten-Liste (Board 6.1): Zusammenfassung nach Altersklasse und gefilterte Liste je Posten. */
export function OpenItemsPage() {
  const svc = useReports();
  const today = useToday();
  const [asOf, setAsOf] = useState(today);
  const load = useLoad<OpenItemsReport>(() => svc.openItems(asOf), [svc, asOf]);

  return (
    <div className="page">
      <ReportHeader
        title={t("reports.tab.openItems")}
        status={<Badge>{t("reports.asOf", { date: formatDate(asOf) })}</Badge>}
        onExport={async (format) => [await svc.exportReport("open-items", { asOf }, format)]}
      />
      <LoadState load={load}>
        {(report) => <OpenItems report={report} asOf={asOf} onAsOf={setAsOf} />}
      </LoadState>
    </div>
  );
}

function OpenItems({
  report,
  asOf,
  onAsOf,
}: {
  report: OpenItemsReport;
  asOf: string;
  onAsOf: (iso: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [age, setAge] = useState("all");
  const [sort, setSort] = useState<Sort>({ key: "due", direction: "asc" });

  const summary = useMemo(() => summaryOf(report.rows), [report.rows]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = report.rows.filter(
      (r) =>
        (age === "all" || r.bucket === age) &&
        (!q ||
          [r.reference, r.debtorName, r.debtorNumber].some((v) => v.toLowerCase().includes(q))),
    );
    return list.sort((a, b) => (sort.direction === "asc" ? 1 : -1) * compare(a, b));
  }, [report.rows, query, age, sort]);
  const paging = usePaging(rows.length);
  const shown = paging.slice(rows);
  const total = rows.reduce((s, r) => s + r.openCents, 0);

  return (
    <>
      <div className="rep__summary">
        <Panel title={t("openItems.summary")} flush>
          <ReportTable
            label={t("openItems.summary.label")}
            columns={summaryColumns}
            rows={summary}
            rowKey={(r) => r.id}
          />
        </Panel>
      </div>
      <Tool>
        <ToolSearch
          label={t("openItems.search")}
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
        <ToolSelect
          label={t("openItems.age.label")}
          value={age}
          onChange={(v) => {
            setAge(v);
            paging.setPage(1);
          }}
          options={[
            { value: "all", label: t("openItems.age", { value: t("reports.all") }) },
            ...BUCKETS.map((b) => ({
              value: b,
              label: t("openItems.age", { value: bucketLabel(b) }),
            })),
          ]}
        />
        <ToolSpacer />
        <Counter
          text={t("reports.count", { shown: shown.length, total: rows.length })}
          sorted={t("reports.sorted", {
            column: t("openItems.sort"),
            direction: t(`reports.sorted.${sort.direction}`),
          })}
        />
      </Tool>
      <div className="rep__list">
        <ReportTable
          label={t("openItems.table")}
          columns={columns}
          rows={shown}
          rowKey={(r) => r.id}
          sort={sort}
          onSort={setSort}
          empty={t("reports.emptyFiltered")}
        />
        <div className="rep__total">
          <b>{t("openItems.sum", { n: rows.length })}</b>
          <b className="num">{formatChf(total)}</b>
        </div>
      </div>
      <Pager page={paging.page} pages={paging.pages} onPage={paging.setPage} />
    </>
  );
}
