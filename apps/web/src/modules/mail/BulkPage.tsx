import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../auth/auth";
import { t, tp } from "../../i18n";
import { useCurrentTab, useTabs } from "../../shell/tabs";
import {
  Button,
  Checkbox,
  Dialog,
  Badge,
  Message,
  PageHeader,
  Panel,
  Select,
  TextField,
  useToast,
} from "../../ui";
import { AttachmentRow, useAttachments } from "./ComposePage";
import { combineDateTime, formatDate, formatSize, formatTime, isoDay, isoTime } from "./format";
import { useMailService } from "./mailContext";
import type { ListEntry, MailAccount, PreparedBulk } from "./mailService";
import {
  ActionError,
  Loading,
  LoadError,
  Steps,
  useCloseWhen,
  useTabDirty,
  WithAccount,
} from "./parts";
import { useLoad } from "./useMail";

const PLACEHOLDERS = [
  { token: "[Anrede]", hint: "mail.bulk.ph.anrede", label: "mail.bulk.ph.anrede.label" },
  { token: "[Name]", hint: "mail.bulk.ph.name", label: "mail.bulk.ph.name.label" },
  { token: "[Antwortlink]", hint: "mail.bulk.ph.link", label: "mail.bulk.ph.link.label" },
] as const;

const number = (n: number | null) => (n === null ? "–" : String(n));

