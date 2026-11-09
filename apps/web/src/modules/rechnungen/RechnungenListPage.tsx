import { useEffect, useMemo, useState } from "react";
import { t, tp, type TextKey } from "../../i18n";
import {
  Button,
  DataTable,
  PageHeader,
  PageTabs,
  useToast,
  type Column,
  type Sort,
} from "../../ui";
import { useCurrentTab, useTabs } from "../../shell/tabs";
import { useOnTabActivate } from "../../shell/useOnTabActivate";
import { BulkResendDialog } from "./BulkResendDialog";
import { amount, chf, date, isOpen, isOverdue, levelLabel, type InvoiceRow } from "./model";
import {
  errorText,
  FilterSelect,
  invoiceName,
  Loading,
  LoadError,
  Pager,
  SearchBox,
  StatusBadge,
  UndeliveredBadge,
  useLoad,
} from "./parts";
import { useRechnungen } from "./service";
import "./rechnungen.css";

const PAGE_SIZE = 50;
const ALL = "all";

type TabId = "all" | "draft" | "open" | "overdue" | "paid" | "cancelled" | "credited";
const TABS: TabId[] = ["all", "draft", "open", "overdue", "paid", "cancelled", "credited"];

const matches: Record<TabId, (r: InvoiceRow) => boolean> = {
  all: () => true,
  draft: (r) => r.status === "draft",
  open: isOpen,
  overdue: isOverdue,
  paid: (r) => r.status === "paid",
  cancelled: (r) => r.status === "cancelled",
  credited: (r) => r.status === "credited",
};

