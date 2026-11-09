import { useEffect, useMemo, useState } from "react";
import { t, tp, type TextKey } from "../../i18n";
import { useCurrentTab, useTabs } from "../../shell/tabs";
import { Badge, Button, DataTable, EmptyState, Icon, PageHeader, type Column } from "../../ui";
import { formatDateTime } from "./format";
import { useMailService } from "./mailContext";
import {
  MAIL_FOLDERS,
  type MailAccount,
  type MailFolder,
  type MessageSummary,
} from "./mailService";
import {
  ActionError,
  FilterSelect,
  Loading,
  LoadError,
  Pager,
  SearchBox,
  SelectionBar,
  ToolCount,
  WithAccount,
} from "./parts";
import { useLoad, useOnActivate } from "./useMail";

const PAGE_SIZE = 16;

type StatusFilter = "all" | "unread" | "read" | "answered";

const statusOf = (m: MessageSummary): Exclude<StatusFilter, "all"> =>
  m.answered ? "answered" : m.seen ? "read" : "unread";

function StatusCell({ message }: { message: MessageSummary }) {
  const status = statusOf(message);
  if (status === "unread") {
    return (
      <Badge tone="neutral">
        <Icon name="mail" size={12} />
        {t("mail.status.unread")}
      </Badge>
    );
  }
  if (status === "answered") {
    return (
      <Badge tone="ok">
        <Icon name="reply" size={12} />
        {t("mail.status.answered")}
      </Badge>
    );
  }
  return <span className="muted">{t("mail.status.read")}</span>;
}

function InboxBody({ account, folder }: { account: MailAccount; folder: MailFolder }) {
  const service = useMailService();
  const { openTab } = useTabs();
  const tab = useCurrentTab();
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<unknown>();
  const [load, reload] = useLoad(
    (signal) => service.inbox(account.id, folder, page, PAGE_SIZE, signal),
    [service, account.id, folder, page],
  );
  useOnActivate(reload);

  const data = load.status === "ready" ? load.data : undefined;
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  useEffect(() => tab.setPage(page, pages), [tab, page, pages]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data?.messages ?? []).filter(
      (m) =>
        (status === "all" || statusOf(m) === status) &&
        (!needle || `${m.from} ${m.subject}`.toLowerCase().includes(needle)),
    );
  }, [data, query, status]);

  const open = (m: MessageSummary) =>
    openTab("mail-read", {
      key: `${folder}:${m.uid}`,
      params: { folder, uid: String(m.uid) },
      title: m.subject,
    });

  const act = async (run: () => Promise<void>) => {
    setActionError(undefined);
    try {
      await run();
      setSelected(new Set());
      reload();
    } catch (e) {
      setActionError(e);
    }
  };
  const uids = () => [...selected].map(Number);

  const columns: Column<MessageSummary>[] = [
    {
      key: "from",
      header: t("mail.col.from"),
      width: "195px",
      cell: (m) => (m.seen ? m.from : <b>{m.from}</b>),
    },
    {
      key: "subject",
      header: t("mail.col.subject"),
      cell: (m) => (m.seen ? m.subject : <b>{m.subject}</b>),
    },
    {
      key: "attachments",
      header: t("mail.col.attachments"),
      width: "107px",
      cell: (m) =>
        m.attachments > 0 && (
          <>
            <Icon name="paperclip" size={14} /> {tp("mail.attachments", m.attachments)}
          </>
        ),
    },
    {
      key: "received",
      header: t("mail.col.received"),
      width: "151px",
      cell: (m) => formatDateTime(m.receivedAt),
    },
    {
      key: "status",
      header: t("mail.col.status"),
      width: "140px",
      cell: (m) => <StatusCell message={m} />,
    },
  ];

  const title = t(`mail.folder.${folder}` as TextKey);
  return (
    <>
      <PageHeader
        crumb={t("mail.crumb.folder", { folder: title })}
        title={title}
        status={
          data?.unread ? (
            <Badge tone="neutral">{t("mail.unread", { n: data.unread })}</Badge>
          ) : undefined
        }
        actions={
          <>
            <Button icon="refresh" onClick={reload}>
              {t("mail.fetch")}
            </Button>
            <Button
              variant="primary"
              icon="plus"
              onClick={() => openTab("mail-compose", { params: { mode: "new" } })}
            >
              {t("mail.new")}
            </Button>
          </>
        }
      />
      <div className="tool">
        <SearchBox label={t("mail.search.mails")} value={query} onChange={setQuery} />
        <FilterSelect
          label={t("mail.filter.folder")}
          value={folder}
          options={MAIL_FOLDERS.map((f) => ({
            value: f,
            label: `${t("mail.filter.folder")}: ${t(`mail.folder.${f}` as TextKey)}`,
          }))}
          onChange={(f) =>
            openTab("mail", {
              key: f === "inbox" ? "mail" : `mail:${f}`,
              params: { folder: f },
              title: t(`mail.folder.${f as MailFolder}` as TextKey),
            })
          }
        />
        <FilterSelect
          label={t("mail.filter.status")}
          value={status}
          options={(["all", "unread", "read", "answered"] as const).map((s) => ({
            value: s,
            label: `${t("mail.filter.status")}: ${t(`mail.filter.status.${s}` as TextKey)}`,
          }))}
          onChange={(s) => setStatus(s as StatusFilter)}
        />
        <ToolCount
          shown={rows.length}
          total={data?.total ?? 0}
          sortLabel={t("mail.sort.received")}
        />
      </div>
      <SelectionBar count={selected.size}>
        <Button
          icon="check"
          onClick={() => act(() => service.markRead(account.id, folder, uids()))}
        >
          {t("mail.action.markRead")}
        </Button>
        <Button
          icon="trash"
          onClick={() => act(() => service.deleteMessages(account.id, folder, uids()))}
        >
          {t("mail.action.delete")}
        </Button>
      </SelectionBar>
      {actionError !== undefined && <ActionError error={actionError} />}
      {load.status === "loading" && <Loading />}
      {load.status === "error" && <LoadError load={load} onRetry={reload} />}
      {data && (
        <>
          <div className="mail__table">
            <DataTable
              label={title}
              columns={columns}
              rows={rows}
              rowKey={(m) => String(m.uid)}
              selectable
              selected={selected}
              onSelectedChange={setSelected}
              onRowActivate={open}
              empty={
                <EmptyState
                  icon="inbox"
                  title={t("mail.empty.title")}
                  text={t("mail.empty.text")}
                />
              }
            />
          </div>
          <Pager page={page} pages={pages} onPage={setPage} />
        </>
      )}
    </>
  );
}

/** Posteingang und die übrigen Ordner (Design 7.1). */
export function InboxPage() {
  const tab = useCurrentTab();
  const raw = tab.params["folder"];
  const folder = MAIL_FOLDERS.find((f) => f === raw) ?? "inbox";
  return (
    <WithAccount current={folder}>
      {(account) => <InboxBody key={folder} account={account} folder={folder} />}
    </WithAccount>
  );
}
