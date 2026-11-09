import { useEffect, useMemo, useState } from "react";
import { t, tp, type TextKey } from "../../i18n";
import { useCurrentTab } from "../../shell/tabs";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Icon,
  PageHeader,
  Panel,
  type Column,
} from "../../ui";
import { etaMinutes, formatDate, formatTime, formatTimeSeconds } from "./format";
import { useMailService } from "./mailContext";
import type { CampaignStatus, Delivery, DeliveryStatus } from "./mailService";
import {
  ActionError,
  FilterSelect,
  Loading,
  LoadError,
  MailLayout,
  Pager,
  SearchBox,
  ToolCount,
} from "./parts";
import { useLoad, useOnActivate } from "./useMail";

const PAGE_SIZE = 12;
const REFRESH_MS = 5000;

type Filter = "all" | "sent" | "failed" | "queued";

const groupOf = (s: DeliveryStatus): Exclude<Filter, "all"> | "cancelled" =>
  s === "sent" ? "sent" : s === "failed" ? "failed" : s === "cancelled" ? "cancelled" : "queued";

function DeliveryBadge({ status }: { status: DeliveryStatus }) {
  const g = groupOf(status);
  if (g === "sent") {
    return (
      <Badge tone="ok">
        <Icon name="check" size={12} />
        {t("mail.status.sent")}
      </Badge>
    );
  }
  if (g === "failed") {
    return (
      <Badge tone="error">
        <Icon name="warning" size={12} />
        {t("mail.status.failed")}
      </Badge>
    );
  }
  return (
    <Badge tone="neutral">
      <Icon name="clock" size={12} />
      {g === "cancelled" ? t("mail.status.cancelled") : t("mail.status.queued")}
    </Badge>
  );
}

const REASONS = new Set([
  "AUTH",
  "TLS",
  "CONNECT",
  "REJECTED",
  "TRANSIENT",
  "BLOCKED_HOST",
  "BAD_PORT",
  "VALIDATION",
  "TOO_LARGE",
  "NOT_FOUND",
]);

/** Grund einer Fehlzustellung: fester Text zum Code, nie der Rohtext des Mailservers. */
const reasonText = (code: string | null) =>
  code === null
    ? "–"
    : t(REASONS.has(code) ? (`mail.reason.${code}` as TextKey) : "mail.reason.other");

interface Picked {
  status: CampaignStatus;
  loadedAt: number;
}

