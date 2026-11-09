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
import type { ReportSettings, VatRate, VatReport } from "./types";

interface Line {
  key: string;
  label: string;
  cents: number;
  tot?: boolean;
}

const positionColumns: ReportColumn<Line>[] = [
  { key: "label", header: t("vat.col.position"), wrap: true, cell: (r) => r.label },
  {
    key: "chf",
    header: t("reports.chf"),
    width: "151px",
    align: "right",
    cell: (r) => formatAmount(r.cents),
  },
];

/** «810» wird zu «8.1 %». */
const percent = (bp: number) => `${(bp / 100).toString()} %`;

function turnoverLines({ turnover }: VatReport): Line[] {
  return [
    { key: "total", label: t("vat.total"), cents: turnover.totalCents },
    ...(turnover.adjustments ?? []).map((a) => ({
      key: a.kind,
      label: t(`vat.adj.${a.kind}`),
      cents: a.cents,
    })),
    { key: "taxable", label: t("vat.taxable"), cents: turnover.taxableCents, tot: true },
  ];
}

/** MwSt-Abrechnung (Board 6.5): steuerbarer Umsatz, Steuer nach Satz und Angaben zur Abrechnung. */
export function VatPage() {
  const svc = useReports();
  const today = useToday();
  const settings = useLoad(() => svc.settings(), [svc]);

  return (
    <div className="page">
      <LoadState load={settings}>
        {(s) => {
          const range = fiscalRanges(today, s.fiscalYearStartMonth)[0]!;
          return <Report from={range.from} to={range.to} year={range.year} settings={s} />;
        }}
      </LoadState>
    </div>
  );
}

function Report({
  from,
  to,
  year,
  settings,
}: {
  from: string;
  to: string;
  year: number;
  settings: ReportSettings;
}) {
  const svc = useReports();
  const load = useLoad<VatReport>(() => svc.vat(from, to), [svc, from, to]);
  return (
    <>
      <ReportHeader
        title={t("reports.tab.vat")}
        status={
          <>
            <Badge>{t("vat.year", { year })}</Badge>
            {load.data?.preview && <Badge tone="warning">{t("vat.preview")}</Badge>}
          </>
        }
        onExport={async (format) => [
          await svc.exportReport("vat", { from, to, method: "effective" }, format),
        ]}
      />
      <LoadState load={load}>{(report) => <Body report={report} settings={settings} />}</LoadState>
    </>
  );
}

function Body({ report, settings }: { report: VatReport; settings: ReportSettings }) {
  const taxTotal = report.rates.reduce((s, r) => s + r.taxCents, 0);
  const turnoverTotal = report.rates.reduce((s, r) => s + r.turnoverCents, 0);
  const columns: ReportColumn<VatRate | "total">[] = [
    {
      key: "rate",
      header: t("vat.col.rate"),
      wrap: true,
      cell: (r) => (r === "total" ? t("reports.total") : percent(r.rateBp)),
    },
    {
      key: "turnover",
      header: t("vat.col.turnover"),
      width: "151px",
      align: "right",
      cell: (r) => formatAmount(r === "total" ? turnoverTotal : r.turnoverCents),
    },
    {
      key: "tax",
      header: t("vat.col.tax"),
      width: "151px",
      align: "right",
      cell: (r) => formatAmount(r === "total" ? taxTotal : r.taxCents),
    },
    {
      key: "account",
      header: t("vat.col.account"),
      width: "129px",
      cell: (r) => (r === "total" ? "" : (r.account ?? "–")),
    },
  ];

  return (
    <div className="rep__split rep__split--wide">
      <div className="rep__col--wide">
        <div className="rep__gap">
          <Panel title={t("vat.turnover")} flush>
            <ReportTable
              label={t("vat.turnover")}
              columns={positionColumns}
              rows={turnoverLines(report)}
              rowKey={(r) => r.key}
              rowClass={(r) => (r.tot ? "tot" : undefined)}
            />
          </Panel>
          <Panel title={t("vat.byRate")} flush>
            <ReportTable
              label={t("vat.byRate")}
              columns={columns}
              rows={[...report.rates, "total" as const]}
              rowKey={(r) => (r === "total" ? "total" : String(r.rateBp))}
              rowClass={(r) => (r === "total" ? "tot" : undefined)}
            />
          </Panel>
        </div>
      </div>
      <div className="rep__col--side">
        <div className="rep__gap">
          <Panel title={t("vat.details")}>
            <dl className="kv rep__kv">
              <dt>{t("vat.number")}</dt>
              <dd>{settings.vatNumber || "–"}</dd>
              <dt>{t("vat.method")}</dt>
              <dd>
                {report.method === "effective"
                  ? t("vat.method.effective")
                  : t("vat.method.saldo", { rate: percent(report.saldoRateBp ?? 0) })}
              </dd>
              <dt>{t("vat.period")}</dt>
              <dd>
                {t("reports.range", { from: formatDate(report.from), to: formatDate(report.to) })}
              </dd>
              <dt>{t("vat.due")}</dt>
              <dd>
                <b>{formatChf(report.payableCents)}</b>
              </dd>
            </dl>
          </Panel>
          {report.preview && (
            <Message tone="warning" title={t("vat.preview.title")}>
              {t("vat.preview.text")}
            </Message>
          )}
          <Message tone="neutral" title={t("vat.check.title")}>
            {t("vat.check.text")}
          </Message>
        </div>
      </div>
    </div>
  );
}
