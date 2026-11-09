import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/auth";
import { t, tp } from "../../i18n";
import { useCurrentTab, useTabs } from "../../shell/tabs";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  PageHeader,
  useToast,
  type Column,
  type Sort,
} from "../../ui";
import { chDate, chf, daysBetween, isoDay } from "./format";
import {
  errorText,
  FilterSelect,
  LoadError,
  Pager,
  SearchBox,
  Summary,
  Toolbar,
  useLoad,
} from "./parts";
import { useBuchhaltung } from "./service";
import { TAB } from "./tabs";
import type { OpenInvoice, ReminderInfo } from "./types";

const PAGE_SIZE = 14;

interface Row extends OpenInvoice {
  overdueDays: number;
  /** Höchste ausgestellte Mahnstufe. */
  reminder?: ReminderInfo;
}

const sum = (rows: readonly Row[]) => rows.reduce((s, r) => s + r.openRappen, 0);

/** Offene Posten (Design 5.4): versendete Rechnungen mit Restbetrag, Mahnstufe aus dem Mahnwesen. */
export function OffenePostenPage() {
  const service = useBuchhaltung();
  const { now } = useAuth();
  const tab = useCurrentTab();
  const { openTab } = useTabs();
  const toast = useToast();
  const today = isoDay(now);
  const [search, setSearch] = useState("");
  const [due, setDue] = useState("all");
  const [dunning, setDunning] = useState("all");
  const [sort, setSort] = useState<Sort>({ key: "due", direction: "asc" });
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const { data, error, reload } = useLoad(async () => {
    const invoices = await service.listOpenInvoices();
    const rows: Row[] = invoices.map((i) => ({
      ...i,
      overdueDays: Math.max(0, daysBetween(i.dueDate, today)),
    }));
    // Mahnungen gibt es nur für überfällige Rechnungen.
    await Promise.all(
      rows
        .filter((r) => r.overdueDays > 0)
        .map(async (r) => {
          const list = await service.listReminders(r.id);
          r.reminder = list.reduce<ReminderInfo | undefined>(
            (best, x) => (!best || x.level > best.level ? x : best),
            undefined,
          );
        }),
    );
    return rows;
  }, [service, today]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const dir = sort.direction === "asc" ? 1 : -1;
    return (data ?? [])
      .filter(
        (r) =>
          (due === "all" || (due === "overdue") === r.overdueDays > 0) &&
          (dunning === "all" || (dunning === "with") === !!r.reminder) &&
          (!needle || `${r.number ?? ""} ${r.debtorName}`.toLowerCase().includes(needle)),
      )
      .sort((a, b) => dir * a.dueDate.localeCompare(b.dueDate));
  }, [data, search, due, dunning, sort.direction]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const shown = filtered.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);

  useEffect(() => {
    tab.setPage(current + 1, pages);
  }, [tab, current, pages]);

  const all = data ?? [];
  const overdue = all.filter((r) => r.overdueDays > 0);
  const dunned = all.filter((r) => r.reminder);
  const summary: [string, typeof all][] = [
    [t("bh.offene.sumAll"), all],
    [t("bh.offene.sumOverdue"), overdue],
    [t("bh.offene.sumNotDue"), all.filter((r) => r.overdueDays === 0)],
    [t("bh.offene.sumDunned"), dunned],
  ];

  const columns: Column<Row>[] = [
    {
      key: "number",
      header: t("bh.col.invoice"),
      width: "129px",
      cell: (r) => <b>{r.number ?? "–"}</b>,
    },
    { key: "debtor", header: t("bh.col.debtor"), cell: (r) => r.debtorName },
    {
      key: "due",
      header: t("bh.col.due"),
      width: "118px",
      sortable: true,
      cell: (r) => chDate(r.dueDate),
    },
    {
      key: "overdue",
      header: t("bh.col.overdue"),
      width: "118px",
      align: "right",
      cell: (r) => (r.overdueDays > 0 ? tp("bh.offene.days", r.overdueDays) : "–"),
    },
    {
      key: "open",
      header: t("bh.col.open"),
      width: "140px",
      align: "right",
      cell: (r) => chf(r.openRappen),
    },
    {
      key: "dunning",
      header: t("bh.col.dunning"),
      width: "162px",
      cell: (r) =>
        r.reminder ? (
          <Badge tone="error">{`${r.reminder.level} · ${r.reminder.title}`}</Badge>
        ) : (
          <Badge>{t("bh.common.none")}</Badge>
        ),
    },
    {
      key: "action",
      header: t("bh.col.action"),
      width: "151px",
      cell: (r) => (
        <Button
          small
          aria-label={`${t("bh.offene.assign")} ${r.number ?? ""}`.trim()}
          onClick={() =>
            openTab(TAB.zuordnung, {
              key: TAB.zuordnung,
              params: { view: "manual", invoice: r.id },
            })
          }
        >
          {t("bh.offene.assign")}
        </Button>
      ),
    },
  ];

  const remind = async () => {
    setBusy(true);
    try {
      for (const id of selected) await service.issueReminder(id);
      toast.show({ tone: "ok", title: t("bh.offene.reminded") });
      setSelected(new Set());
      reload();
    } catch (e) {
      toast.show({ tone: "error", title: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        crumb={t("bh.crumb", { page: t("bh.tab.offene") })}
        title={t("bh.offene.title")}
        status={<Badge>{t("bh.offene.asOf", { date: chDate(today) })}</Badge>}
        actions={
          <>
            <Button icon="upload" onClick={() => openTab(TAB.import, { key: TAB.import })}>
              {t("bh.offene.import")}
            </Button>
            <Button
              icon="table"
              onClick={() =>
                service
                  .exportXlsx("open-items")
                  .catch((e: unknown) => toast.show({ tone: "error", title: errorText(e) }))
              }
            >
              {t("bh.common.export")}
            </Button>
          </>
        }
      />
      <div className="bh-sums">
        {summary.map(([label, rows]) => (
          <span key={label}>
            <span className="bh-sub">{label}</span> <b className="num">{chf(sum(rows))}</b>{" "}
            <span className="bh-sub">{tp("bh.offene.items", rows.length)}</span>
          </span>
        ))}
      </div>
      <Toolbar>
        <SearchBox placeholder={t("bh.offene.search")} value={search} onChange={setSearch} />
        <FilterSelect
          label={t("bh.col.due")}
          value={due}
          onChange={(v) => {
            setDue(v);
            setPage(0);
          }}
          options={[
            { value: "all", label: t("bh.offene.dueFilter", { value: t("bh.common.all") }) },
            {
              value: "overdue",
              label: t("bh.offene.dueFilter", { value: t("bh.offene.due.overdue") }),
            },
            {
              value: "notdue",
              label: t("bh.offene.dueFilter", { value: t("bh.offene.due.notDue") }),
            },
          ]}
        />
        <FilterSelect
          label={t("bh.col.dunning")}
          value={dunning}
          onChange={(v) => {
            setDunning(v);
            setPage(0);
          }}
          options={[
            { value: "all", label: t("bh.offene.dunningFilter", { value: t("bh.common.all") }) },
            { value: "none", label: t("bh.offene.dunningFilter", { value: t("bh.common.none") }) },
            {
              value: "with",
              label: t("bh.offene.dunningFilter", { value: t("bh.offene.dunning.with") }),
            },
          ]}
        />
        <span className="bh-spacer" />
        <Summary
          shown={shown.length}
          total={filtered.length}
          column={t("bh.offene.sorted")}
          direction={sort.direction}
        />
      </Toolbar>
      {selected.size > 0 && (
        <div className="bh-pad bh-pad--tight">
          <div
            className="msg msg--neutral bh-selbar"
            role="group"
            aria-label={t("bh.offene.selected", { n: selected.size })}
          >
            <b>{t("bh.offene.selected", { n: selected.size })}</b>
            <Button variant="primary" icon="bell" disabled={busy} onClick={() => void remind()}>
              {tp("bh.offene.remind", selected.size)}
            </Button>
            <Button variant="ghost" onClick={() => setSelected(new Set())}>
              {t("bh.offene.clear")}
            </Button>
          </div>
        </div>
      )}
      {error ? (
        <LoadError error={error} what={t("bh.offene.title")} onRetry={reload} />
      ) : (
        <>
          <div className="bh-pad">
            <DataTable
              label={t("bh.tab.offene")}
              columns={columns}
              rows={shown}
              rowKey={(r) => r.id}
              selectable
              selected={selected}
              onSelectedChange={setSelected}
              sort={sort}
              onSortChange={setSort}
              empty={<EmptyState title={t("bh.common.empty")} />}
            />
          </div>
          <Pager
            text={t("bh.common.pageOf", { n: current + 1, total: pages })}
            hasPrev={current > 0}
            hasNext={current < pages - 1}
            onPrev={() => setPage(current - 1)}
            onNext={() => setPage(current + 1)}
          />
        </>
      )}
    </div>
  );
}
