import { useState } from "react";
import { t, type TextKey } from "../../i18n";
import { useCurrentTab, useTabs } from "../../shell/tabs";
import { Button, PageHeader, Panel } from "../../ui";
import { formatDateTime, formatSize } from "./format";
import { useMailService } from "./mailContext";
import { MAIL_FOLDERS, type Address, type MailAccount, type MailFolder } from "./mailService";
import { ActionError, Facts, FileTag, Loading, LoadError, WithAccount } from "./parts";
import { useLoad } from "./useMail";

export const addressText = (a: Address) => (a.name ? `${a.name} <${a.address}>` : a.address);

/** Klartext als Absätze. Der Text kommt als Zeichenkette in React und wird dort maskiert. */
export function PaperText({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((block, i) => (
        <p key={i}>
          {block.split("\n").map((line, j) => (
            <span key={j}>
              {j > 0 && <br />}
              {line}
            </span>
          ))}
        </p>
      ))}
    </>
  );
}

function ReadBody({
  account,
  folder,
  uid,
}: {
  account: MailAccount;
  folder: MailFolder;
  uid: number;
}) {
  const service = useMailService();
  const { openTab } = useTabs();
  const tab = useCurrentTab();
  const [actionError, setActionError] = useState<unknown>();
  const [load, reload] = useLoad(
    (signal) => service.read(account.id, folder, uid, signal),
    [service, account.id, folder, uid],
  );

  if (load.status === "loading") return <Loading />;
  if (load.status === "error") return <LoadError load={load} onRetry={reload} />;
  const m = load.data;
  const folderName = t(`mail.folder.${folder}` as TextKey);

  const remove = async () => {
    setActionError(undefined);
    try {
      await service.deleteMessages(account.id, folder, [uid]);
      tab.close();
    } catch (e) {
      setActionError(e);
    }
  };

  return (
    <>
      <PageHeader
        crumb={t("mail.crumb.read", { folder: folderName, from: m.from.name ?? m.from.address })}
        title={m.subject}
        actions={
          <>
            <Button
              variant="primary"
              icon="reply"
              onClick={() =>
                openTab("mail-compose", {
                  key: `reply:${folder}:${uid}`,
                  params: { mode: "reply", folder, uid: String(uid) },
                  title: m.subject.toLowerCase().startsWith("re:") ? m.subject : `Re: ${m.subject}`,
                })
              }
            >
              {t("mail.action.reply")}
            </Button>
            <Button icon="trash" onClick={remove}>
              {t("mail.action.delete")}
            </Button>
          </>
        }
      />
      {actionError !== undefined && <ActionError error={actionError} />}
      <div className="mail__head">
        <dl className="kv mail__kv">
          <dt>{t("mail.read.from")}</dt>
          <dd>{addressText(m.from)}</dd>
          <dt>{t("mail.read.to")}</dt>
          <dd>{m.to.map(addressText).join(", ")}</dd>
          <dt>{t("mail.read.received")}</dt>
          <dd>{formatDateTime(m.receivedAt)}</dd>
        </dl>
      </div>
      <div className="mail-desk">
        <article className="mail-paper" aria-label={m.subject}>
          <PaperText text={m.text} />
        </article>
        <div className="mail-side">
          <Panel title={t("mail.read.panel")}>
            <Facts
              items={[
                [t("mail.read.account"), account.fromAddress],
                [t("mail.read.folder"), folderName],
                ...(m.sizeBytes !== null
                  ? [[t("mail.read.size"), formatSize(m.sizeBytes)] as const]
                  : []),
                [t("mail.read.status"), t("mail.status.read")],
              ]}
            />
          </Panel>
          <Panel title={t("mail.read.attachments")}>
            {m.attachments.length === 0 ? (
              <span className="muted">{t("mail.read.noAttachments")}</span>
            ) : (
              <div className="mail__tags">
                {m.attachments.map((a, i) => (
                  <FileTag key={`${a.filename}-${i}`} name={a.filename} size={formatSize(a.size)} />
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

/** Eine Mail lesen (Design 7.2). */
export function ReadPage() {
  const tab = useCurrentTab();
  const folder = MAIL_FOLDERS.find((f) => f === tab.params["folder"]) ?? "inbox";
  const uid = Number(tab.params["uid"]);
  return (
    <WithAccount current={folder}>
      {(account) =>
        Number.isInteger(uid) && uid > 0 ? (
          <ReadBody account={account} folder={folder} uid={uid} />
        ) : null
      }
    </WithAccount>
  );
}
