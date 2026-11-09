import { t } from "../../i18n";
import { Badge, Message, Panel } from "../../ui";
import { fiscalRanges } from "./fiscal";
import { formatAmount, formatChf, formatDate } from "./format";
import {
  LoadState,
  ReportHeader,
  ReportTable,
  useLoad,
  useToday,
  type ReportColumn,
} from "./parts";
import { useReports } from "./service";
import type { StatementRow, StatementsReport } from "./types";

interface Line {
  key: string;
  number: string;
  name: string;
  /** `head`: Zwischenüberschrift ohne Betrag, `tot`: Summenzeile. */
  kind?: "tot" | "head";
  cents?: number;
}

const columns: ReportColumn<Line>[] = [
  { key: "number", header: t("statements.col.account"), width: "85px", cell: (r) => r.number },
  {
    key: "name",
    header: t("statements.col.name"),
    wrap: true,
    cell: (r) => (r.kind === "head" ? <b>{r.name}</b> : r.name),
  },
  {
    key: "chf",
    header: t("statements.col.chf"),
    width: "140px",
    align: "right",
    cell: (r) => (r.cents === undefined ? "" : formatAmount(r.cents)),
  },
];

const lineOf = (r: StatementRow): Line => ({
  key: r.number,
  number: r.number,
  name: r.name,
  cents: r.amountCents,
});

const row = (key: string, name: string, cents?: number, kind?: Line["kind"]): Line => ({
  key,
  number: "",
  name,
  cents,
  kind,
});

function incomeLines({ income }: StatementsReport): Line[] {
  const expenses =
    income.expenses.length === 0
      ? [row("expense", t("statements.expense"), income.expenseCents)]
      : [
          ...income.expenses.map(lineOf),
          row("expenseTotal", t("statements.expenseTotal"), income.expenseCents, "tot"),
        ];
  return [
    ...income.revenue.map(lineOf),
    row("revenueTotal", t("statements.revenueTotal"), income.revenueCents, "tot"),
    ...expenses,
    row(
      "result",
      t(income.resultCents < 0 ? "statements.loss" : "statements.gain"),
      income.resultCents,
      "tot",
    ),
  ];
}

function balanceLines({ balance }: StatementsReport): Line[] {
  return [
    row("assets", t("statements.assets"), undefined, "head"),
    ...balance.assets.map(lineOf),
    row("assetsTotal", t("statements.assetsTotal"), balance.assetsCents, "tot"),
    row("liabilities", t("statements.liabilities"), undefined, "head"),
    ...balance.liabilities.map(lineOf),
    row("result", t("statements.result"), balance.resultCents),
    row("liabilitiesTotal", t("statements.liabilitiesTotal"), balance.liabilitiesCents, "tot"),
  ];
}

const rowClass = (r: Line) => (r.kind === "tot" ? "tot" : undefined);

/** Erfolgsrechnung und Bilanz der Debitorenbuchhaltung (Board 6.4). */
export function StatementsPage() {
  const svc = useReports();
  const today = useToday();
  const settings = useLoad(() => svc.settings(), [svc]);

  return (
    <div className="page">
      <LoadState load={settings}>
        {(s) => {
          const range = fiscalRanges(today, s.fiscalYearStartMonth)[0]!;
          return <Report from={range.from} to={range.to} />;
        }}
      </LoadState>
    </div>
  );
}

function Report({ from, to }: { from: string; to: string }) {
  const svc = useReports();
  const load = useLoad<StatementsReport>(() => svc.statements(from, to), [svc, from, to]);
  return (
    <>
      <ReportHeader
        title={t("reports.tab.statements")}
        status={
          <>
            <Badge>{t("statements.badge")}</Badge>
            <Badge>{t("reports.range", { from: formatDate(from), to: formatDate(to) })}</Badge>
          </>
        }
        onExport={async () => [
          await svc.exportReport("income-statement", { from, to }, "xlsx"),
          await svc.exportReport("balance-sheet", { asOf: to }, "xlsx"),
        ]}
      />
      <LoadState load={load}>{(report) => <Body report={report} />}</LoadState>
    </>
  );
}

function Body({ report }: { report: StatementsReport }) {
  const { income, balance } = report;
  const balanced = balance.assetsCents === balance.liabilitiesCents;
  return (
    <div className="rep__stack">
      <Message tone="neutral" title={t("statements.note.title")}>
        {t("statements.note.text")}
        {income.expenses.length === 0 && ` ${t("statements.note.noExpense")}`}
      </Message>
      <div className="rep__split">
        <div className="rep__col">
          <Panel title={t("statements.income")} flush>
            <ReportTable
              label={t("statements.income")}
              columns={columns}
              rows={incomeLines(report)}
              rowKey={(r) => r.key}
              rowClass={rowClass}
            />
          </Panel>
        </div>
        <div className="rep__col">
          <Panel title={t("statements.balance", { date: formatDate(report.to) })} flush>
            <ReportTable
              label={t("statements.balance.label")}
              columns={columns}
              rows={balanceLines(report)}
              rowKey={(r) => r.key}
              rowClass={rowClass}
            />
          </Panel>
        </div>
      </div>
      {balanced ? (
        <Message tone="ok" title={t("statements.ok.title")}>
          {t("statements.ok.text", { total: formatChf(balance.assetsCents) })}
        </Message>
      ) : (
        <Message tone="error" title={t("statements.off.title")}>
          {t("statements.off.text", {
            assets: formatChf(balance.assetsCents),
            liabilities: formatChf(balance.liabilitiesCents),
          })}
        </Message>
      )}
    </div>
  );
}
