import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../../auth/auth";
import { t } from "../../i18n";
import {
  Button,
  DataTable,
  EmptyState,
  Message,
  PageHeader,
  Panel,
  Select,
  TextField,
  useToast,
  type Column,
  type Tone,
} from "../../ui";
import type { IconName } from "../../ui";
import { IconBadge, LoadError, req, useLoad } from "./common";
import {
  TEST_STAGE_COUNT,
  type MailDraft,
  type StageStatus,
  type TestOutcome,
  type TestStage,
} from "./model";
import { useSettings } from "./service";

type Errors = Partial<Record<keyof MailDraft, string>>;
type Run =
  { phase: "idle" } | { phase: "running"; stage: number } | { phase: "done"; outcome: TestOutcome };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SECURITY = [
  { value: "tls", label: t("settings.mail.tls") },
  { value: "starttls", label: t("settings.mail.starttls") },
];
const STAGE_KEYS = ["imapReach", "tls", "imapLogin", "smtpReach", "smtpLogin", "testmail"] as const;

const STAGE_BADGE: Record<StageStatus, { tone: Tone; icon: IconName }> = {
  ok: { tone: "ok", icon: "check" },
  running: { tone: "warning", icon: "refresh" },
  pending: { tone: "neutral", icon: "clock" },
  failed: { tone: "error", icon: "warning" },
  skipped: { tone: "neutral", icon: "ban" },
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function validate(d: MailDraft, passwordRequired: boolean): Errors {
  const e: Errors = {};
  const blank = t("settings.error.required");
  for (const k of ["email", "username", "senderName", "imapHost", "smtpHost"] as const) {
    if (!d[k].trim()) e[k] = blank;
  }
  if (!e.email && !EMAIL.test(d.email.trim())) e.email = t("auth.forgot.emailFormat");
  if (passwordRequired && !d.password) e.password = t("settings.mail.passwordNeeded");
  for (const k of ["imapPort", "smtpPort"] as const) {
    const n = Number(d[k]);
    if (!/^\d{1,5}$/.test(d[k].trim()) || n < 1 || n > 65535) e[k] = t("settings.mail.portInvalid");
  }
  return e;
}

/** Stufen während des Laufs: bis zur laufenden Stufe erledigt, danach ausstehend. */
const runningStages = (stage: number): TestStage[] =>
  Array.from({ length: TEST_STAGE_COUNT }, (_, i) => ({
    status: i < stage ? "ok" : i === stage ? "running" : "pending",
  }));

/** Einstellungen / Mailkonto (Boards 9.5 bis 9.8). Das Passwort wird nie angezeigt und nie vorbelegt. */
export function MailPage({
  onDirtyChange,
  registerSave,
}: {
  onDirtyChange: (dirty: boolean) => void;
  registerSave: (save: (() => Promise<boolean>) | null) => void;
}) {
  const service = useSettings();
  const { session } = useAuth();
  const toast = useToast();
  const [state, reload] = useLoad(service.loadMail.bind(service), [service]);
  const [draft, setDraft] = useState<MailDraft | null>(null);
  const [base, setBase] = useState<MailDraft | null>(null);
  const [stored, setStored] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [run, setRun] = useState<Run>({ phase: "idle" });
  const [failure, setFailure] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (state.status !== "ready") return;
    setDraft(state.data.draft);
    setBase(state.data.draft);
    setStored(state.data.stored);
  }, [state]);

  const dirty = Boolean(draft && base && JSON.stringify(draft) !== JSON.stringify(base));
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => abort.current?.abort(), []);

  const update = (patch: Partial<MailDraft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch)) delete next[k as keyof MailDraft];
      return next;
    });
    // Geänderte Angaben machen das letzte Testergebnis ungültig.
    setRun({ phase: "idle" });
  };

  /** Nach dem Speichern bleibt nur das Konto auf dem Server; das Passwort-Feld ist wieder leer. */
  const markStored = (d: MailDraft) => {
    const clean = { ...d, password: "" };
    setDraft(clean);
    setBase(clean);
    setStored(true);
  };

  const check = (needPassword: boolean): MailDraft | null => {
    if (!draft) return null;
    const found = validate(draft, needPassword);
    setErrors(found);
    return Object.keys(found).length > 0 ? null : draft;
  };

  const save = async (): Promise<boolean> => {
    const d = check(true);
    if (!d) return false;
    try {
      await service.saveMail(d);
      markStored(d);
      setFailure(false);
      toast.show({ tone: "ok", title: t("settings.saved") });
      return true;
    } catch {
      setFailure(true);
      return false;
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    registerSave(() => saveRef.current());
    return () => registerSave(null);
  }, [registerSave]);

  const test = async () => {
    // Ohne Passwort lässt sich nur das gespeicherte Konto prüfen, nie geänderte Angaben.
    const d = check(!stored || dirty);
    if (!d) return;
    const controller = new AbortController();
    abort.current = controller;
    setFailure(false);
    setRun({ phase: "running", stage: 0 });
    try {
      const outcome = await service.testMail(d, {
        signal: controller.signal,
        onStage: (stage) => setRun({ phase: "running", stage }),
      });
      if (controller.signal.aborted) return;
      if (outcome.persisted) markStored(d);
      setRun({ phase: "done", outcome });
    } catch {
      if (controller.signal.aborted) return;
      setRun({ phase: "idle" });
      setFailure(true);
    }
  };

  const cancel = () => {
    abort.current?.abort();
    setRun({ phase: "idle" });
  };

  const running = run.phase === "running";
  const outcome = run.phase === "done" ? run.outcome : null;
  const failed = outcome?.failedAt !== undefined;
  const succeeded = outcome !== null && !failed;
  const authFailed = outcome?.failedAt === 2 || outcome?.failedAt === 4;
  const stages: TestStage[] | null = running
    ? runningStages(run.stage)
    : outcome
      ? outcome.stages
      : null;

  const badge: ReactNode = running ? (
    <IconBadge tone="warning" icon="refresh">
      {t("settings.mail.state.running")}
    </IconBadge>
  ) : failed ? (
    <IconBadge tone="error" icon="warning">
      {t("settings.mail.state.failed")}
    </IconBadge>
  ) : succeeded ? (
    <IconBadge tone="ok" icon="check">
      {t("settings.mail.state.ok")}
    </IconBadge>
  ) : (
    <IconBadge tone="neutral" icon="clock">
      {t("settings.mail.state.idle")}
    </IconBadge>
  );

  const actions = running ? (
    <>
      <Button icon="close" onClick={cancel}>
        {t("settings.mail.cancel")}
      </Button>
      <Button icon="save" disabled>
        {t("settings.save")}
      </Button>
    </>
  ) : (
    <>
      <Button
        variant={succeeded ? "secondary" : "primary"}
        icon="refresh"
        onClick={() => void test()}
        disabled={!draft}
      >
        {t(failed || succeeded ? "settings.mail.retest" : "settings.mail.test")}
      </Button>
      <Button
        variant={succeeded ? "primary" : "secondary"}
        icon="save"
        onClick={() => void save()}
        disabled={!draft}
      >
        {t("settings.save")}
      </Button>
    </>
  );

  const stageLabel = (i: number) => `${i + 1} ${t(`settings.mail.stage.${STAGE_KEYS[i]!}`)}`;
  const columns: Column<number>[] = [
    {
      key: "stage",
      header: t("settings.mail.col.stage"),
      cell: (i) => (outcome?.failedAt === i ? <b>{stageLabel(i)}</b> : stageLabel(i)),
    },
    {
      key: "status",
      header: t("settings.mail.col.status"),
      width: "151px",
      nowrap: true,
      cell: (i) => {
        const s = stages![i]!;
        const b = STAGE_BADGE[s.status];
        return (
          <IconBadge tone={b.tone} icon={b.icon}>
            {t(`settings.mail.stageState.${s.status}`)}
          </IconBadge>
        );
      },
    },
    {
      key: "ms",
      header: t("settings.mail.col.duration"),
      width: "63px",
      align: "right",
      cell: (i) => {
        const ms = stages![i]!.ms;
        return ms === undefined ? "–" : seconds(ms);
      },
    },
  ];

  const readOnly = running;
  const star = (label: string) => (readOnly ? label : req(label));
  const mark = readOnly ? undefined : ("true" as const);

  const security = (id: string, key: "imapSecurity" | "smtpSecurity") => (
    <Select
      id={id}
      label={star(t("settings.mail.security"))}
      value={draft![key]}
      options={SECURITY}
      disabled={readOnly}
      className={readOnly ? "in--ro" : undefined}
      aria-required={mark}
      onChange={(e) => update({ [key]: e.target.value as "tls" | "starttls" })}
    />
  );

  const failReason =
    outcome?.failedAt === undefined
      ? ""
      : t(
          outcome.failedAt === 1
            ? "settings.mail.reason.tls"
            : outcome.failedAt === 5
              ? "settings.mail.reason.testmail"
              : authFailed
                ? "settings.mail.reason.auth"
                : "settings.mail.reason.connect",
        );
  const unchecked =
    outcome?.failedAt === undefined || outcome.failedAt >= TEST_STAGE_COUNT - 1
      ? ""
      : ` ${t(
          outcome.failedAt === TEST_STAGE_COUNT - 2
            ? "settings.mail.skipped.one"
            : "settings.mail.skipped.many",
          { from: outcome.failedAt + 2, to: TEST_STAGE_COUNT },
        )}`;

  const sentTime = outcome?.sentAt
    ? `${String(outcome.sentAt.getHours()).padStart(2, "0")}:${String(outcome.sentAt.getMinutes()).padStart(2, "0")}`
    : "";

  const done = stages?.filter((s) => s.status === "ok").length ?? 0;
  const live = stages?.filter((s) => s.status === "running").length ?? 0;
  const pct = (n: number) => `${((n / TEST_STAGE_COUNT) * 100).toFixed(2)}%`;

  if (state.status === "ready" && state.data.unavailable) {
    return (
      <div className="page">
        <PageHeader
          crumb={`${t("settings.title")} / ${t("settings.nav.mail")}`}
          title={t("settings.nav.mail")}
        />
        <EmptyState title={t("settings.mail.unavailable")} />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        crumb={`${t("settings.title")} / ${t("settings.nav.mail")}`}
        title={t("settings.nav.mail")}
        status={badge}
        actions={actions}
      />
      {state.status === "error" ? (
        <LoadError state={state} onRetry={reload} />
      ) : !draft ? (
        <p className="set__sub muted">{t("settings.loading")}</p>
      ) : (
        <>
          {failure && (
            <div className="set__alert">
              <Message tone="error" title={t("settings.mail.errorTitle")}>
                {t("settings.mail.errorText")}
              </Message>
            </div>
          )}
          <div className="set__cols set__cols--top">
            <div className="set__col">
              <Panel title={t("settings.mail.mailbox")}>
                <div className="set__stack">
                  <TextField
                    label={star(t("settings.mail.email"))}
                    value={draft.email}
                    error={errors.email}
                    readOnly={readOnly}
                    autoComplete="email"
                    aria-required={mark}
                    onChange={(e) => update({ email: e.target.value })}
                  />
                  <TextField
                    label={star(t("settings.mail.username"))}
                    value={draft.username}
                    error={errors.username}
                    readOnly={readOnly}
                    autoComplete="username"
                    aria-required={mark}
                    onChange={(e) => update({ username: e.target.value })}
                  />
                  <TextField
                    type="password"
                    label={star(t("settings.mail.password"))}
                    hint={t("settings.mail.passwordHint")}
                    value={draft.password}
                    error={
                      errors.password ??
                      (authFailed ? t("settings.mail.authFieldError") : undefined)
                    }
                    readOnly={readOnly}
                    autoComplete="new-password"
                    aria-required={mark}
                    onChange={(e) => update({ password: e.target.value })}
                  />
                  <TextField
                    label={star(t("settings.mail.senderName"))}
                    value={draft.senderName}
                    error={errors.senderName}
                    readOnly={readOnly}
                    aria-required={mark}
                    onChange={(e) => update({ senderName: e.target.value })}
                  />
                </div>
              </Panel>
            </div>
            <div className="set__col">
              <Panel title={t("settings.mail.server")}>
                <div className="set__stack">
                  <TextField
                    label={star(t("settings.mail.imap"))}
                    value={draft.imapHost}
                    error={errors.imapHost}
                    readOnly={readOnly}
                    aria-required={mark}
                    onChange={(e) => update({ imapHost: e.target.value })}
                  />
                  <div className="set__pair">
                    <TextField
                      mono
                      label={star(t("settings.mail.port"))}
                      value={draft.imapPort}
                      error={errors.imapPort}
                      readOnly={readOnly}
                      aria-required={mark}
                      onChange={(e) => update({ imapPort: e.target.value })}
                    />
                    {security("mail-imap-security", "imapSecurity")}
                  </div>
                  <TextField
                    label={star(t("settings.mail.smtp"))}
                    value={draft.smtpHost}
                    error={errors.smtpHost}
                    readOnly={readOnly}
                    aria-required={mark}
                    onChange={(e) => update({ smtpHost: e.target.value })}
                  />
                  <div className="set__pair">
                    <TextField
                      mono
                      label={star(t("settings.mail.port"))}
                      value={draft.smtpPort}
                      error={errors.smtpPort}
                      readOnly={readOnly}
                      aria-required={mark}
                      onChange={(e) => update({ smtpPort: e.target.value })}
                    />
                    {security("mail-smtp-security", "smtpSecurity")}
                  </div>
                </div>
              </Panel>
            </div>
          </div>
          <div className="set__cols set__cols--gap">
            <div className="set__col">
              <Panel title={t("settings.mail.testTitle")} flush={Boolean(stages)}>
                {stages ? (
                  <DataTable
                    label={t("settings.mail.stagesLabel")}
                    columns={columns}
                    rows={STAGE_KEYS.map((_, i) => i)}
                    rowKey={String}
                  />
                ) : (
                  <ol className="set__steps">
                    {STAGE_KEYS.map((key, i) => (
                      <li key={key} className="opt">
                        <b className="num set__stepno">{i + 1}</b>
                        <span>{t(`settings.mail.stage.${key}`)}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </Panel>
            </div>
            <div className="set__col">
              {running && (
                <>
                  <Message
                    tone="warning"
                    title={t("settings.mail.runningTitle", { n: run.stage + 1 })}
                  />
                  <div
                    className="set__bar"
                    role="img"
                    aria-label={t("settings.mail.barLabel", {
                      done,
                      stage: run.stage + 1,
                      pending: TEST_STAGE_COUNT - done - live,
                    })}
                  >
                    <span className="set__bar-ok" style={{ width: pct(done) }} />
                    <span className="set__bar-run" style={{ width: pct(live) }} />
                    <span
                      className="set__bar-rest"
                      style={{ width: pct(TEST_STAGE_COUNT - done - live) }}
                    />
                  </div>
                </>
              )}
              {failed && outcome?.failedAt !== undefined && (
                <Message
                  tone="error"
                  title={t("settings.mail.failTitle", {
                    n: outcome.failedAt + 1,
                    stage: t(`settings.mail.stage.${STAGE_KEYS[outcome.failedAt]!}`),
                  })}
                >
                  {failReason}
                  {unchecked}
                </Message>
              )}
              {succeeded && (
                <Message tone="ok" title={t("settings.mail.okTitle")}>
                  {t("settings.mail.okText", {
                    n: TEST_STAGE_COUNT,
                    time: sentTime,
                    email: session?.email ?? draft.email,
                  })}
                </Message>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
