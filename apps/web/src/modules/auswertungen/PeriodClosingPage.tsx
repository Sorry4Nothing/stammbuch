import { useRef, useState, type ReactNode, type RefObject } from "react";
import { t, tp } from "../../i18n";
import { useCurrentTab, useTabs } from "../../shell/tabs";
import { useOnTabActivate } from "../../shell/useOnTabActivate";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Icon,
  Message,
  Panel,
  TextField,
  useToast,
  type Tone,
} from "../../ui";
import { formatChf, formatDate, formatDateTime, monthName, nextDay } from "./format";
import { ReportsError } from "./httpService";
import { LoadState, ReportTable, saveFile, useLoad, useToday, type ReportColumn } from "./parts";
import { useReports } from "./service";
import { INVOICE_LIST_TAB, REPORT_TABS } from "./tabs";
import type { Leftover, PeriodCheck, PeriodInfo, PeriodReview } from "./types";

type Step = "check" | "confirm" | "done";
const STEPS: readonly Step[] = ["check", "confirm", "done"];

/** Schrittanzeige (Boards 6.6 bis 6.8): erledigte Schritte mit Haken, der aktuelle mit `aria-current`. */
function Steps({ current }: { current: Step }) {
  const at = STEPS.indexOf(current);
  return (
    <div className="rep-steps__padded">
      <ol className="rep-steps" aria-label={t("closing.steps")}>
        {STEPS.map((step, i) => {
          const state = current === "done" || i < at ? "done" : i === at ? "current" : "todo";
          return (
            <li
              key={step}
              className="opt rep-steps__item"
              aria-current={state === "current" ? "step" : "false"}
            >
              <span
                className={`rep-steps__dot rep-steps__dot--${state}`}
                aria-hidden={state !== "done"}
              >
                {state === "done" ? <Icon name="check" size={14} /> : i + 1}
              </span>
              {state === "done" && (
                <span className="visually-hidden">{t("closing.step.finished")}</span>
              )}
              <span>{t(`closing.step.${step}`)}</span>
              {i < STEPS.length - 1 && <span aria-hidden="true" className="rep-steps__line" />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** «CHF 129.72» soll nicht zwischen Währung und Zahl umbrechen. */
const keepAmounts = (text: string) => text.replace(/CHF (?=\d)/g, "CHF\u00a0");

const TONES: Record<PeriodCheck["status"], Tone> = { ok: "ok", warning: "warning", error: "error" };

/** Wählt die Periode: die angegebene, sonst die früheste nicht abgeschlossene, sonst die zuletzt abgeschlossene. */
function pick(periods: readonly PeriodInfo[], wanted: string | undefined): PeriodInfo | undefined {
  return (
    periods.find((p) => p.id === wanted) ??
    periods.find((p) => p.state !== "closed") ??
    periods[periods.length - 1]
  );
}

/** Periodenabschluss (Boards 6.6 bis 6.8): Prüfung, Bestätigung mit Eingabe, Protokoll nach dem Abschluss. */
export function PeriodClosingPage() {
  const svc = useReports();
  const tab = useCurrentTab();
  const list = useLoad(() => svc.periods(), [svc]);

  return (
    <div className="page">
      <LoadState load={list}>
        {(periods) => {
          const first = pick(periods, tab.params["period"]);
          return first ? (
            <Closing initial={periods} periodId={first.id} />
          ) : (
            <div className="state-page">
              <div className="panel state-page__panel">
                <EmptyState title={t("closing.none")} />
              </div>
            </div>
          );
        }}
      </LoadState>
    </div>
  );
}

function Closing({ initial, periodId }: { initial: PeriodInfo[]; periodId: string }) {
  const svc = useReports();
  const tab = useCurrentTab();
  const { openTab } = useTabs();
  const today = useToday();
  const toast = useToast();
  const [periods, setPeriods] = useState(initial);
  const startedClosed = useRef(initial.find((p) => p.id === periodId)?.state === "closed");
  const period = periods.find((p) => p.id === periodId)!;
  const done = period.state === "closed";

  // Ein zweiter Aufruf (React-Strict-Mode, schneller Tabwechsel) teilt sich die laufende Prüfung.
  const running = useRef<Promise<PeriodReview | null>>(undefined);
  const review = useLoad<PeriodReview | null>(() => {
    if (startedClosed.current) return Promise.resolve(null);
    running.current ??= svc.reviewPeriod(periodId).finally(() => {
      running.current = undefined;
    });
    return running.current;
  }, [svc, periodId]);
  useOnTabActivate(review.reload);
  const [confirming, setConfirming] = useState(false);
  const leftovers = useRef<HTMLDivElement>(null);

  const step: Step = done ? "done" : confirming ? "confirm" : "check";
  const range = t("reports.range", { from: formatDate(period.from), to: formatDate(period.to) });
  const checks = review.data?.checks ?? [];
  const errors = checks.filter((c) => c.status === "error").length;
  const warnings = checks.filter((c) => c.status === "warning").length;

  const cancel = async () => {
    try {
      await svc.cancelReview(periodId);
    } finally {
      tab.close();
    }
  };

  const [exporting, setExporting] = useState(false);
  const exportReport = async () => {
    setExporting(true);
    try {
      saveFile(await svc.exportPeriodReport(periodId));
    } catch {
      toast.show({ tone: "error", title: t("reports.exportFailed") });
    } finally {
      setExporting(false);
    }
  };

  const act = (kind: "leftovers" | "drafts" | "vat") => {
    if (kind === "leftovers") leftovers.current?.focus();
    else if (kind === "vat") openTab(REPORT_TABS.vat, { key: REPORT_TABS.vat });
    else
      openTab(INVOICE_LIST_TAB, { key: `${INVOICE_LIST_TAB}-draft`, params: { status: "draft" } });
  };

  // Die Person bestätigt die MwSt-Abrechnung; die API prüft danach neu, die Anzeige lädt den neuen Stand.
  const confirmVat = async (confirmed: boolean) => {
    try {
      await svc.confirmVat(periodId, confirmed);
      review.reload();
    } catch {
      toast.show({ tone: "error", title: t("closing.vat.confirmFailed") });
    }
  };

  return (
    <>
      <div className="crumb">
        {t("reports.crumb")} / {t("reports.tab.closing")}
      </div>
      <div className="phead">
        <h1>{t("closing.title", { period: period.label })}</h1>
        {done ? <Badge tone="ok">{t("closing.closed")}</Badge> : <Badge>{range}</Badge>}
        <span className="phead__spacer" />
        <div className="rep-actions">
          {done ? (
            <>
              <Button icon="download" disabled={exporting} onClick={() => void exportReport()}>
                {t("closing.report")}
              </Button>
              <Button
                variant="primary"
                icon="list"
                onClick={() => openTab(REPORT_TABS.trialBalance, { key: REPORT_TABS.trialBalance })}
              >
                {t("closing.openTrialBalance")}
              </Button>
            </>
          ) : (
            <>
              <Button icon="close" onClick={() => void cancel()}>
                {t("closing.cancel")}
              </Button>
              <Button
                variant="primary"
                icon="chevronRight"
                disabled={review.data == null || errors > 0}
                onClick={() => setConfirming(true)}
              >
                {t("closing.confirm")}
              </Button>
            </>
          )}
        </div>
      </div>
      <Steps current={step} />
      <div className="rep__stack">
        {done ? (
          <Done period={period} periods={periods} today={today} />
        ) : (
          <LoadState load={review}>
            {(r) => (
              <Check
                review={r!}
                errors={errors}
                warnings={warnings}
                onAction={act}
                onConfirmVat={(confirmed) => void confirmVat(confirmed)}
                leftoversRef={leftovers}
              />
            )}
          </LoadState>
        )}
      </div>
      {confirming && review.data && (
        <ConfirmDialog
          period={period}
          review={review.data}
          range={range}
          onCancel={() => setConfirming(false)}
          onClosed={(closed) => {
            setPeriods((list) => list.map((p) => (p.id === closed.id ? closed : p)));
            setConfirming(false);
          }}
          onStale={() => {
            setConfirming(false);
            review.reload();
          }}
        />
      )}
    </>
  );
}

// ---- Schritt 1: Prüfung --------------------------------------------------------------------

function Check({
  review,
  errors,
  warnings,
  onAction,
  onConfirmVat,
  leftoversRef,
}: {
  review: PeriodReview;
  errors: number;
  warnings: number;
  onAction: (kind: "leftovers" | "drafts" | "vat") => void;
  onConfirmVat: (confirmed: boolean) => void;
  leftoversRef: RefObject<HTMLDivElement | null>;
}) {
  const columns: ReportColumn<PeriodCheck>[] = [
    {
      key: "check",
      header: t("closing.col.check"),
      width: "470px",
      cell: (c) => <b>{c.title}</b>,
    },
    {
      key: "result",
      header: t("closing.col.result"),
      wrap: true,
      cell: (c) => keepAmounts(c.result),
    },
    {
      key: "status",
      header: t("closing.col.status"),
      width: "129px",
      cell: (c) => <Badge tone={TONES[c.status]}>{t(`closing.status.${c.status}`)}</Badge>,
    },
    {
      key: "action",
      header: t("closing.col.action"),
      width: "195px",
      cell: (c) =>
        c.action ? (
          <Button small icon="chevronRight" onClick={() => onAction(c.action!.kind)}>
            {c.action.label}
          </Button>
        ) : null,
    },
  ];
  const { leftovers, stats } = review;

  return (
    <>
      {errors > 0 ? (
        <Message tone="error" title={t("closing.error.title")}>
          {t("closing.error.text")}
        </Message>
      ) : warnings > 0 ? (
        <Message tone="warning" title={tp("closing.warn.title", warnings)} />
      ) : (
        <Message tone="ok" title={t("closing.ok.title")} />
      )}
      <div>
        <ReportTable
          label={t("closing.checks")}
          columns={columns}
          rows={review.checks}
          rowKey={(c) => c.id}
          after={(c) =>
            c.confirm && (
              <Checkbox
                label={t("closing.vat.confirm")}
                checked={c.confirm.confirmed}
                onChange={(e) => onConfirmVat(e.target.checked)}
              />
            )
          }
        />
      </div>
      {(leftovers || stats) && (
        <div className="rep__split">
          {leftovers && (
            <div className="rep__col--closing" ref={leftoversRef} tabIndex={-1}>
              <LeftoverPanel rows={leftovers} />
            </div>
          )}
          {stats && (
            <div className="rep__col">
              <Panel title={t("closing.stats")}>
                <dl className="kv rep__kv--stats">
                  <dt>{t("closing.stats.bookings")}</dt>
                  <dd>{stats.bookings}</dd>
                  <dt>{t("closing.stats.invoices")}</dt>
                  <dd>{stats.invoices}</dd>
                  <dt>{t("closing.stats.payments")}</dt>
                  <dd>{stats.payments}</dd>
                  <dt>{t("closing.stats.reversals")}</dt>
                  <dd>{stats.reversals}</dd>
                </dl>
              </Panel>
            </div>
          )}
        </div>
      )}
    </>
  );
}

type LeftoverLine = Leftover | "total";

function LeftoverPanel({ rows }: { rows: readonly Leftover[] }) {
  const total = rows.reduce((s, r) => s + r.amountCents, 0);
  const columns: ReportColumn<LeftoverLine>[] = [
    {
      key: "valuta",
      header: t("closing.col.valuta"),
      width: "107px",
      cell: (r) => (r === "total" ? "" : formatDate(r.valueDate)),
    },
    {
      key: "payer",
      header: t("closing.col.payer"),
      wrap: true,
      cell: (r) => (r === "total" ? t("reports.total") : <b>{r.payer}</b>),
    },
    {
      key: "amount",
      header: t("closing.col.amount"),
      width: "129px",
      align: "right",
      cell: (r) => formatChf(r === "total" ? total : r.amountCents),
    },
    {
      key: "reason",
      header: t("closing.col.reason"),
      width: "217px",
      cell: (r) => (r === "total" ? "" : r.reason),
    },
  ];
  return (
    <Panel title={t("closing.leftovers")} flush>
      <ReportTable
        label={t("closing.leftovers.label")}
        columns={columns}
        rows={[...rows, "total" as const]}
        rowKey={(r) => (r === "total" ? "total" : r.id)}
        rowClass={(r) => (r === "total" ? "tot" : undefined)}
      />
    </Panel>
  );
}

// ---- Schritt 2: Bestätigung ----------------------------------------------------------------

function ConfirmDialog({
  period,
  review,
  range,
  onCancel,
  onClosed,
  onStale,
}: {
  period: PeriodInfo;
  review: PeriodReview;
  range: string;
  onCancel: () => void;
  onClosed: (period: PeriodInfo) => void;
  onStale: () => void;
}) {
  const svc = useReports();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const warned = review.checks.filter((c) => c.status === "warning");
  const names = warned.map((c) => c.warningName ?? c.title).join(", ");

  const submit = async () => {
    if (typed !== period.label || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      onClosed(await svc.closePeriod(period.id));
    } catch (e) {
      // Ein Konflikt (Prüfung veraltet, frühere Periode offen) hat den Stand der Periode geändert: neu prüfen.
      if (e instanceof ReportsError && e.status === 409) onStale();
      else setError(t("closing.failed"));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("closing.dialog.title", { period: period.label })}
      width={560}
      onClose={onCancel}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button data-autofocus onClick={onCancel}>
            {t("ui.cancel")}
          </Button>
          <Button
            variant="primary"
            icon="lock"
            type="submit"
            disabled={typed !== period.label || busy}
          >
            {t("closing.dialog.submit")}
          </Button>
        </>
      }
    >
      <dl className="kv rep__kv--short">
        <dt>{t("closing.dialog.period")}</dt>
        <dd>{range}</dd>
        {review.stats && (
          <>
            <dt>{t("closing.dialog.bookings")}</dt>
            <dd>{review.stats.bookings}</dd>
          </>
        )}
        <dt>{t("closing.dialog.warnings")}</dt>
        <dd>
          {warned.length > 0 ? `${warned.length} (${names})` : t("closing.dialog.noWarnings")}
        </dd>
      </dl>
      <Message
        tone="warning"
        title={t("closing.dialog.lock.title", { month: monthName(period.to) })}
      >
        {t("closing.dialog.lock.text", { next: monthName(nextDay(period.to)) })}
      </Message>
      {error && <Message tone="error">{error}</Message>}
      <TextField
        label={t("closing.dialog.input", { period: period.label })}
        hint={t("closing.dialog.hint")}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        autoComplete="off"
        aria-required="true"
      />
    </Dialog>
  );
}

// ---- Schritt 3: abgeschlossen --------------------------------------------------------------

const rangeOf = (p: PeriodInfo) => {
  const [, fm, fd] = p.from.split("-");
  return `${fd}.${fm}. bis ${formatDate(p.to)}`;
};

function Done({
  period,
  periods,
  today,
}: {
  period: PeriodInfo;
  periods: readonly PeriodInfo[];
  today: string;
}) {
  const stamp = period.closedAt ? formatDateTime(period.closedAt) : undefined;
  const dash = "–";

  const columns: ReportColumn<PeriodInfo>[] = [
    {
      key: "period",
      header: t("closing.col.period"),
      width: "140px",
      cell: (p) => <b>{p.label}</b>,
    },
    { key: "range", header: t("closing.col.range"), width: "184px", cell: (p) => rangeOf(p) },
    {
      key: "bookings",
      header: t("closing.col.bookings"),
      width: "107px",
      align: "right",
      cell: (p) => p.bookings ?? dash,
    },
    {
      key: "state",
      header: t("closing.col.state"),
      width: "180px",
      cell: (p) =>
        p.state === "closed" ? (
          <Badge tone="ok">{t("closing.state.closed")}</Badge>
        ) : p.from > today ? (
          <Badge>{t("closing.state.future")}</Badge>
        ) : (
          <Badge tone="warning">{t("closing.state.open")}</Badge>
        ),
    },
    {
      key: "closedAt",
      header: t("closing.col.closedAt"),
      width: "162px",
      cell: (p) => (p.closedAt ? formatDateTime(p.closedAt) : dash),
    },
    { key: "by", header: t("closing.col.closedBy"), wrap: true, cell: (p) => p.closedBy ?? dash },
  ];

  const side: ReactNode = (
    <div className="rep__col--protocol">
      <div className="rep__gap">
        <Panel title={t("closing.protocol")}>
          <dl className="kv rep__kv--short">
            <dt>{t("closing.protocol.period")}</dt>
            <dd>{period.label}</dd>
            <dt>{t("closing.protocol.closed")}</dt>
            <dd>{stamp ?? dash}</dd>
            <dt>{t("closing.protocol.by")}</dt>
            <dd>{period.closedBy ?? dash}</dd>
            <dt>{t("closing.protocol.warnings")}</dt>
            <dd>{t("closing.protocol.warnings.value", { n: period.warnings })}</dd>
            <dt>{t("closing.protocol.bookings")}</dt>
            <dd>{period.bookings ?? dash}</dd>
          </dl>
        </Panel>
        <Message tone="neutral" title={t("closing.locked.title")}>
          {t("closing.locked.text", {
            month: monthName(period.to),
            next: monthName(nextDay(period.to)),
          })}
        </Message>
      </div>
    </div>
  );

  return (
    <>
      <Message tone="ok" title={t("closing.closed.title", { period: period.label })} />
      <div className="rep__split">
        <div className="rep__col">
          <ReportTable
            label={t("closing.periods")}
            columns={columns}
            rows={periods}
            rowKey={(p) => p.id}
            rowClass={(p) => (p.id === period.id ? "is-selected" : undefined)}
          />
        </div>
        {side}
      </div>
    </>
  );
}
