import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/auth";
import { t } from "../../i18n";
import { useTabs } from "../../shell/tabs";
import { useOnTabActivate } from "../../shell/useOnTabActivate";
import {
  Badge,
  Button,
  DataTable,
  ErrorState,
  Message,
  newErrorId,
  PageHeader,
  Panel,
  type Column,
  type Tone,
} from "../../ui";
import { MODULE_IDS } from "../types";
import { formatChf, formatDate } from "./format";
import {
  useStartService,
  type StartData,
  type StartEvent,
  type StartOpenItem,
  type StartTask,
} from "./startService";

type State =
  | { status: "loading" }
  | { status: "ready"; data: StartData }
  | { status: "error"; errorId: string; at: Date };

const dateFmt = new Intl.DateTimeFormat("de-CH", {
  weekday: "long",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/** «Montag, 02.11.2026» */
function today(now: number): string {
  const parts = Object.fromEntries(
    dateFmt.formatToParts(new Date(now)).map((p) => [p.type, p.value]),
  );
  return `${parts.weekday}, ${parts.day}.${parts.month}.${parts.year}`;
}

/** Heutiges Datum als JJJJ-MM-TT (Ortszeit), vergleichbar mit den Fälligkeiten. */
function isoDay(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const rowKey = (r: { id: string }) => r.id;
const byDue = <T extends { due: string }>(a: T, b: T) => a.due.localeCompare(b.due);
const sortedByDue = { key: "due", direction: "asc" } as const;

/**
 * Startseite (Design 2.1): offene Aufgaben, offene Posten und anstehende Events. Die Daten liefert
 * der `StartService` (API); ohne Einträge zeigt die Seite den Leer-Zustand.
 */
export function StartPage() {
  const { now } = useAuth();
  const { moduleOpener } = useTabs();
  const service = useStartService();
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    setState({ status: "loading" });
    service.load(abort.signal).then(
      (data) => !abort.signal.aborted && setState({ status: "ready", data }),
      () =>
        !abort.signal.aborted &&
        setState({ status: "error", errorId: newErrorId(), at: new Date() }),
    );
    return () => abort.abort();
  }, [service, attempt]);
  useOnTabActivate(() => setAttempt((n) => n + 1));

  const day = isoDay(now);
  const data = state.status === "ready" ? state.data : undefined;
  const tasks = useMemo(() => [...(data?.tasks ?? [])].sort(byDue), [data]);
  const items = useMemo(() => [...(data?.openItems ?? [])].sort(byDue), [data]);
  const events = useMemo(
    () =>
      [...(data?.events ?? [])].sort((a, b) =>
        `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`),
      ),
    [data],
  );

  const status = (due: string): { tone: Tone; label: string } =>
    due < day
      ? { tone: "error", label: t("start.status.overdue") }
      : due === day
        ? { tone: "warning", label: t("start.status.today") }
        : { tone: "neutral", label: t("start.status.open") };

  const taskColumns: Column<StartTask>[] = [
    { key: "task", header: t("start.tasks.task"), cell: (r) => r.title },
    {
      key: "due",
      header: t("start.tasks.due"),
      width: "107px",
      nowrap: true,
      cell: (r) => formatDate(r.due),
    },
    {
      key: "status",
      header: t("start.tasks.status"),
      width: "96px",
      nowrap: true,
      cell: (r) => {
        const s = status(r.due);
        return <Badge tone={s.tone}>{s.label}</Badge>;
      },
    },
  ];

  const itemColumns: Column<StartOpenItem>[] = [
    {
      key: "invoice",
      header: t("start.items.invoice"),
      width: "131px",
      nowrap: true,
      cell: (r) => r.invoiceNumber,
    },
    { key: "debtor", header: t("start.items.debtor"), cell: (r) => r.debtor },
    {
      key: "amount",
      header: t("start.items.amount"),
      width: "133px",
      align: "right",
      cell: (r) => formatChf(r.amountCents, r.currency),
    },
    {
      key: "due",
      header: t("start.items.due"),
      width: "113px",
      nowrap: true,
      cell: (r) => formatDate(r.due),
    },
  ];

  const eventColumns: Column<StartEvent>[] = [
    { key: "event", header: t("start.events.event"), cell: (r) => <b>{r.title}</b> },
    {
      key: "date",
      header: t("start.events.date"),
      width: "184px",
      nowrap: true,
      cell: (r) => `${formatDate(r.date)} · ${r.time}`,
    },
    {
      key: "yes",
      header: t("start.events.yes"),
      width: "107px",
      align: "right",
      cell: (r) => r.confirmed,
    },
    {
      key: "deadline",
      header: t("start.events.deadline"),
      width: "162px",
      nowrap: true,
      cell: (r) => (r.deadline ? formatDate(r.deadline) : "–"),
    },
  ];

  const currencies = [...new Set(items.map((i) => i.currency ?? "CHF"))];
  const loading = state.status === "loading";
  const empty = <span className="muted">{t(loading ? "start.loading" : "start.empty")}</span>;
  const title = (
    key: "start.tasks.title" | "start.items.title" | "start.events.title",
    n: number,
  ) => (data ? `${t(key)} (${n})` : t(key));

  const newPerson = moduleOpener(MODULE_IDS.people, "new");
  const newInvoice = moduleOpener(MODULE_IDS.invoices, "new");
  const allTasks = moduleOpener(MODULE_IDS.tasks, "nav");
  const allItems = moduleOpener(MODULE_IDS.accounting, "nav");
  const calendar = moduleOpener(MODULE_IDS.calendar, "nav");
  const link = (open: (() => void) | undefined, label: string) =>
    open && (
      <Button small onClick={open}>
        {label}
      </Button>
    );

  return (
    <div className="page">
      <PageHeader
        title={t("start.title")}
        sub={today(now)}
        actions={
          <>
            {newPerson && (
              <Button icon="plus" onClick={newPerson}>
                {t("start.createPerson")}
              </Button>
            )}
            {newInvoice && (
              <Button variant="primary" icon="invoice" onClick={newInvoice}>
                {t("start.createInvoice")}
              </Button>
            )}
          </>
        }
      />
      {state.status === "error" ? (
        <>
          <div className="state-page__alert">
            <Message tone="error" title={t("start.error.title")}>
              {t("start.error.text")}
            </Message>
          </div>
          <ErrorState
            message={t("start.error.message")}
            at={state.at}
            errorId={state.errorId}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        </>
      ) : (
        <div className="page__body">
          <div className="grid grid--two">
            <Panel
              title={title("start.tasks.title", tasks.length)}
              flush
              actions={link(allTasks, t("start.tasks.all"))}
            >
              <DataTable
                label={t("start.tasks.title")}
                columns={taskColumns}
                rows={tasks}
                rowKey={rowKey}
                sort={sortedByDue}
                empty={empty}
              />
            </Panel>
            <Panel
              title={title("start.items.title", items.length)}
              flush
              actions={link(allItems, t("start.items.all"))}
            >
              <DataTable
                label={
                  items.length > 0 && items.every((i) => i.due < day)
                    ? t("start.items.labelOverdue")
                    : t("start.items.title")
                }
                columns={itemColumns}
                rows={items}
                rowKey={rowKey}
                sort={sortedByDue}
                empty={empty}
                totalRow={
                  items.length > 0
                    ? [
                        t("start.items.total"),
                        null,
                        // Verschiedene Währungen lassen sich nicht addieren.
                        currencies.length === 1
                          ? formatChf(
                              items.reduce((sum, i) => sum + i.amountCents, 0),
                              currencies[0],
                            )
                          : "–",
                        null,
                      ]
                    : undefined
                }
              />
            </Panel>
          </div>
          <Panel
            title={title("start.events.title", events.length)}
            flush
            actions={link(calendar, t("start.events.all"))}
          >
            <DataTable
              label={t("start.events.title")}
              columns={eventColumns}
              rows={events}
              rowKey={rowKey}
              sort={{ key: "date", direction: "asc" }}
              empty={empty}
            />
          </Panel>
        </div>
      )}
    </div>
  );
}
