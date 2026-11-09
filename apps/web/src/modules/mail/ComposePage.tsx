import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { useCurrentTab } from "../../shell/tabs";
import { Button, Message, PageHeader, Panel, TextField, useToast } from "../../ui";
import { formatDate, formatDateTime, formatSize, formatTime, parseAddress } from "./format";
import { useMailService } from "./mailContext";
import {
  MAIL_FOLDERS,
  MailServiceError,
  type AttachmentRef,
  type MailAccount,
  type MailFolder,
  type MailMessage,
} from "./mailService";
import {
  ActionError,
  Facts,
  FileTag,
  Loading,
  LoadError,
  useCloseWhen,
  useTabDirty,
  WithAccount,
} from "./parts";
import { addressText } from "./ReadPage";
import { useLoad } from "./useMail";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Anhänge eines Entwurfs: Auswahl einer Datei, Liste, Entfernen. */
export function useAttachments(onError: (e: unknown) => void) {
  const service = useMailService();
  const [files, setFiles] = useState<AttachmentRef[]>([]);
  const input = useRef<HTMLInputElement>(null);

  const add = async (list: FileList | null) => {
    const file = list?.[0];
    if (input.current) input.current.value = "";
    if (!file) return;
    try {
      if (file.size > MAX_ATTACHMENT_BYTES) throw new MailServiceError("tooLarge");
      const ref = await service.uploadAttachment(file);
      setFiles((f) => [...f, ref]);
    } catch (e) {
      onError(e);
    }
  };
  const remove = (id: string) => setFiles((f) => f.filter((x) => x.id !== id));
  const pick = () => input.current?.click();
  const picker = (
    <input
      name="file"
      ref={input}
      type="file"
      className="visually-hidden"
      tabIndex={-1}
      aria-label={t("mail.attach.file")}
      onChange={(e) => void add(e.target.files)}
    />
  );
  return { files, remove, pick, picker };
}

/** Anhang mit Schaltfläche zum Entfernen. */
export function AttachmentRow({ file, onRemove }: { file: AttachmentRef; onRemove: () => void }) {
  return (
    <div className="mail-attachment">
      <FileTag name={file.filename} size={formatSize(file.size)} />
      <span className="mail-attachment__spacer" />
      <Button
        variant="ghost"
        icon="trash"
        aria-label={t("mail.attach.remove", { name: file.filename })}
        onClick={onRemove}
      />
    </div>
  );
}

type Mode = "new" | "reply";

