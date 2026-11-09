import { useMemo, useState } from "react";
import { t, tp } from "../../i18n";
import { useTabs } from "../../shell/tabs";
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  Icon,
  PageHeader,
  Panel,
  TextField,
  type Column,
  type Sort,
} from "../../ui";
import { combineDateTime, formatDate, formatDateTime, formatTime, isoDay, isoTime } from "./format";
import { useMailService } from "./mailContext";
import type { CampaignSummary } from "./mailService";
import {
  ActionError,
  FilterSelect,
  Loading,
  LoadError,
  MailLayout,
  SearchBox,
  SelectionBar,
  ToolCount,
} from "./parts";
import { useLoad, useOnActivate } from "./useMail";

type Filter = "all" | "planned" | "draft";
type Action = "delete" | "now" | "time";

function StateBadge({ state }: { state: CampaignSummary["state"] }) {
  return state === "planned" ? (
    <Badge tone="ok">
      <Icon name="clock" size={12} />
      {t("mail.plan.state.planned")}
    </Badge>
  ) : (
    <Badge tone="warning">
      <Icon name="warning" size={12} />
      {t("mail.plan.state.draft")}
    </Badge>
  );
}

function RescheduleDialog({
  campaign,
  onCancel,
  onSave,
}: {
  campaign: CampaignSummary;
  onCancel: () => void;
  onSave: (iso: string) => void;
}) {
  const at = new Date(campaign.scheduledAt);
  const [day, setDay] = useState(isoDay(at));
  const [time, setTime] = useState(isoTime(at));
  const [error, setError] = useState<string>();
  const submit = () => {
    const iso = combineDateTime(day, time);
    if (!iso || new Date(iso).getTime() <= Date.now()) {
      setError(t("mail.bulk.error.time"));
      return;
    }
    onSave(iso);
  };
  return (
    <Dialog
      title={t("mail.plan.time.title")}
      onClose={onCancel}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onCancel}>{t("ui.cancel")}</Button>
          <Button variant="primary" type="submit">
            {t("mail.plan.time.save")}
          </Button>
        </>
      }
    >
      <div className="mail-dialog">
        <TextField
          label={t("mail.bulk.when.date")}
          type="date"
          value={day}
          error={error}
          data-autofocus
          onChange={(e) => setDay(e.target.value)}
        />
        <TextField
          label={t("mail.bulk.when.time")}
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
        />
      </div>
    </Dialog>
  );
}