/** Rechnungsliste mit Statusfilter (Design 4.1). */
export function RechnungenListPage() {
  const service = useRechnungen();
  const { openTab } = useTabs();
  const { setPage, params } = useCurrentTab();
  const toast = useToast();
  const { state, reload } = useLoad(() => service.listInvoices(), "list");
  const features = useLoad(() => service.getSettings(), "settings");
  useOnTabActivate(reload);

  const [tab, setTab] = useState<TabId>("open");
  const [query, setQuery] = useState("");
  const [recipient, setRecipient] = useState(ALL);
  const [level, setLevel] = useState(ALL);
  const [year, setYear] = useState(params["year"] ?? ALL);
  const [sort, setSort] = useState<Sort>({ key: "due", direction: "asc" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPageState] = useState(1);
  const [resending, setResending] = useState(false);

  const rows = state.status === "ready" ? state.data : [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rows.filter(
      (r) =>
        matches[tab](r) &&
        (year === ALL || r.invoice.issueDate.startsWith(year)) &&
        (recipient === ALL || r.invoice.debtor.name === recipient) &&
        (level === ALL || r.level === Number(level)) &&
        (q === "" ||
          (r.invoice.number ?? "").toLowerCase().includes(q) ||
          r.invoice.debtor.name.toLowerCase().includes(q) ||
          (r.invoice.memberNumber ?? "").toLowerCase().includes(q) ||
          (r.invoice.reference?.value ?? "").includes(q.replace(/\s+/g, ""))),
    );
    const dir = sort.direction === "asc" ? 1 : -1;
    return [...list].sort((a, b) => dir * a.invoice.dueDate.localeCompare(b.invoice.dueDate));
  }, [rows, tab, query, recipient, level, year, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  useEffect(() => setPage(current, pages), [current, pages, setPage]);

  const recipients = useMemo(
    () =>
      [...new Set(rows.map((r) => r.invoice.debtor.name))].sort((a, b) =>
        a.localeCompare(b, "de-CH"),
      ),
    [rows],
  );
  const levels = useMemo(
    () =>
      [
        ...new Map(
          rows
            .filter((r) => r.level > 0)
            .map((r) => [r.level, levelLabel(r.level, r.levelTitle, "")]),
        ),
      ].sort((a, b) => a[0] - b[0]),
    [rows],
  );

  const reset = () => {
    setRecipient(ALL);
    setLevel(ALL);
    setYear(ALL);
    setPageState(1);
  };
  const chips: { id: string; text: string; clear: () => void }[] = [
    ...(year !== ALL
      ? [{ id: "year", text: t("rechnungen.list.chip.year", { year }), clear: () => setYear(ALL) }]
      : []),
    ...(recipient !== ALL
      ? [
          {
            id: "recipient",
            text: t("rechnungen.list.chip.recipient", { name: recipient }),
            clear: () => setRecipient(ALL),
          },
        ]
      : []),
    ...(level !== ALL
      ? [
          {
            id: "level",
            text: t("rechnungen.list.chip.level", {
              name: levels.find(([n]) => String(n) === level)?.[1] ?? level,
            }),
            clear: () => setLevel(ALL),
          },
        ]
      : []),
  ];

  const open = (r: InvoiceRow) =>
    openTab("rechnung", {
      key: r.invoice.id,
      params: { id: r.invoice.id },
      title: t("rechnungen.detail.tab", { name: invoiceName(r.invoice) }),
    });

  const pick = rows.filter((r) => selected.has(r.invoice.id));
  const exportRows = (list: readonly InvoiceRow[]) =>
    service
      .exportInvoices(list.map((r) => r.invoice.id))
      .then(() => toast.show({ tone: "ok", title: t("rechnungen.list.exported") }))
      .catch((e: unknown) =>
        toast.show({ tone: "error", title: t("rechnungen.list.exportFailed"), text: errorText(e) }),
      );

  const columns: Column<InvoiceRow>[] = [
    {
      key: "number",
      header: t("rechnungen.list.col.number"),
      width: "145px",
      nowrap: true,
      cell: (r) => <b>{invoiceName(r.invoice)}</b>,
    },
    {
      key: "recipient",
      header: t("rechnungen.list.col.recipient"),
      cell: (r) => r.invoice.debtor.name,
    },
    {
      key: "date",
      header: t("rechnungen.list.col.date"),
      width: "100px",
      nowrap: true,
      cell: (r) => date(r.invoice.issueDate),
    },
    {
      key: "due",
      header: t("rechnungen.list.col.due"),
      width: "135px",
      nowrap: true,
      sortable: true,
      cell: (r) => (
        <>
          {date(r.invoice.dueDate)}
          {r.overdueDays !== null && (
            <span className="muted"> {tp("rechnungen.list.days", r.overdueDays)}</span>
          )}
        </>
      ),
    },
    {
      key: "amount",
      header: t("rechnungen.list.col.amount"),
      width: "115px",
      align: "right",
      nowrap: true,
      cell: (r) => chf(r.invoice.totals.totalCents, r.invoice.currency),
    },
    {
      key: "level",
      header: t("rechnungen.list.col.level"),
      width: "110px",
      cell: (r) => levelLabel(r.level, r.levelTitle, t("rechnungen.level.none")),
    },
    {
      key: "status",
      header: t("rechnungen.list.col.status"),
      width: "115px",
      cell: (r) => (
        <span className="rg-badges">
          <StatusBadge status={r.status} />
          {r.invoice.status !== "draft" && r.invoice.mailFailedAt && <UndeliveredBadge />}
        </span>
      ),
    },
    {
      key: "open",
      header: t("rechnungen.list.col.open"),
      srOnlyHeader: true,
      width: "47px",
      cell: (r) => (
        <Button
          variant="ghost"
          small
          icon="eye"
          aria-label={t("rechnungen.list.openInvoice", { name: invoiceName(r.invoice) })}
          onClick={() => open(r)}
        />
      ),
    },
  ];

  const tabLabel = (id: TabId) =>
    t(`rechnungen.list.tab.${id}` as TextKey, { n: rows.filter(matches[id]).length });

  const total = filtered.reduce((s, r) => s + r.invoice.totals.totalCents, 0);

  const body =
    state.status === "ready" ? (
      <>
        <div className="rg-tool">
          <SearchBox
            label={t("rechnungen.list.search")}
            value={query}
            onChange={(v) => {
              setQuery(v);
              setPageState(1);
            }}
          />
          <FilterSelect
            label={t("rechnungen.list.recipient")}
            value={recipient}
            onChange={(v) => {
              setRecipient(v);
              setPageState(1);
            }}
            options={[
              { value: ALL, label: t("rechnungen.list.recipientAll") },
              ...recipients.map((n) => ({
                value: n,
                label: t("rechnungen.list.chip.recipient", { name: n }),
              })),
            ]}
          />
          <FilterSelect
            label={t("rechnungen.list.level")}
            value={level}
            onChange={(v) => {
              setLevel(v);
              setPageState(1);
            }}
            options={[
              { value: ALL, label: t("rechnungen.list.levelAll") },
              ...levels.map(([n, text]) => ({
                value: String(n),
                label: t("rechnungen.list.chip.level", { name: text }),
              })),
            ]}
          />
          <span className="rg-tool__spacer" />
          <Button
            icon="table"
            disabled={filtered.length === 0}
            onClick={() => void exportRows(filtered)}
          >
            {t("rechnungen.list.export")}
          </Button>
        </div>
        {chips.length > 0 && (
          <div className="rg-chips">
            <span className="muted">{t("rechnungen.list.activeFilters")}</span>
            {chips.map((c) => (
              <span key={c.id} className="rg-chip">
                {c.text}
                <Button
                  variant="ghost"
                  small
                  icon="close"
                  aria-label={t("rechnungen.list.removeFilter", {
                    name: c.text.split(":")[0] ?? c.text,
                  })}
                  onClick={c.clear}
                />
              </span>
            ))}
            <button type="button" className="link" onClick={reset}>
              {t("rechnungen.list.resetFilters")}
            </button>
          </div>
        )}
        <div className="rg-pad">
          {/* Der Platz bleibt reserviert, damit die Tabelle bei der Auswahl nicht springt. */}
          <div className="rg-bulkslot" role="status">
            {pick.length > 0 && (
              <div className="rg-bulk">
                <b>{t("rechnungen.list.selected", { n: pick.length })}</b>
                <span className="rg-bulk__spacer" />
                <Button icon="warning" onClick={() => openTab("mahnwesen", { key: "mahnwesen" })}>
                  {t("rechnungen.list.bulkReminders")}
                </Button>
                <Button icon="send" onClick={() => setResending(true)}>
                  {t("rechnungen.list.bulkResend")}
                </Button>
                <Button icon="table" onClick={() => void exportRows(pick)}>
                  {t("rechnungen.list.bulkExport")}
                </Button>
                <Button variant="ghost" icon="close" onClick={() => setSelected(new Set())}>
                  {t("rechnungen.list.bulkClear")}
                </Button>
              </div>
            )}
          </div>
          <DataTable
            label={t(`rechnungen.list.table.${tab}` as TextKey)}
            columns={columns}
            rows={visible}
            rowKey={(r) => r.invoice.id}
            selectable
            selected={selected}
            onSelectedChange={setSelected}
            sort={sort}
            onSortChange={setSort}
            onRowActivate={open}
            empty={<span className="muted">{t("rechnungen.list.empty")}</span>}
          />
        </div>
        {resending && (
          <BulkResendDialog
            ids={pick.map((r) => r.invoice.id)}
            onClose={() => {
              setResending(false);
              reload();
            }}
          />
        )}
        <div className="rg-bottom">
          <Pager
            page={current}
            pages={pages}
            onPage={setPageState}
            summary={tp("rechnungen.list.summary", filtered.length, { sum: amount(total) })}
          />
        </div>
      </>
    ) : state.status === "loading" ? (
      <Loading />
    ) : (
      <LoadError what={t("rechnungen.nav")} state={state} onRetry={reload} />
    );

  return (
    <div className="page rg-page">
      <PageHeader
        title={t("rechnungen.list.title")}
        actions={
          <>
            {features.state.status === "ready" &&
              features.state.data.features.collectiveInvoicing && (
                <Button
                  icon="people"
                  onClick={() => openTab("sammelrechnung", { key: "sammelrechnung" })}
                >
                  {t("rechnungen.list.collective")}
                </Button>
              )}
            <Button variant="primary" icon="plus" onClick={() => openTab("rechnung-neu")}>
              {t("rechnungen.list.create")}
            </Button>
          </>
        }
      />
      <PageTabs
        label={t("rechnungen.list.statusLabel")}
        value={tab}
        onChange={(id) => {
          setTab(id as TabId);
          setPageState(1);
          setSelected(new Set());
        }}
        tabs={TABS.map((id) => ({ id, label: tabLabel(id), content: id === tab ? body : null }))}
      />
    </div>
  );
}
