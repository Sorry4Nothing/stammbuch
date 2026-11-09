import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../../auth/auth";
import { t, tp } from "../../i18n";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Icon,
  Message,
  PageHeader,
  TextArea,
  formatDateTime as formatDateTimeSeconds,
  newErrorId,
  useToast,
  type Column,
  type IconName,
  type Tone,
} from "../../ui";
import { formatDateTime } from "./format";
import { createHttpRotationService } from "./httpRotationService";
import { ApiError, CodeRejectedError } from "./model";
import { RotationDialog } from "./RotationDialog";
import {
  ROTATION_KINDS,
  RotationLimitError,
  RotationLockedError,
  RotationServiceContext,
  type RotationKind,
  type RotationOutcome,
  type RotationRun,
  type RotationService,
  type RotationStatus,
} from "./rotationModel";
import { LoadFailed, useLoad } from "./shared";
import "./rotation.css";

/** Ab so vielen Monaten ohne Lauf erscheint die Warnung (Design 10.8). */
const OLD_AFTER_MONTHS = 12;
/** Während des Laufs fragt die Seite den Stand ab, um den Schritt anzuzeigen. */
const POLL_MS = 3000;
/** Wartezeit, wenn die API beim Limit keine nennt (Fenster des Limits: eine Minute). */
const DEFAULT_WAIT_S = 60;

/** Tausendertrennung wie im Design («1’248»), unabhängig von der ICU-Version des Browsers. */
const number = { format: (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "’") };
const objects = (n: number) => tp("chef.rot.objects", n, { n: number.format(n) });
const kindName = (k: RotationKind) => t(k === "mail" ? "chef.rot.kind.mail" : "chef.rot.kind.totp");
const kindIcon = (k: RotationKind): IconName => (k === "mail" ? "mail" : "shield");
/** «02.10.2026 · 10:14» */
const stamp = (iso: string) => formatDateTime(iso).replace(" ", " · ");

/** Der eingesetzte Dienst (Tests) oder sonst die HTTP-Umsetzung mit der Sitzung des Benutzers. */
export function useRotationService(): RotationService {
  const injected = useContext(RotationServiceContext);
  const { service, markExpired } = useAuth();
  return useMemo(
    () =>
      injected ??
      createHttpRotationService({
        csrfToken: () => service.csrfToken?.() ?? null,
        onUnauthorized: markExpired,
      }),
    [injected, service, markExpired],
  );
}

type Phase =
  | { name: "idle" }
  | {
      name: "running";
      before: RotationStatus;
      startedAt: number;
      /** Beginn jedes Schritts (Millisekunden); der letzte Eintrag ist der laufende Schritt. */
      stepAt: number[];
    }
  | { name: "done"; run: RotationRun; minutes: number; times: Record<RotationKind, string> }
  | { name: "failed"; message: string; limit: boolean; wait: number; at: Date; errorId: string };

const configuredKinds = (s: RotationStatus) => ROTATION_KINDS.filter((k) => s[k].configured);

function olderThan(iso: string, now: number, months: number) {
  const limit = new Date(now);
  limit.setMonth(limit.getMonth() - months);
  const at = new Date(iso);
  return !Number.isNaN(at.getTime()) && at < limit;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function NoneUnreadable() {
  return (
    <span className="rot-ok">
      <Icon name="check" size={16} />
      <span>{t("chef.rot.unreadable.none")}</span>
    </span>
  );
}

function KindPanel({
  kind,
  badge,
  busy,
  children,
}: {
  kind: RotationKind;
  badge: ReactNode;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="panel" aria-busy={busy ? true : undefined}>
      <h2>
        <Icon name={kindIcon(kind)} />
        {kindName(kind)}
        <span className="rot-spacer" />
        {badge}
      </h2>
      <div className="panel__body">
        <div className="rot-stack">
          <span className="muted">
            {t(kind === "mail" ? "chef.rot.kind.mail.sub" : "chef.rot.kind.totp.sub")}
          </span>
          {children}
        </div>
      </div>
    </section>
  );
}

/** Kopiert Text in die Zwischenablage und meldet das Ergebnis. */
function useCopy() {
  const toast = useToast();
  return async (text: string, many: boolean) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.show({ tone: "ok", title: t(many ? "chef.rot.copied.many" : "chef.rot.copied.one") });
    } catch {
      toast.show({ tone: "error", title: t("chef.rot.copyFailed"), text });
    }
  };
}