function ComposeBody({
  account,
  mode,
  folder,
  uid,
  orig,
}: {
  account: MailAccount;
  mode: Mode;
  folder: MailFolder;
  uid: number;
  /** Das Original bei einer Antwort; `null` bei einer neuen Mail. */
  orig: MailMessage | null;
}) {
  const service = useMailService();
  const toast = useToast();
  const tab = useCurrentTab();
  // Parameter «to»: Empfänger, den ein anderes Modul (z. B. Personen) vorgibt.
  const presetTo = orig ? "" : (tab.params["to"] ?? "");
  const [to, setTo] = useState(orig ? addressText(orig.from) : presetTo);
  const [subject, setSubject] = useState(
    orig ? (/^re:/i.test(orig.subject) ? orig.subject : `Re: ${orig.subject}`) : "",
  );
  const [body, setBody] = useState("");
  const [errors, setErrors] = useState<{ to?: string; subject?: string; body?: string }>({});
  const [actionError, setActionError] = useState<unknown>();
  const [done, setDone] = useState(false);
  const attachments = useAttachments(setActionError);
  const reply = mode === "reply";
  // Kennung des Entwurfs auf dem Server: jedes weitere «Entwurf speichern» ersetzt ihn, statt eine Kopie anzulegen.
  const draftId = useRef<string | null>(null);
  const savingDraft = useRef(false);

  // Bei der Antwort kommen «An» und «Betreff» vom Original und zählen nicht als Eingabe.
  const attachmentIds = attachments.files.map((f) => f.id);
  const snapshot = JSON.stringify(
    reply ? [body, attachmentIds] : [to, subject, body, attachmentIds],
  );
  const [saved, setSaved] = useState(() =>
    JSON.stringify(reply ? ["", []] : [presetTo, "", "", []]),
  );
  useTabDirty(!done && snapshot !== saved);
  useCloseWhen(done);

  const saveDraft = async (): Promise<boolean> => {
    // Zwei gleichzeitige Speichervorgänge würden denselben alten Entwurf ersetzen und zwei neue hinterlassen.
    if (savingDraft.current) return false;
    savingDraft.current = true;
    setActionError(undefined);
    try {
      const saved = await service.saveDraft({
        accountId: account.id,
        to,
        subject,
        body,
        attachmentIds,
        replaces: draftId.current,
      });
      draftId.current = saved.draftId;
      toast.show({ tone: "ok", title: t("mail.draft.saved") });
      setSaved(snapshot);
      return true;
    } catch (e) {
      setActionError(e);
      return false;
    } finally {
      savingDraft.current = false;
    }
  };
  const saveRef = useRef(saveDraft);
  saveRef.current = saveDraft;
  useEffect(() => tab.registerSave(() => saveRef.current()), [tab]);

  const send = async () => {
    setActionError(undefined);
    const next: typeof errors = {};
    if (!reply && !parseAddress(to)) next.to = t("mail.compose.error.to");
    if (!reply && subject.trim() === "") next.subject = t("mail.compose.error.subject");
    if (body.trim() === "") next.body = t("mail.compose.error.body");
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    try {
      if (reply) await service.reply(account.id, folder, uid, body, attachmentIds);
      else await service.send({ accountId: account.id, to, subject, body, attachmentIds });
      toast.show({ tone: "ok", title: t("mail.sent") });
      setDone(true);
    } catch (e) {
      setActionError(e);
    }
  };

  const list = attachments.files;
  const attachmentsPanel = (
    <Panel
      title={
        list.length > 0 ? t("mail.attach.titleCount", { n: list.length }) : t("mail.attach.title")
      }
    >
      {attachments.picker}
      {list.map((f) => (
        <AttachmentRow key={f.id} file={f} onRemove={() => attachments.remove(f.id)} />
      ))}
      <Button small icon="paperclip" onClick={attachments.pick}>
        {list.length === 0 ? t("mail.attach.add") : t("mail.attach.addMore")}
      </Button>
    </Panel>
  );

  const title = reply ? t("mail.compose.reply") : t("mail.compose.new");
  const quote = orig
    ? t("mail.compose.quote", {
        date: formatDate(orig.receivedAt),
        time: formatTime(orig.receivedAt),
        name: orig.from.name ?? orig.from.address,
      })
    : "";
  const excerpt = orig
    ? orig.text.length > 120
      ? `${orig.text.slice(0, 120).trim()} …`
      : orig.text
    : "";

  return (
    <>
      <PageHeader
        crumb={reply ? t("mail.crumb.reply") : t("mail.crumb.new")}
        title={title}
        actions={
          <>
            <Button icon="trash" onClick={() => setDone(true)}>
              {t("mail.draft.discard")}
            </Button>
            <Button icon="save" onClick={() => void saveDraft()}>
              {t("mail.draft.save")}
            </Button>
            <Button variant="primary" icon="send" onClick={() => void send()}>
              {t("mail.send")}
            </Button>
          </>
        }
      />
      {actionError !== undefined && <ActionError error={actionError} />}
      <div className="mail-grid mail-grid--head">
        <TextField
          label={t("mail.compose.to")}
          required
          value={to}
          readOnly={reply}
          error={errors.to}
          autoComplete="off"
          onChange={(e) => setTo(e.target.value)}
        />
        <TextField
          label={t("mail.compose.subject")}
          required
          value={subject}
          readOnly={reply}
          error={errors.subject}
          autoComplete="off"
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>
      {errors.body && (
        <div className="mail__alert">
          <Message tone="error">{errors.body}</Message>
        </div>
      )}
      <div className="mail-desk">
        <div className="mail-paper">
          <textarea
            name="text"
            className="mail-paper__text"
            aria-label={t("mail.compose.body")}
            aria-invalid={errors.body ? true : undefined}
            rows={Math.max(10, body.split("\n").length + 2)}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          {reply && orig && (
            <div className="mail-paper__quote">
              {quote}
              <br />
              {excerpt}
            </div>
          )}
        </div>
        <div className="mail-side">
          {reply && orig ? (
            <Panel title={t("mail.reply.panel")}>
              <Facts
                items={[
                  [t("mail.read.from"), orig.from.name ?? orig.from.address],
                  [t("mail.read.received"), formatDateTime(orig.receivedAt)],
                  [t("mail.read.status"), t("mail.reply.status")],
                ]}
              />
            </Panel>
          ) : null}
          {attachmentsPanel}
          {!reply && (
            <Panel title={t("mail.sender.title")}>
              <Facts
                items={[
                  [t("mail.sender.name"), account.fromName ?? "–"],
                  [t("mail.sender.address"), account.fromAddress],
                ]}
              />
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

/** Lädt das Original, auf das geantwortet wird, und zeigt erst dann das Blatt. */
function ReplyLoader({
  account,
  folder,
  uid,
}: {
  account: MailAccount;
  folder: MailFolder;
  uid: number;
}) {
  const service = useMailService();
  const [load, reload] = useLoad(
    (signal) => service.read(account.id, folder, uid, signal),
    [service, account.id, folder, uid],
  );
  if (load.status === "loading") return <Loading />;
  if (load.status === "error") return <LoadError load={load} onRetry={reload} />;
  return <ComposeBody account={account} mode="reply" folder={folder} uid={uid} orig={load.data} />;
}

/** Antworten (Design 7.3) und Neue Mail als weisses Blatt (Design 7.4). */
export function ComposePage() {
  const tab = useCurrentTab();
  const reply = tab.params["mode"] === "reply";
  const folder = MAIL_FOLDERS.find((f) => f === tab.params["folder"]) ?? "inbox";
  const uid = Number(tab.params["uid"]);
  return (
    <WithAccount current={reply ? folder : "inbox"}>
      {(account) =>
        !reply ? (
          <ComposeBody account={account} mode="new" folder={folder} uid={0} orig={null} />
        ) : Number.isInteger(uid) && uid > 0 ? (
          <ReplyLoader account={account} folder={folder} uid={uid} />
        ) : null
      }
    </WithAccount>
  );
}