/** Versandplan (Design 7.11): geplante Versände und Entwürfe. */
export function PlanPage() {
  const service = useMailService();
  const { openTab } = useTabs();
  const [load, reload] = useLoad((signal) => service.campaigns(signal), [service]);
  useOnActivate(reload);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<Sort>({ key: "at", direction: "asc" });
  const [action, setAction] = useState<Action>();
  const [actionError, setActionError] = useState<unknown>();

  const all = useMemo(
    () =>
      load.status === "ready"
        ? load.data.filter((c) => c.state === "planned" || c.state === "draft")
        : [],
    [load],
  );
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const dir = sort.direction === "asc" ? 1 : -1;
    return all
      .filter(
        (c) =>
          (filter === "all" || c.state === filter) &&
          (!needle || `${c.subject} ${c.listName ?? ""}`.toLowerCase().includes(needle)),
      )
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) * dir);
  }, [all, query, filter, sort]);

  const planned = all.filter((c) => c.state === "planned").length;
  const drafts = all.length - planned;
  const one = selected.size === 1 ? all.find((c) => selected.has(c.id)) : undefined;

  const run = async (fn: (c: CampaignSummary) => Promise<void>) => {
    const target = one;
    setAction(undefined);
    if (!target) return;
    setActionError(undefined);
    try {
      await fn(target);
      setSelected(new Set());
      reload();
    } catch (e) {
      setActionError(e);
    }
  };

  const columns: Column<CampaignSummary>[] = [
    {
      key: "subject",
      header: t("mail.plan.col.subject"),
      cell: (c) => (selected.has(c.id) ? <b>{c.subject}</b> : c.subject),
    },
    {
      key: "list",
      header: t("mail.plan.col.list"),
      width: "184px",
      cell: (c) => c.listName ?? "–",
    },
    {
      key: "recipients",
      header: t("mail.plan.col.recipients"),
      width: "96px",
      align: "right",
      cell: (c) => c.recipientCount,
    },
    {
      key: "at",
      header: t("mail.plan.col.at"),
      width: "151px",
      sortable: true,
      cell: (c) => formatDateTime(c.scheduledAt),
    },
    {
      key: "state",
      header: t("mail.plan.col.status"),
      width: "107px",
      cell: (c) => <StateBadge state={c.state} />,
    },
  ];

  return (
    <MailLayout current="plan">
      <PageHeader
        crumb={t("mail.crumb.plan")}
        title={t("mail.plan.title")}
        status={
          load.status === "ready" ? (
            <>
              <Badge tone="neutral">{t("mail.plan.planned", { n: planned })}</Badge>
              {drafts > 0 && (
                <Badge tone="warning">
                  <Icon name="warning" size={12} />
                  {tp("mail.plan.drafts", drafts)}
                </Badge>
              )}
            </>
          ) : undefined
        }
        actions={
          <Button
            variant="primary"
            icon="plus"
            onClick={() => openTab("mail-bulk", { key: "mail-bulk" })}
          >
            {t("mail.plan.new")}
          </Button>
        }
      />
      <div className="tool">
        <SearchBox label={t("mail.plan.search")} value={query} onChange={setQuery} />
        <FilterSelect
          label={t("mail.plan.col.status")}
          value={filter}
          options={[
            { value: "all", label: `${t("mail.plan.col.status")}: ${t("mail.filter.status.all")}` },
            {
              value: "planned",
              label: `${t("mail.plan.col.status")}: ${t("mail.plan.state.planned")}`,
            },
            {
              value: "draft",
              label: `${t("mail.plan.col.status")}: ${t("mail.plan.state.draft")}`,
            },
          ]}
          onChange={(v) => setFilter(v as Filter)}
        />
        <ToolCount shown={rows.length} total={all.length} sortLabel={t("mail.plan.sort")} />
      </div>
      <SelectionBar count={selected.size}>
        <Button icon="clock" disabled={!one} onClick={() => setAction("time")}>
          {t("mail.plan.action.time")}
        </Button>
        <Button icon="send" disabled={!one} onClick={() => setAction("now")}>
          {t("mail.plan.action.now")}
        </Button>
        <Button icon="trash" disabled={!one} onClick={() => setAction("delete")}>
          {t("mail.plan.action.delete")}
        </Button>
      </SelectionBar>
      {actionError !== undefined && <ActionError error={actionError} />}
      {load.status === "loading" && <Loading />}
      {load.status === "error" && <LoadError load={load} onRetry={reload} />}
      {load.status === "ready" && (
        <>
          <div className="mail__table">
            <DataTable
              label={t("mail.plan.table")}
              columns={columns}
              rows={rows}
              rowKey={(c) => c.id}
              selectable
              selected={selected}
              onSelectedChange={setSelected}
              sort={sort}
              onSortChange={setSort}
              empty={
                <EmptyState
                  icon="clock"
                  title={t("mail.plan.empty.title")}
                  text={t("mail.plan.empty.text")}
                />
              }
            />
          </div>
          {one && (
            <div className="mail__note">
              <Panel title={t("mail.plan.selected", { subject: one.subject })}>
                <div className="mail-detail">
                  <dl className="kv mail__kv">
                    <dt>{t("mail.plan.col.subject")}</dt>
                    <dd>{one.subject}</dd>
                    <dt>{t("mail.plan.col.list")}</dt>
                    <dd>{one.listName ?? "–"}</dd>
                    <dt>{t("mail.plan.col.recipients")}</dt>
                    <dd>{one.recipientCount}</dd>
                  </dl>
                  <dl className="kv mail__kv">
                    <dt>{t("mail.plan.col.at")}</dt>
                    <dd>
                      {t("mail.bulk.when.at", {
                        date: formatDate(one.scheduledAt),
                        time: formatTime(one.scheduledAt),
                      })}
                    </dd>
                    <dt>{t("mail.plan.attachment")}</dt>
                    <dd>
                      {one.attachmentCount > 0
                        ? tp("mail.bulk.files", one.attachmentCount)
                        : t("mail.bulk.attach.none")}
                    </dd>
                    <dt>{t("mail.plan.confirmed")}</dt>
                    <dd>
                      {one.confirmedAt
                        ? one.confirmedBy
                          ? t("mail.plan.confirmedBy", {
                              when: formatDateTime(one.confirmedAt),
                              by: one.confirmedBy,
                            })
                          : formatDateTime(one.confirmedAt)
                        : t("mail.plan.unconfirmed")}
                    </dd>
                  </dl>
                </div>
              </Panel>
            </div>
          )}
        </>
      )}
      {one && action === "delete" && (
        <ConfirmDialog
          title={t("mail.plan.delete.title")}
          confirmLabel={t("mail.plan.action.delete")}
          confirmIcon="trash"
          danger
          onCancel={() => setAction(undefined)}
          onConfirm={() => void run((c) => service.cancel(c.id))}
        >
          {t("mail.plan.delete.text", { subject: one.subject })}
        </ConfirmDialog>
      )}
      {one && action === "now" && (
        <ConfirmDialog
          title={t("mail.plan.now.title")}
          confirmLabel={t("mail.plan.action.now")}
          confirmIcon="send"
          onCancel={() => setAction(undefined)}
          onConfirm={() => void run((c) => service.sendNow(c.id))}
        >
          {t("mail.plan.now.text", { subject: one.subject, n: one.recipientCount })}
        </ConfirmDialog>
      )}
      {one && action === "time" && (
        <RescheduleDialog
          campaign={one}
          onCancel={() => setAction(undefined)}
          onSave={(iso) => void run((c) => service.reschedule(c.id, iso))}
        />
      )}
    </MailLayout>
  );
}