/** Schlüsselrotation (Design 10.7 bis 10.16): Stand je Art, Lauf mit Bestätigung, Ergebnis, Fehler und Limit. */
export function RotationPage() {
  const service = useRotationService();
  const { now } = useAuth();
  const copy = useCopy();
  const status = useLoad((signal) => service.status(signal), [service]);
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [dialog, setDialog] = useState<{ error?: string } | null>(null);
  const [left, setLeft] = useState(0);
  const notice = useRef<HTMLDivElement>(null);
  const s = status.data;

  // Nach dem Start, dem Ende oder einem Fehler liegt der Fokus auf der Statusmeldung (die Schaltfläche ist gesperrt).
  useEffect(() => {
    if (phase.name !== "idle") notice.current?.focus();
  }, [phase.name]);

  // Schritt des Laufs: eine Art ist fertig, sobald ihr «Letzter Lauf» neuer ist als vor dem Start.
  useEffect(() => {
    if (phase.name !== "running") return;
    const id = setInterval(() => {
      service.status().then(
        (fresh) =>
          setPhase((p) => {
            if (p.name !== "running") return p;
            const kinds = configuredKinds(p.before);
            const finished = kinds.filter((k) => fresh[k].lastRunAt !== p.before[k].lastRunAt);
            const step = Math.min(finished.length + 1, kinds.length);
            return step > p.stepAt.length ? { ...p, stepAt: [...p.stepAt, Date.now()] } : p;
          }),
        () => undefined,
      );
    }, POLL_MS);
    return () => clearInterval(id);
  }, [phase.name, service]);

  // Wartezeit nach dem Limit: «Erneut laden» wird erst danach frei.
  useEffect(() => {
    if (phase.name !== "failed") return;
    setLeft(phase.wait);
    if (phase.wait <= 0) return;
    const id = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(id);
  }, [phase]);

  const reset = () => {
    setPhase({ name: "idle" });
    status.reload();
  };

  const start = async (code: string) => {
    if (!s) return;
    const before = structuredClone(s);
    const startedAt = Date.now();
    setDialog(null);
    setPhase({ name: "running", before, startedAt, stepAt: [startedAt] });
    try {
      const run = await service.run(code);
      const finishedAt = new Date();
      const fresh = await service.status().catch(() => null);
      const times = Object.fromEntries(
        ROTATION_KINDS.map((k) => {
          const at = fresh?.[k].lastRunAt;
          return [k, at && at !== before[k].lastRunAt ? at : finishedAt.toISOString()];
        }),
      ) as Record<RotationKind, string>;
      const minutes = Math.max(1, Math.ceil((finishedAt.getTime() - startedAt) / 60_000));
      setPhase({ name: "done", run, minutes, times });
    } catch (error) {
      if (error instanceof CodeRejectedError || error instanceof RotationLockedError) {
        setPhase({ name: "idle" });
        setDialog({
          error: t(
            error instanceof RotationLockedError
              ? "chef.reset.locked"
              : "chef.reset.err.codeInvalid",
          ),
        });
        return;
      }
      const wait =
        error instanceof RotationLimitError ? (error.retryAfterSeconds ?? DEFAULT_WAIT_S) : 0;
      const status429 =
        error instanceof RotationLimitError || (error instanceof ApiError && error.status === 429);
      setPhase({
        name: "failed",
        limit: status429,
        wait,
        at: new Date(),
        errorId: newErrorId(),
        message: status429
          ? t("chef.rot.err.msg.429")
          : error instanceof ApiError
            ? error.status === 409
              ? t("chef.rot.err.msg.409")
              : t("chef.rot.err.msg.status", { status: error.status })
            : t("chef.rot.err.msg.network"),
      });
    }
  };

  if (status.failed) {
    return (
      <>
        <PageHeader crumb={crumb()} title={t("chef.rot.title")} />
        <LoadFailed onRetry={status.reload} />
      </>
    );
  }
  if (!s) {
    return (
      <>
        <PageHeader crumb={crumb()} title={t("chef.rot.title")} />
        <div className="ca-state">
          <span className="muted is-loading" role="status">
            {t("chef.loading")}
          </span>
        </div>
      </>
    );
  }

  const kinds = configuredKinds(s);
  const done = phase.name === "done" ? phase : null;
  const outcomes = done ? ROTATION_KINDS.flatMap((k) => (done.run[k] ? [done.run[k]] : [])) : [];
  const aborted = outcomes.some((o) => o.aborted);
  const failedIds = done
    ? ROTATION_KINDS.flatMap((k) => (done.run[k]?.failed ?? []).map((id) => ({ id, kind: k })))
    : [];
  const unreadable = ROTATION_KINDS.flatMap((k) => s[k].unreadable.map((id) => ({ id, kind: k })));
  const neverRun = ROTATION_KINDS.every((k) => s[k].lastRunAt === null);
  const missing = ROTATION_KINDS.filter((k) => !s[k].configured);
  const old =
    phase.name === "idle" &&
    kinds.some((k) => {
      const at = s[k].lastRunAt;
      return at !== null && olderThan(at, now, OLD_AFTER_MONTHS);
    });

  // ---------- Kopfzeile ----------
  let action: ReactNode;
  const open = () => setDialog({});
  if (phase.name === "running") {
    action = (
      <Button variant="primary" icon="clock" disabled aria-disabled="true">
        {t("chef.rot.running")}
      </Button>
    );
  } else if (phase.name === "failed" || kinds.length === 0) {
    action = (
      <Button variant="primary" icon="refresh" disabled aria-disabled="true">
        {t("chef.rot.start")}
      </Button>
    );
  } else {
    const label =
      done && !aborted && failedIds.length > 0
        ? t("chef.rot.restart")
        : kinds.length < ROTATION_KINDS.length
          ? t("chef.rot.startOnly", { kind: kindName(kinds[0]!) })
          : t("chef.rot.start");
    action = (
      <Button variant="primary" icon="refresh" onClick={open}>
        {label}
      </Button>
    );
  }

  // ---------- Inhalt je Zustand ----------
  const idlePanel = (k: RotationKind) => {
    const st = s[k];
    const ok = st.configured;
    return (
      <KindPanel
        key={k}
        kind={k}
        badge={
          ok ? (
            <Badge tone="ok">
              <Icon name="check" size={12} />
              {t("chef.rot.configured")}
            </Badge>
          ) : (
            <Badge tone="warning">
              <Icon name="warning" size={12} />
              {t("chef.rot.notConfigured")}
            </Badge>
          )
        }
      >
        <dl className="kv">
          <Row label={t("chef.rot.lastRun")}>
            {st.lastRunAt ? (
              <span className="num">{stamp(st.lastRunAt)}</span>
            ) : (
              <span className="muted">{t("chef.rot.noRun")}</span>
            )}
          </Row>
          <Row label={t("chef.rot.unreadable")}>
            {st.unreadable.length > 0 ? (
              <Badge tone="error">
                <Icon name="warning" size={12} />
                {t("chef.rot.unreadable.count", { n: st.unreadable.length })}
              </Badge>
            ) : st.lastRunAt ? (
              <NoneUnreadable />
            ) : (
              <span className="muted">{t("chef.rot.unreadable.unchecked")}</span>
            )}
          </Row>
        </dl>
        {!ok && (
          <Button
            icon="ban"
            className="rot-self"
            disabled
            aria-disabled="true"
            aria-describedby={`rot-nk-${k}`}
          >
            {t("chef.rot.notPossible")}
          </Button>
        )}
      </KindPanel>
    );
  };

  const runningPanel = (k: RotationKind, p: Extract<Phase, { name: "running" }>) => {
    if (!s[k].configured) return idlePanel(k);
    const steps = configuredKinds(p.before);
    const index = steps.indexOf(k) + 1;
    const current = p.stepAt.length;
    const state = index < current ? "done" : index === current ? "running" : "waiting";
    const begun = p.stepAt[index - 1];
    return (
      <KindPanel
        key={k}
        kind={k}
        busy
        badge={
          <Badge tone="neutral">
            <Icon name="clock" size={12} />
            {t("chef.rot.step", { n: index, total: steps.length })}
          </Badge>
        }
      >
        <dl className="kv">
          <Row label={t("chef.rot.state")}>
            {state === "done" ? (
              <Badge tone="ok">
                <Icon name="check" size={12} />
                {t("chef.rot.state.done")}
              </Badge>
            ) : (
              <Badge tone="neutral">
                <Icon name="clock" size={12} />
                {t(state === "running" ? "chef.rot.state.running" : "chef.rot.state.waiting")}
              </Badge>
            )}
          </Row>
          <Row label={t("chef.rot.started")}>
            {begun !== undefined ? (
              <span className="num">{stamp(new Date(begun).toISOString())}</span>
            ) : (
              <span className="muted">{t("chef.rot.notYet")}</span>
            )}
          </Row>
        </dl>
        {index === 1 && (
          <div
            className="rot-steps"
            role="progressbar"
            aria-label={t("chef.rot.progress")}
            aria-valuemin={0}
            aria-valuemax={steps.length}
            aria-valuenow={current}
            aria-valuetext={t("chef.rot.stepValue", {
              n: current,
              total: steps.length,
              what: kindName(steps[current - 1] ?? k),
            })}
          >
            {steps.map((step, i) => (
              <span key={step} className={i < current ? "is-on" : undefined} />
            ))}
          </div>
        )}
      </KindPanel>
    );
  };

  const resultPanel = (k: RotationKind, d: Extract<Phase, { name: "done" }>) => {
    const o: RotationOutcome | null = d.run[k];
    const time = <span className="num">{stamp(d.times[k])}</span>;
    let tone: Tone = "neutral";
    let icon: IconName = "clock";
    let label = t("chef.rot.badge.notStarted");
    let rows: ReactNode;
    if (!o) {
      rows = (
        <>
          <Row label={t("chef.rot.saved")}>
            <span className="num">{objects(0)}</span>
          </Row>
          <Row label={t("chef.rot.abortedLabel")}>
            <Badge tone="neutral">
              <Icon name="clock" size={12} />
              {t("chef.rot.notStarted")}
            </Badge>
          </Row>
          <Row label={t("chef.rot.time")}>
            <span className="muted">{t("chef.rot.notStarted")}</span>
          </Row>
        </>
      );
    } else if (o.aborted) {
      [tone, icon, label] = ["warning", "ban", t("chef.rot.badge.aborted")];
      rows = (
        <>
          <Row label={t("chef.rot.saved")}>
            <span className="num">{objects(o.rotated)}</span>
          </Row>
          <Row label={t("chef.rot.abortedLabel")}>
            <Badge tone="warning">
              <Icon name="ban" size={12} />
              {t("chef.rot.yes")}
            </Badge>
          </Row>
          <Row label={t("chef.rot.time")}>{time}</Row>
        </>
      );
    } else if (o.failed.length > 0) {
      [tone, icon, label] = ["warning", "warning", t("chef.rot.badge.errors")];
      rows = (
        <>
          <Row label={t("chef.rot.saved")}>
            <span className="num">{objects(o.rotated)}</span>
          </Row>
          <Row label={t("chef.rot.failed")}>
            <Badge tone="error">
              <Icon name="warning" size={12} />
              {objects(o.failed.length)}
            </Badge>
          </Row>
          <Row label={t("chef.rot.time")}>{time}</Row>
        </>
      );
    } else {
      [tone, icon, label] = ["ok", "check", t("chef.rot.badge.ok")];
      rows = (
        <>
          <Row label={t("chef.rot.result")}>
            <b className="num">{objects(o.rotated)}</b> {t("chef.rot.resaved")}
          </Row>
          <Row label={t("chef.rot.time")}>{time}</Row>
          <Row label={t("chef.rot.unreadable")}>
            <NoneUnreadable />
          </Row>
        </>
      );
    }
    return (
      <KindPanel
        key={k}
        kind={k}
        badge={
          <Badge tone={tone}>
            <Icon name={icon} size={12} />
            {label}
          </Badge>
        }
      >
        <dl className="kv">{rows}</dl>
      </KindPanel>
    );
  };

  const panels = ROTATION_KINDS.map((k) =>
    phase.name === "running"
      ? runningPanel(k, phase)
      : phase.name === "done"
        ? resultPanel(k, phase)
        : idlePanel(k),
  );

  const idList = (
    rows: { id: string; kind: RotationKind }[],
    title: string,
    withCount: boolean,
  ) => {
    const columns: Column<{ id: string; kind: RotationKind }>[] = [
      {
        key: "id",
        header: t("chef.rot.list.id"),
        nowrap: true,
        cell: (r) => <b className="num">{r.id}</b>,
      },
      {
        key: "kind",
        header: t("chef.rot.list.kind"),
        cell: (r) => (
          <Badge tone="neutral">
            <Icon name={kindIcon(r.kind)} size={12} />
            {kindName(r.kind)}
          </Badge>
        ),
      },
      {
        key: "copy",
        header: t("chef.rot.list.action"),
        srOnlyHeader: true,
        width: "129px",
        nowrap: true,
        cell: (r) => (
          <Button
            small
            icon="copy"
            aria-label={t("chef.rot.list.copyOne", { id: r.id })}
            onClick={() => void copy(r.id, false)}
          >
            {t("chef.rot.list.copy")}
          </Button>
        ),
      },
    ];
    return (
      <section className="panel">
        <h2>
          {withCount ? t("chef.rot.list.titleN", { n: rows.length }) : title}
          {rows.length > 0 && (
            <span className="panel__actions">
              <Button
                small
                icon="copy"
                onClick={() => void copy(rows.map((r) => r.id).join("\n"), true)}
              >
                {t("chef.rot.list.copyAll")}
              </Button>
            </span>
          )}
        </h2>
        <DataTable
          label={rows.length > 0 ? t("chef.rot.list.title") : t("chef.rot.list.empty")}
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          empty={
            <EmptyState
              title={t("chef.rot.empty.title")}
              text={t("chef.rot.empty.text")}
              actions={
                kinds.length > 0 ? (
                  <Button variant="primary" icon="refresh" onClick={open}>
                    {t("chef.rot.start")}
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </section>
    );
  };

  const what = (
    <Message tone="neutral" title={t("chef.rot.what.title")}>
      {t("chef.rot.what.text")}
    </Message>
  );
  const seeOnly = (
    <Message tone="neutral" icon="lock" title={t("chef.rot.seeOnly.title")}>
      {t("chef.rot.seeOnly.text")}
    </Message>
  );

  const body: ReactNode[] = [];
  if (phase.name === "idle" || phase.name === "failed") {
    if (phase.name === "failed") {
      body.push(
        <div key="alert" ref={notice} tabIndex={-1} className="rot-notice">
          <Message
            tone="error"
            title={t(phase.limit ? "chef.rot.err.limit.title" : "chef.rot.err.other.title")}
          >
            {phase.limit
              ? tp("chef.rot.err.limit.text", phase.wait > 0 ? phase.wait : undefined, {
                  s: phase.wait,
                })
              : t("chef.rot.err.other.text")}
          </Message>
        </div>,
      );
    } else if (old) {
      body.push(
        <Message key="old" tone="warning" icon="clock" title={t("chef.rot.old.title")}>
          {t("chef.rot.old.text")}
        </Message>,
      );
    }
    body.push(
      <div key="grid" className="grid ca-grid2">
        {panels}
      </div>,
    );
    if (phase.name === "failed") {
      body.push(
        <section key="support" className="panel">
          <h2>{t("error.supportTitle")}</h2>
          <div className="panel__body">
            <div className="rot-stack rot-stack--wide">
              <dl className="kv kv--support">
                <Row label={t("error.detail.message")}>{phase.message}</Row>
                <Row label={t("error.detail.time")}>
                  <span className="num">{formatDateTimeSeconds(phase.at)}</span>
                </Row>
                <Row label={t("error.detail.id")}>
                  <span className="num">{phase.errorId}</span>
                </Row>
              </dl>
              <div className="rot-actions">
                <Button
                  icon="refresh"
                  disabled={left > 0}
                  aria-disabled={left > 0 ? "true" : undefined}
                  onClick={reset}
                >
                  {left > 0 ? t("chef.rot.err.reloadIn", { s: left }) : t("error.retry")}
                </Button>
                <Button icon="copy" onClick={() => void copy(phase.errorId, false)}>
                  {t("error.copyId")}
                </Button>
              </div>
              {left > 0 && <span className="muted">{t("chef.rot.err.reloadNote")}</span>}
            </div>
          </div>
        </section>,
      );
    } else {
      for (const k of missing) {
        const others = kinds.filter((x) => x !== k);
        body.push(
          <div key={`nk-${k}`} id={`rot-nk-${k}`}>
            <Message tone="warning" title={t("chef.rot.nk.title", { kind: kindName(k) })}>
              {t("chef.rot.nk.text")}{" "}
              {others.length > 0
                ? t("chef.rot.nk.only", { kind: kindName(others[0]!) })
                : t("chef.rot.nk.none")}
            </Message>
          </div>,
        );
      }
      if (unreadable.length > 0) {
        body.push(<div key="list">{idList(unreadable, t("chef.rot.list.title"), true)}</div>);
        body.push(
          <Message key="meaning" tone="neutral" title={t("chef.rot.meaning.title")}>
            {t("chef.rot.meaning.text")}
          </Message>,
        );
      } else if (neverRun) {
        body.push(<div key="list">{idList([], t("chef.rot.list.title"), false)}</div>);
        body.push(<div key="what">{what}</div>);
      } else if (missing.length > 0) {
        body.push(<div key="what">{what}</div>);
      } else {
        body.push(<div key="what">{what}</div>, <div key="see">{seeOnly}</div>);
      }
    }
  } else if (phase.name === "running") {
    const steps = configuredKinds(phase.before);
    const current = phase.stepAt.length;
    const k = steps[current - 1] ?? "mail";
    body.push(
      <div key="run" ref={notice} tabIndex={-1} className="rot-notice">
        <Message tone="neutral" title={t("chef.rot.run.title")}>
          {t(k === "mail" ? "chef.rot.run.text.mail" : "chef.rot.run.text.totp", {
            step: current,
            total: steps.length,
          })}
        </Message>
      </div>,
      <div key="grid" className="grid ca-grid2">
        {panels}
      </div>,
      <div key="what">{what}</div>,
    );
  } else {
    const d = phase;
    const lead = aborted
      ? ({ tone: "warning", title: "chef.rot.aborted.title" } as const)
      : failedIds.length > 0
        ? ({ tone: "warning", title: "chef.rot.errors.title" } as const)
        : ({ tone: "ok", title: "chef.rot.done.title" } as const);
    body.push(
      <div key="lead" ref={notice} tabIndex={-1} className="rot-notice">
        <Message tone={lead.tone} title={t(lead.title)}>
          {aborted
            ? tp("chef.rot.aborted.text", d.minutes)
            : failedIds.length > 0
              ? tp("chef.rot.errors.text", failedIds.length, { n: number.format(failedIds.length) })
              : t("chef.rot.done.text")}
        </Message>
      </div>,
      <div key="grid" className="grid ca-grid2">
        {panels}
      </div>,
    );
    if (aborted) {
      body.push(
        <section key="cont" className="panel">
          <h2>{t("chef.rot.cont.title")}</h2>
          <div className="panel__body">
            <div className="rot-stack">
              <span>{t("chef.rot.cont.text")}</span>
              <div className="rot-actions">
                <Button variant="primary" icon="refresh" onClick={open}>
                  {t("chef.rot.restart")}
                </Button>
                <Button onClick={reset}>{t("chef.rot.cont.overview")}</Button>
              </div>
            </div>
          </div>
        </section>,
      );
    } else if (failedIds.length > 0) {
      body.push(
        <div key="help" className="grid ca-grid2">
          <section className="panel">
            <h2>{t("chef.rot.next.title")}</h2>
            <div className="panel__body">
              <ol className="rot-list">
                <li>{t("chef.rot.next.1")}</li>
                <li>{t("chef.rot.next.2")}</li>
                <li>{t("chef.rot.next.3")}</li>
              </ol>
            </div>
          </section>
          <section className="panel">
            <h2>{t("chef.rot.ids.title")}</h2>
            <div className="panel__body">
              <div className="rot-stack">
                <TextArea
                  label={t("chef.rot.ids.label")}
                  hint={t("chef.rot.ids.hint")}
                  className="num"
                  readOnly
                  rows={3}
                  value={failedIds.map((r) => r.id).join("\n")}
                />
                <Button
                  icon="copy"
                  className="rot-self"
                  onClick={() => void copy(failedIds.map((r) => r.id).join("\n"), true)}
                >
                  {t("chef.rot.ids.copy")}
                </Button>
              </div>
            </div>
          </section>
        </div>,
      );
    } else {
      body.push(<div key="see">{seeOnly}</div>);
    }
  }

  return (
    <>
      <PageHeader crumb={crumb()} title={t("chef.rot.title")} actions={action} />
      <div className="rot-page">{body}</div>
      {dialog && (
        <RotationDialog
          kinds={kinds}
          {...(dialog.error ? { error: dialog.error } : {})}
          onClose={() => setDialog(null)}
          onSubmit={(code) => void start(code)}
        />
      )}
    </>
  );
}

const crumb = () => `${t("chef.crumb.root")} / ${t("chef.rot.title")}`;
