import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "../../auth/auth";
import { t, tp } from "../../i18n";
import {
  Badge,
  Button,
  DataTable,
  DateField,
  Dialog,
  EmptyState,
  ErrorState,
  Icon,
  Message,
  PageHeader,
  TextField,
  dateError,
  focusField,
  newErrorId,
  parseDateInput,
  useToast,
  type Column,
  type Tone,
} from "../../ui";
import { useOnTabActivate } from "../../shell/useOnTabActivate";
import { formatDate } from "../start/format";
import { TITLE_MAX, type Task, type TaskList, type TaskStatus } from "./model";
import { useTasks } from "./service";
import "./tasks.css";

type State =
  | { status: "loading"; list?: TaskList }
  | { status: "ready"; list: TaskList }
  | { status: "error"; errorId: string; at: Date };

/** Heutiges Datum als JJJJ-MM-TT (Ortszeit), vergleichbar mit den Fälligkeiten. */
function isoDay(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const rowKey = (r: Task) => r.id;

/** Aufgaben: offene und erledigte, anlegen, erledigen. Gleicher Aufbau wie die Personenliste (Kopf, Werkzeugleiste, Tabelle). */
export function TasksPage() {
  const svc = useTasks();
  const toast = useToast();
  const { now } = useAuth();
  const [filter, setFilter] = useState<TaskStatus>("open");
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const day = isoDay(now);

  useEffect(() => {
    const abort = new AbortController();
    setState((s) => ({
      status: "loading",
      ...(s.status !== "error" && s.list ? { list: s.list } : {}),
    }));
    svc.list(filter, abort.signal).then(
      (list) => !abort.signal.aborted && setState({ status: "ready", list }),
      () =>
        !abort.signal.aborted &&
        setState({ status: "error", errorId: newErrorId(), at: new Date() }),
    );
    return () => abort.abort();
  }, [svc, filter, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  useOnTabActivate(reload);

  const undo = async (task: Task) => {
    try {
      await svc.reopen(task.id);
      toast.show({ tone: "ok", title: t("tasks.reopen.toast"), text: task.title });
    } catch {
      toast.show({ tone: "error", title: t("tasks.reopen.error"), text: task.title });
    }
    reload();
  };

  const complete = async (task: Task) => {
    setBusy(task.id);
    try {
      await svc.complete(task.id);
      toast.show({
        tone: "ok",
        title: t("tasks.done.toast"),
        text: task.title,
        action: { label: t("ui.undo"), onClick: () => void undo(task) },
      });
      reload();
    } catch {
      toast.show({ tone: "error", title: t("tasks.done.error"), text: task.title });
    } finally {
      setBusy(null);
    }
  };

  const status = (due: string): { tone: Tone; label: string } =>
    due < day
      ? { tone: "error", label: t("tasks.status.overdue") }
      : due === day
        ? { tone: "warning", label: t("tasks.status.today") }
        : { tone: "neutral", label: t("tasks.status.open") };

  const done = filter === "done";
  const actionColumn: Column<Task> = {
    key: "action",
    header: t("tasks.col.action"),
    srOnlyHeader: true,
    width: "120px",
    cell: (r) => (
      <Button
        small
        icon="check"
        disabled={busy === r.id}
        aria-label={t("tasks.done.label", { title: r.title })}
        onClick={() => void complete(r)}
      >
        {t("tasks.done.button")}
      </Button>
    ),
  };
  const columns: Column<Task>[] = [
    { key: "task", header: t("tasks.col.task"), cell: (r) => <b>{r.title}</b> },
    {
      key: "due",
      header: t("tasks.col.due"),
      width: "107px",
      nowrap: true,
      cell: (r) => formatDate(r.due),
    },
    done
      ? {
          key: "doneAt",
          header: t("tasks.col.doneAt"),
          width: "140px",
          nowrap: true,
          cell: (r) => (r.doneAt ? formatDate(isoDay(Date.parse(r.doneAt))) : "–"),
        }
      : {
          key: "status",
          header: t("tasks.col.status"),
          width: "110px",
          nowrap: true,
          cell: (r) => {
            const s = status(r.due);
            return <Badge tone={s.tone}>{s.label}</Badge>;
          },
        },
    ...(done ? [] : [actionColumn]),
  ];

  const list = state.status === "error" ? undefined : state.list;
  const loading = state.status === "loading";

  return (
    <div className="page">
      <PageHeader
        title={t("tasks.title")}
        actions={
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            {t("tasks.new")}
          </Button>
        }
      />
      <div className="tasks__tool">
        <span className="sel tasks__filter">
          <select
            name="filter"
            className="in"
            aria-label={t("tasks.col.status")}
            value={filter}
            onChange={(e) => setFilter(e.target.value as TaskStatus)}
          >
            <option value="open">{t("tasks.filter.open")}</option>
            <option value="done">{t("tasks.filter.done")}</option>
          </select>
          <Icon name="chevronDown" />
        </span>
        <span className="tasks__spacer" />
        <span className="muted" aria-live="polite">
          {list && !loading ? tp("tasks.count", list.total) : ""}
        </span>
      </div>

      <div className="tasks__body">
        {state.status === "error" ? (
          <>
            <div className="state-page__alert">
              <Message tone="error" title={t("tasks.error.title")}>
                {t("tasks.error.text")}
              </Message>
            </div>
            <ErrorState at={state.at} errorId={state.errorId} onRetry={reload} />
          </>
        ) : (
          <>
            <DataTable
              label={done ? t("tasks.table.done") : t("tasks.table.open")}
              columns={columns}
              rows={list?.items ?? []}
              rowKey={rowKey}
              empty={
                loading ? (
                  <span role="status" className="is-loading">
                    {t("tasks.loading")}
                  </span>
                ) : done ? (
                  <EmptyState title={t("tasks.empty.done.title")} />
                ) : (
                  <EmptyState
                    title={t("tasks.empty.open.title")}
                    actions={
                      <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                        {t("tasks.new")}
                      </Button>
                    }
                  />
                )
              }
            />
            {list && list.total > list.items.length && (
              <p className="muted tasks__more">
                {t("tasks.truncated", { n: list.items.length, total: list.total })}
              </p>
            )}
          </>
        )}
      </div>

      {creating && (
        <CreateDialog
          today={day}
          onClose={() => setCreating(false)}
          onCreate={async (input) => {
            await svc.create(input);
            setCreating(false);
            toast.show({ tone: "ok", title: t("tasks.create.toast"), text: input.title });
            setFilter("open");
            reload();
          }}
        />
      )}
    </div>
  );
}

const CONTROL = /\p{Cc}/u;

function CreateDialog({
  today,
  onClose,
  onCreate,
}: {
  today: string;
  onClose: () => void;
  onCreate: (input: { title: string; due: string }) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState(formatDate(today));
  const [errors, setErrors] = useState<{ title?: string; due?: string }>({});
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (locked.current) return;
    const trimmed = title.trim();
    const next: typeof errors = {};
    if (!trimmed || CONTROL.test(trimmed)) next.title = t("tasks.create.error.title");
    const parsed = parseDateInput(due, { shortYear: true });
    const dueIso = "iso" in parsed ? parsed.iso : null;
    if (!dueIso) {
      next.due = due.trim() ? dateError(due, { shortYear: true }) : t("tasks.create.error.due");
    }
    setErrors(next);
    setFailed(false);
    if (next.title || !dueIso) {
      focusField(next.title ? "task-title" : "task-due");
      return;
    }
    locked.current = true;
    setBusy(true);
    try {
      await onCreate({ title: trimmed, due: dueIso });
    } catch {
      setFailed(true);
      locked.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("tasks.create.title")}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button variant="primary" type="submit" icon="plus" disabled={busy}>
            {t("tasks.create.submit")}
          </Button>
        </>
      }
    >
      {failed && <Message tone="error" title={t("tasks.create.error.save")} />}
      <div className="tasks__form">
        <TextField
          id="task-title"
          label={t("tasks.create.field.title")}
          required
          maxLength={TITLE_MAX}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          error={errors.title}
          data-autofocus
        />
        <DateField
          id="task-due"
          label={t("tasks.create.field.due")}
          placeholder={t("tasks.create.due.placeholder")}
          required
          value={due}
          onChange={setDue}
          error={errors.due}
        />
      </div>
    </Dialog>
  );
}