/** Die erste Zeile des Textes mit den Werten des ersten Empfängers (Design 7.5, «Vorschau»). */
function previewLine(body: string, entry: ListEntry): string {
  const line = body.split("\n").find((l) => l.trim() !== "") ?? "";
  return line
    .replace(/\[Anrede\]/g, entry.anrede ?? "")
    .replace(/\[Name\]/g, entry.nachname ?? entry.name)
    .replace(/\[Antwortlink\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function BulkBody({ account }: { account: MailAccount }) {
  const service = useMailService();
  const { session } = useAuth();
  const { openTab } = useTabs();
  const tab = useCurrentTab();
  const toast = useToast();
  const [lists, reloadLists] = useLoad((signal) => service.lists(signal), [service]);

  const [step, setStep] = useState<1 | 2>(1);
  const [listId, setListId] = useState(tab.params["listId"] ?? "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<"now" | "planned">("now");
  const tomorrow = useMemo(() => {
    const d = new Date(Date.now() + 86_400_000);
    d.setHours(8, 0, 0, 0);
    return d;
  }, []);
  const [day, setDay] = useState(isoDay(tomorrow));
  const [time, setTime] = useState(isoTime(tomorrow));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<unknown>();
  const [test, setTest] = useState<{ sentAt: string } | null>(null);
  const [prepared, setPrepared] = useState<PreparedBulk | null>(null);
  const [done, setDone] = useState(false);
  const attachments = useAttachments(setActionError);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);

  const list = lists.status === "ready" ? lists.data.find((l) => l.id === listId) : undefined;
  const [sample] = useLoad<ListEntry | null>(
    (signal) => (listId ? service.previewRecipient(listId, signal) : Promise.resolve(null)),
    [service, listId],
  );
  const entry = sample.status === "ready" ? sample.data : null;

  useTabDirty(!done && (subject !== "" || body !== "" || attachments.files.length > 0));
  useCloseWhen(done);
  useEffect(() => tab.setPage(prepared ? 3 : step, 3), [tab, step, prepared]);
  useEffect(() => {
    if (caret.current !== null && bodyRef.current) {
      bodyRef.current.focus();
      bodyRef.current.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  }, [body]);

  const insert = (token: string) => {
    const el = bodyRef.current;
    const at = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? at;
    caret.current = at + token.length;
    setBody(body.slice(0, at) + token + body.slice(end));
  };

  const sendAt = mode === "planned" ? combineDateTime(day, time) : null;
  const input = () => ({
    accountId: account.id,
    listId,
    subject,
    body,
    attachmentIds: attachments.files.map((f) => f.id),
    sendAt,
  });

  const toStep2 = () => {
    const next: Record<string, string> = {};
    if (!listId) next["list"] = t("mail.bulk.error.list");
    if (subject.trim() === "") next["subject"] = t("mail.compose.error.subject");
    if (body.trim() === "") next["body"] = t("mail.compose.error.body");
    setErrors(next);
    if (Object.keys(next).length === 0) setStep(2);
  };

  const sendTest = async () => {
    setActionError(undefined);
    try {
      setTest(await service.testSend(input()));
    } catch (e) {
      setActionError(e);
    }
  };

  const toConfirm = async () => {
    setActionError(undefined);
    if (mode === "planned" && (!sendAt || new Date(sendAt).getTime() <= Date.now())) {
      setErrors({ time: t("mail.bulk.error.time") });
      return;
    }
    setErrors({});
    try {
      const result = await service.prepare(input());
      if (result.confirmed) {
        toast.show({ tone: "ok", title: t("mail.bulk.sentOne") });
        openTab("mail-status", { key: "mail-status" });
        setDone(true);
      } else {
        setPrepared(result);
      }
    } catch (e) {
      setActionError(e);
    }
  };

  const abandon = (campaignId: string) => {
    // Ohne Bestätigung bleibt kein Entwurf zurück.
    void service.cancel(campaignId).catch(() => undefined);
    setPrepared(null);
  };

  if (lists.status === "loading") return <Loading />;
  if (lists.status === "error") return <LoadError load={lists} onRetry={reloadLists} />;

  const plannedAt = t("mail.bulk.when.at", {
    date: formatDate(sendAt ?? tomorrow.toISOString()),
    time: formatTime(sendAt ?? tomorrow.toISOString()),
  });
  const plannedLabel = t("mail.bulk.when.planned", { when: plannedAt });
  const files = attachments.files;
  const totalSize = files.reduce((n, f) => n + f.size, 0);

  const header = (
    <PageHeader
      crumb={t("mail.crumb.bulk")}
      title={t("mail.bulk.title")}
      status={<Badge tone="neutral">{t("mail.bulk.draft")}</Badge>}
      actions={
        <>
          <Button icon="close" onClick={() => setDone(true)}>
            {t("ui.cancel")}
          </Button>
          {step === 1 ? (
            <Button variant="primary" icon="chevronRight" onClick={toStep2}>
              {t("mail.bulk.toStep2")}
            </Button>
          ) : (
            <>
              <Button icon="chevronLeft" onClick={() => setStep(1)}>
                {t("mail.bulk.toStep1")}
              </Button>
              <Button variant="primary" icon="chevronRight" onClick={() => void toConfirm()}>
                {t("mail.bulk.toConfirm")}
              </Button>
            </>
          )}
        </>
      }
    />
  );

  const steps = (
    <Steps
      current={step}
      labels={[t("mail.bulk.step1"), t("mail.bulk.step2"), t("mail.bulk.step3")]}
    />
  );

  return (
    <>
      {header}
      {steps}
      {actionError !== undefined && <ActionError error={actionError} />}
      {step === 1 ? (
        <div className="mail-cols mail-cols--stretch">
          <div className="mail-cols__main mail-form">
            <div className="mail-grid mail-grid--half">
              <TextField label={t("mail.bulk.sender")} value={account.fromAddress} readOnly />
              <Select
                label={t("mail.bulk.list")}
                required
                value={listId}
                error={errors["list"]}
                options={[
                  { value: "", label: t("mail.bulk.list.choose") },
                  ...lists.data.map((l) => ({ value: l.id, label: l.name })),
                ]}
                onChange={(e) => setListId(e.target.value)}
              />
            </div>
            <TextField
              label={t("mail.compose.subject")}
              required
              value={subject}
              error={errors["subject"]}
              autoComplete="off"
              onChange={(e) => setSubject(e.target.value)}
            />
            {errors["body"] && <Message tone="error">{errors["body"]}</Message>}
            <div className="mail-desk mail-desk--inset">
              <div className="mail-paper mail-paper--narrow">
                <textarea
                  name="text"
                  ref={bodyRef}
                  className="mail-paper__text"
                  aria-label={t("mail.compose.body")}
                  aria-invalid={errors["body"] ? true : undefined}
                  rows={Math.max(12, body.split("\n").length + 2)}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </div>
            </div>
          </div>
          <div className="mail-side mail-side--wide">
            <Panel title={t("mail.bulk.recipients")}>
              <dl className="kv mail__kv mail__kv--wide">
                <dt>{t("mail.bulk.list.short")}</dt>
                <dd>{list ? <b>{list.name}</b> : "–"}</dd>
                <dt>{t("mail.bulk.persons")}</dt>
                <dd>{number(list?.persons ?? null)}</dd>
                <dt>{t("mail.bulk.noEmail")}</dt>
                <dd>{number(list?.withoutEmail ?? null)}</dd>
                <dt>{t("mail.bulk.recipientCount")}</dt>
                <dd>
                  <b>{number(list?.recipients ?? null)}</b>
                </dd>
              </dl>
            </Panel>
            <Panel title={t("mail.bulk.placeholders")}>
              {PLACEHOLDERS.map((p) => (
                <div key={p.token} className="mail-ph">
                  <span className="muted mail-ph__text">{t(p.hint)}</span>
                  <Button
                    small
                    aria-label={t("mail.bulk.ph.insertLabel", { name: t(p.label) })}
                    onClick={() => insert(p.token)}
                  >
                    {t("mail.bulk.ph.insert", { token: p.token })}
                  </Button>
                </div>
              ))}
            </Panel>
            <Panel
              title={t("mail.bulk.preview", {
                name: entry?.name ?? "–",
              })}
            >
              {entry && previewLine(body, entry) !== "" ? (
                <b>{previewLine(body, entry)}</b>
              ) : (
                <span className="muted">{t("mail.bulk.preview.none")}</span>
              )}
            </Panel>
          </div>
        </div>
      ) : (
        <div className="mail-cols">
          <div className="mail-cols__main mail-form">
            <Panel
              title={
                files.length > 0
                  ? t("mail.bulk.attach.titleCount", { n: files.length })
                  : t("mail.bulk.attach.title")
              }
            >
              {attachments.picker}
              {files.map((f) => (
                <AttachmentRow key={f.id} file={f} onRemove={() => attachments.remove(f.id)} />
              ))}
              <Button small icon="paperclip" onClick={attachments.pick}>
                {t("mail.attach.add")}
              </Button>
            </Panel>
            <Panel title={t("mail.bulk.test.title")}>
              <TextField label={t("mail.bulk.test.to")} value={session?.email ?? ""} readOnly />
              <div className="mail__action">
                <Button icon="send" onClick={() => void sendTest()}>
                  {t("mail.bulk.test.send")}
                </Button>
              </div>
              {test && (
                <div className="mail__action">
                  <Message tone="ok" title={t("mail.bulk.test.done")}>
                    {t("mail.bulk.test.when", {
                      date: formatDate(test.sentAt),
                      time: formatTime(test.sentAt),
                    })}
                  </Message>
                </div>
              )}
            </Panel>
          </div>
          <div className="mail-side mail-side--when">
            <Panel title={t("mail.bulk.when.title")}>
              <div className="mail-radios" role="radiogroup" aria-label={t("mail.bulk.when.title")}>
                {(["now", "planned"] as const).map((m) => (
                  <label key={m} className="opt">
                    <input
                      type="radio"
                      className="chk-input"
                      name="bulk-when"
                      checked={mode === m}
                      onChange={() => setMode(m)}
                    />
                    <span className="rad" aria-hidden="true" />
                    <span>{m === "now" ? t("mail.bulk.when.now") : plannedLabel}</span>
                  </label>
                ))}
                {mode === "planned" && (
                  <div className="mail-grid mail-grid--half">
                    <TextField
                      label={t("mail.bulk.when.date")}
                      type="date"
                      value={day}
                      error={errors["time"]}
                      onChange={(e) => setDay(e.target.value)}
                    />
                    <TextField
                      label={t("mail.bulk.when.time")}
                      type="time"
                      value={time}
                      onChange={(e) => setTime(e.target.value)}
                    />
                  </div>
                )}
              </div>
            </Panel>
            <Panel title={t("mail.bulk.summary")}>
              <dl className="kv mail__kv">
                <dt>{t("mail.compose.subject")}</dt>
                <dd>{subject}</dd>
                <dt>{t("mail.bulk.list.short")}</dt>
                <dd>{list?.name ?? "–"}</dd>
                <dt>{t("mail.bulk.recipientCount")}</dt>
                <dd>
                  <b>{number(list?.recipients ?? null)}</b>
                </dd>
                <dt>{t("mail.bulk.attach.short")}</dt>
                <dd>
                  {files.length > 0
                    ? t("mail.bulk.attach.summary", {
                        files: tp("mail.bulk.files", files.length),
                        size: formatSize(totalSize),
                      })
                    : t("mail.bulk.attach.none")}
                </dd>
                <dt>{t("mail.bulk.test.short")}</dt>
                <dd>
                  {test
                    ? t("mail.bulk.test.sentAt", { time: formatTime(test.sentAt) })
                    : t("mail.bulk.test.notSent")}
                </dd>
              </dl>
            </Panel>
          </div>
        </div>
      )}
      {prepared && (
        <ConfirmBulk
          prepared={prepared}
          subject={subject}
          listName={list?.name ?? ""}
          attachmentNames={files.map((f) => f.filename)}
          when={mode === "planned" ? plannedAt : t("mail.bulk.when.immediately")}
          planned={mode === "planned"}
          tested={test !== null}
          onCancel={() => abandon(prepared.campaignId)}
          onConfirmed={() => {
            toast.show({
              tone: "ok",
              title: mode === "planned" ? t("mail.bulk.scheduled") : t("mail.bulk.started"),
            });
            openTab(mode === "planned" ? "mail-plan" : "mail-status", {
              key: mode === "planned" ? "mail-plan" : "mail-status",
            });
            setPrepared(null);
            setDone(true);
          }}
        />
      )}
    </>
  );
}

interface ConfirmBulkProps {
  prepared: PreparedBulk;
  subject: string;
  listName: string;
  attachmentNames: string[];
  when: string;
  planned: boolean;
  tested: boolean;
  onCancel: () => void;
  onConfirmed: () => void;
}

/** Bestätigung vor dem Massenversand (Design 7.7): Testmail geprüft, Empfängerzahl eintippen. */
function ConfirmBulk({
  prepared,
  subject,
  listName,
  attachmentNames,
  when,
  planned,
  tested,
  onCancel,
  onConfirmed,
}: ConfirmBulkProps) {
  const service = useMailService();
  const [checked, setChecked] = useState(false);
  const [count, setCount] = useState("");
  const [errors, setErrors] = useState<{ checked?: string; count?: string }>({});
  const [actionError, setActionError] = useState<unknown>();
  const missing = Object.entries(prepared.missingValues);
  const n = prepared.recipientCount;

  const submit = async () => {
    const next: typeof errors = {};
    if (!checked) next.checked = t("mail.confirm.error.checked");
    if (count.trim() !== String(n)) next.count = t("mail.confirm.error.count");
    setErrors(next);
    if (Object.keys(next).length > 0 || !prepared.confirmationToken) return;
    setActionError(undefined);
    try {
      await service.confirm(prepared.campaignId, prepared.confirmationToken);
      onConfirmed();
    } catch (e) {
      setActionError(e);
    }
  };

  return (
    <Dialog
      title={t(planned ? "mail.confirm.title.planned" : "mail.confirm.title.now", { n })}
      width={560}
      onClose={onCancel}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button data-autofocus onClick={onCancel}>
            {t("ui.cancel")}
          </Button>
          <Button variant="primary" icon="send" type="submit">
            {t(planned ? "mail.confirm.submit.planned" : "mail.confirm.submit.now")}
          </Button>
        </>
      }
    >
      <div className="mail-dialog">
        <Message tone="warning" title={t("mail.confirm.warn")}>
          {planned ? t("mail.confirm.warn.planned", { when }) : t("mail.confirm.warn.now")}
        </Message>
        {missing.map(([name, count]) => (
          <Message key={name} tone="warning">
            {t("mail.confirm.missing", { name, n: count })}
          </Message>
        ))}
        <dl className="kv mail__kv mail__kv--wide">
          <dt>{t("mail.compose.subject")}</dt>
          <dd>{subject}</dd>
          <dt>{t("mail.bulk.list.short")}</dt>
          <dd>{listName}</dd>
          <dt>{t("mail.bulk.attach.short")}</dt>
          <dd>
            {attachmentNames.length > 0 ? attachmentNames.join(", ") : t("mail.bulk.attach.none")}
          </dd>
          <dt>{t("mail.confirm.when")}</dt>
          <dd>{when}</dd>
        </dl>
        <Checkbox
          checked={checked}
          label={t("mail.confirm.checked")}
          onChange={(e) => setChecked(e.target.checked)}
        />
        {!tested && <span className="muted">{t("mail.confirm.untested")}</span>}
        {errors.checked && <Message tone="error">{errors.checked}</Message>}
        <TextField
          label={t("mail.confirm.count")}
          required
          value={count}
          inputMode="numeric"
          autoComplete="off"
          className="mail-dialog__count"
          error={errors.count}
          hint={t("mail.confirm.count.hint", { n })}
          onChange={(e) => setCount(e.target.value)}
        />
        {actionError !== undefined && <ActionError error={actionError} />}
      </div>
    </Dialog>
  );
}

/** Multiversand in drei Schritten (Design 7.5 bis 7.7). */
export function BulkPage() {
  return <WithAccount current="bulk">{(account) => <BulkBody account={account} />}</WithAccount>;
}