function StatusBody({ campaignId }: { campaignId: string }) {
  const service = useMailService();
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [actionError, setActionError] = useState<unknown>();
  const [load, reload] = useLoad<Picked & { deliveries: Delivery[] }>(
    async (signal) => {
      const status = await service.campaignStatus(campaignId, signal);
      const deliveries = await service.deliveries(
        campaignId,
        (page - 1) * PAGE_SIZE,
        PAGE_SIZE,
        signal,
      );
      return { status, deliveries, loadedAt: Date.now() };
    },
    [service, campaignId, page],
  );
  useOnActivate(reload);
  const data = load.status === "ready" ? load.data : undefined;
  const running = data?.status.campaign.state === "sending";

  // Solange der Versand läuft, den Stand regelmässig nachladen.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [running, reload]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data?.deliveries ?? [])
      .filter(
        (d) =>
          (filter === "all" || groupOf(d.status) === filter) &&
          (!needle || `${d.email} ${d.name ?? ""}`.toLowerCase().includes(needle)),
      )
      .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  }, [data, query, filter]);

  if (load.status === "loading") return <Loading />;
  if (load.status === "error") return <LoadError load={load} onRetry={reload} />;

  const { campaign, counts } = load.data.status;
  const sent = counts.sent;
  const failed = counts.failed;
  const queued = counts.held + counts.queued + counts.sending;
  const total = Math.max(1, sent + failed + queued + counts.cancelled);
  const pages = Math.max(1, Math.ceil(campaign.recipientCount / PAGE_SIZE));
  const eta = etaMinutes(sent, queued, campaign.confirmedAt, load.data.loadedAt);
  const pct = (n: number) => `${((n / total) * 100).toFixed(2)}%`;

  const badge =
    campaign.state === "sending" ? (
      <Badge tone="neutral">
        <Icon name="refresh" size={12} />
        {t("mail.status.running")}
      </Badge>
    ) : campaign.state === "cancelled" ? (
      <Badge tone="neutral">{t("mail.status.cancelled")}</Badge>
    ) : campaign.state === "planned" || campaign.state === "draft" ? (
      <Badge tone="neutral">{t("mail.plan.state.planned")}</Badge>
    ) : (
      <Badge tone="ok">
        <Icon name="check" size={12} />
        {t("mail.status.done")}
      </Badge>
    );

  const columns: Column<Delivery>[] = [
    {
      key: "name",
      header: t("mail.status.col.recipient"),
      width: "173px",
      cell: (d) => d.name ?? "–",
    },
    { key: "email", header: t("mail.status.col.email"), cell: (d) => d.email },
    {
      key: "status",
      header: t("mail.status.col.status"),
      width: "151px",
      cell: (d) => <DeliveryBadge status={d.status} />,
    },
    {
      key: "at",
      header: t("mail.status.col.time"),
      width: "96px",
      cell: (d) => formatTimeSeconds(d.at),
    },
    {
      key: "reason",
      header: t("mail.status.col.reason"),
      width: "195px",
      cell: (d) => reasonText(d.reason),
    },
  ];

  return (
    <>
      <PageHeader
        crumb={t("mail.crumb.status")}
        title={t("mail.status.title")}
        status={badge}
        actions={
          running ? (
            <Button
              icon="clock"
              onClick={() =>
                service.pause(campaign.id).then(reload, (e: unknown) => setActionError(e))
              }
            >
              {t("mail.status.pause")}
            </Button>
          ) : undefined
        }
      />
      {actionError !== undefined && <ActionError error={actionError} />}
      <div className="mail__head">
        <Panel
          title={t("mail.status.panel", { subject: campaign.subject, n: campaign.recipientCount })}
        >
          <div
            className="statusbar"
            role="img"
            aria-label={t("mail.status.bar", { sent, failed, queued })}
          >
            <span className="statusbar__sent" style={{ width: pct(sent) }} />
            <span className="statusbar__failed" style={{ width: pct(failed) }} />
            <span className="statusbar__queued" style={{ width: pct(queued) }} />
          </div>
          <div className="legend">
            <span className="opt">
              <span className="legend__swatch legend__swatch--sent" />
              {t("mail.status.legend.sent", { n: sent })}
            </span>
            <span className="opt">
              <span className="legend__swatch legend__swatch--failed" />
              {t("mail.status.legend.failed", { n: failed })}
            </span>
            <span className="opt">
              <span className="legend__swatch legend__swatch--queued" />
              {t("mail.status.legend.queued", { n: queued })}
              {eta !== null && queued > 0 ? `, ${tp("mail.status.eta", eta)}` : ""}
            </span>
            {campaign.confirmedAt && (
              <span className="muted legend__stand">
                {t("mail.status.started", {
                  date: formatDate(campaign.confirmedAt),
                  time: formatTime(campaign.confirmedAt),
                  now: formatTime(new Date(load.data.loadedAt).toISOString()),
                })}
              </span>
            )}
          </div>
        </Panel>
      </div>
      <div className="tool">
        <SearchBox label={t("mail.status.search")} value={query} onChange={setQuery} />
        <FilterSelect
          label={t("mail.status.col.status")}
          value={filter}
          options={(["all", "sent", "failed", "queued"] as const).map((f) => ({
            value: f,
            label: `${t("mail.status.col.status")}: ${
              f === "all" ? t("mail.filter.status.all") : t(`mail.status.${f}` as TextKey)
            }`,
          }))}
          onChange={(v) => setFilter(v as Filter)}
        />
        <ToolCount
          shown={rows.length}
          total={campaign.recipientCount}
          sortLabel={t("mail.status.sort")}
        />
      </div>
      <div className="mail__table">
        <DataTable
          label={t("mail.status.table")}
          columns={columns}
          rows={rows}
          rowKey={(d) => d.id}
          empty={<span className="muted">{t("mail.status.empty")}</span>}
        />
      </div>
      <Pager page={page} pages={pages} onPage={setPage} />
    </>
  );
}

/** Versandstatus (Design 7.12): Fortschritt und Zustellung je Empfänger. */
export function StatusPage() {
  const service = useMailService();
  const tab = useCurrentTab();
  const wanted = tab.params["id"];
  const [load, reload] = useLoad<string | null>(
    async (signal) => {
      if (wanted) return wanted;
      // Ohne Angabe der jüngste Versand, der bestätigt und fällig ist.
      const latest = (await service.campaigns(signal))
        .filter((c) => c.state === "sending" || c.state === "sent")
        .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))[0];
      return latest?.id ?? null;
    },
    [service, wanted],
  );
  useOnActivate(reload);
  return (
    <MailLayout current="status">
      {load.status === "loading" && <Loading />}
      {load.status === "error" && <LoadError load={load} onRetry={reload} />}
      {load.status === "ready" && load.data === null && (
        <div className="mail__state">
          <EmptyState title={t("mail.status.none.title")} text={t("mail.status.none.text")} />
        </div>
      )}
      {load.status === "ready" && load.data !== null && <StatusBody campaignId={load.data} />}
    </MailLayout>
  );
}
