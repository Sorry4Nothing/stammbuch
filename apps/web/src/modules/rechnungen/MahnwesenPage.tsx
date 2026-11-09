import { useMemo, useState } from "react";
import { t, tp } from "../../i18n";
import { useTabs } from "../../shell/tabs";
import { useOnTabActivate } from "../../shell/useOnTabActivate";
import {
  Badge,
  Button,
  DataTable,
  PageHeader,
  Panel,
  useToast,
  type Column,
  type Sort,
} from "../../ui";
import {
  chf,
  date,
  levelLabel,
  levelStartDay,
  nextStep,
  type DunningLevel,
  type InvoiceRow,
} from "./model";
import {
  errorText,
  FilterSelect,
  invoiceName,
  Loading,
  LoadError,
  SearchBox,
  useLoad,
} from "./parts";
import { DunningSettingsDialog } from "./DunningSettingsDialog";
import { useRechnungen, type DunningOverview } from "./service";
import "./rechnungen.css";

const ALL = "all";

/** «Zahlungserinnerung ab Tag 10, Gebühr CHF 0.00» */
function stageRule(levels: readonly DunningLevel[], l: DunningLevel): string {
  return t("rechnungen.dunning.rule", {
    title: l.title,
    day: levelStartDay(levels, l.level),
    fee: chf(l.feeCents),
  });
}

/** Mahnwesen: Übersicht der Mahnstufen und überfällige Rechnungen (Design 4.5). */
export function MahnwesenPage() {
  const service = useRechnungen();
  const { state, reload } = useLoad(() => service.dunningOverview(), "dunning");
  useOnTabActivate(reload);
  if (state.status === "error")
    return <LoadError what={t("rechnungen.dunning.what")} state={state} onRetry={reload} />;
  if (state.status !== "ready") return <Loading />;
  return <Overview data={state.data} reload={reload} />;
}

function Overview({ data, reload }: { data: DunningOverview; reload: () => void }) {
  const service = useRechnungen();
  const toast = useToast();
  const { openTab } = useTabs();
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState(ALL);
  const [sort, setSort] = useState<Sort>({ key: "days", direction: "desc" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { rows, levels, due } = data;

  const stages = useMemo(
    () =>
      [{ level: 0, title: null as string | null }, ...levels].map((l) => {
        const own = rows.filter((r) => r.level === l.level);
        return {
          level: l.level,
          title: l.title,
          count: own.length,
          cents: own.reduce((s, r) => s + r.invoice.openCents, 0),
        };
      }),
    [rows, levels],
  );
  const total = stages.reduce((s, x) => s + x.cents, 0);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rows.filter(
      (r) =>
        (level === ALL || r.level === Number(level)) &&
        (q === "" ||
          (r.invoice.number ?? "").toLowerCase().includes(q) ||
          r.invoice.debtor.name.toLowerCase().includes(q)),
    );
    const dir = sort.direction === "asc" ? 1 : -1;
    return [...list].sort((a, b) => dir * ((a.overdueDays ?? 0) - (b.overdueDays ?? 0)));
  }, [rows, query, level, sort]);

  const dueSelected = rows.filter((r) => selected.has(r.invoice.id) && due[r.invoice.id]);

  const create = async () => {
    setBusy(true);
    let ok = 0;
    for (const r of dueSelected) {
      try {
        await service.issueReminder(r.invoice.id);
        ok++;
      } catch (e) {
        toast.show({ tone: "error", title: invoiceName(r.invoice), text: errorText(e) });
      }
    }
    setBusy(false);
    if (ok > 0) toast.show({ tone: "ok", title: tp("rechnungen.dunning.done", ok) });
    setSelected(new Set());
    reload();
  };

  const openReminder = (r: InvoiceRow) =>
    openTab("mahnung", {
      key: r.invoice.id,
      params: { id: r.invoice.id },
      title: t("rechnungen.reminder.tab", { name: invoiceName(r.invoice) }),
    });

  const columns: Column<InvoiceRow>[] = [
    {
      key: "number",
      header: t("rechnungen.dunning.col.invoice"),
      width: "118px",
      cell: (r) => <b>{invoiceName(r.invoice)}</b>,
    },
    {
      key: "recipient",
      header: t("rechnungen.list.col.recipient"),
      cell: (r) => r.invoice.debtor.name,
    },
    {
      key: "due",
      header: t("rechnungen.dunning.col.due"),
      width: "107px",
      cell: (r) => date(r.invoice.dueDate),
    },
    {
      key: "days",
      header: t("rechnungen.dunning.col.days"),
      width: "69px",
      align: "right",
      sortable: true,
      cell: (r) => r.overdueDays,
    },
    {
      key: "amount",
      header: t("rechnungen.list.col.amount"),
      width: "118px",
      align: "right",
      cell: (r) => chf(r.invoice.openCents, r.invoice.currency),
    },
    {
      key: "level",
      header: t("rechnungen.list.col.level"),
      width: "184px",
      cell: (r) => (
        <Badge tone={r.level > 0 ? "error" : "neutral"}>
          {levelLabel(r.level, r.levelTitle, t("rechnungen.level.none"))}
        </Badge>
      ),
    },
    {
      key: "next",
      header: t("rechnungen.dunning.col.next"),
      width: "261px",
      cell: (r) => {
        const step = nextStep(r, levels, due[r.invoice.id]);
        if (step.kind === "last")
          return <span className="muted">{t("rechnungen.dunning.lastReached")}</span>;
        if (step.kind === "later")
          return (
            <span className="muted">
              {t("rechnungen.dunning.from", { title: step.level.title, day: step.day })}
            </span>
          );
        return (
          <>
            <Badge tone="warning">{t("rechnungen.dunning.dueNow")}</Badge> {step.level.title}
          </>
        );
      },
    },
  ];

  return (
    <div className="page">
      <PageHeader
        crumb={t("rechnungen.dunning.crumb")}
        title={t("rechnungen.dunning.title")}
        status={<Badge>{t("rechnungen.dunning.asOf", { date: date(data.today) })}</Badge>}
        actions={
          <Button icon="gear" onClick={() => setSettingsOpen(true)}>
            {t("rechnungen.dunning.settings")}
          </Button>
        }
      />
      {settingsOpen && (
        <DunningSettingsDialog
          levels={levels}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            toast.show({ tone: "ok", title: t("rechnungen.dunning.settingsSaved") });
            reload();
          }}
        />
      )}
      <div className="rg-body">
        <Panel title={t("rechnungen.dunning.panelStages")} flush>
          <table className="tbl rg-stages" aria-label={t("rechnungen.dunning.panelStages")}>
            <colgroup>
              <col />
              <col />
              <col />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">{t("rechnungen.dunning.col.reached")}</th>
                <th scope="col" className="r">
                  {t("rechnungen.dunning.col.count")}
                </th>
                <th scope="col" className="r">
                  {t("rechnungen.list.col.amount")}
                </th>
                <th scope="col">{t("rechnungen.dunning.col.nextStage")}</th>
              </tr>
            </thead>
            <tbody>
              {stages.map((s) => {
                const next = levels[s.level];
                return (
                  <tr key={s.level}>
                    <td>
                      {s.level === 0
                        ? t("rechnungen.dunning.noneOverdue")
                        : levelLabel(s.level, s.title, "")}
                    </td>
                    <td className="r">{s.count}</td>
                    <td className="r">{chf(s.cents)}</td>
                    <td>{next ? stageRule(levels, next) : t("rechnungen.dunning.lastReached")}</td>
                  </tr>
                );
              })}
              <tr className="tot">
                <td>{t("rechnungen.dunning.total")}</td>
                <td className="r">{rows.length}</td>
                <td className="r">{chf(total)}</td>
                <td>{t("rechnungen.dunning.totalNote")}</td>
              </tr>
            </tbody>
          </table>
        </Panel>
        <div>
          <div className="rg-tool rg-tool--flush">
            <SearchBox label={t("rechnungen.dunning.search")} value={query} onChange={setQuery} />
            <FilterSelect
              label={t("rechnungen.list.level")}
              value={level}
              onChange={setLevel}
              options={[
                { value: ALL, label: t("rechnungen.list.levelAll") },
                {
                  value: "0",
                  label: t("rechnungen.list.chip.level", { name: t("rechnungen.level.none") }),
                },
                ...levels.map((l) => ({
                  value: String(l.level),
                  label: t("rechnungen.list.chip.level", {
                    name: levelLabel(l.level, l.title, ""),
                  }),
                })),
              ]}
            />
            <span className="rg-tool__spacer" />
            <span className="muted" aria-live="polite">
              {tp("rechnungen.dunning.count", rows.length, {
                shown: shown.length,
                total: rows.length,
              })}
            </span>
          </div>
          {selected.size > 0 && (
            <div className="rg-bulk" role="status">
              <b>{t("rechnungen.list.selected", { n: selected.size })}</b>
              <span className="rg-bulk__spacer" />
              <Button
                variant="primary"
                icon="warning"
                disabled={busy || dueSelected.length === 0}
                onClick={() => void create()}
              >
                {tp("rechnungen.dunning.create", dueSelected.length)}
              </Button>
              <Button variant="ghost" icon="close" onClick={() => setSelected(new Set())}>
                {t("rechnungen.list.bulkClear")}
              </Button>
            </div>
          )}
          <DataTable
            label={t("rechnungen.dunning.tableOverdue")}
            columns={columns}
            rows={shown}
            rowKey={(r) => r.invoice.id}
            selectable
            selected={selected}
            onSelectedChange={setSelected}
            sort={sort}
            onSortChange={setSort}
            onRowActivate={(r) => due[r.invoice.id] && openReminder(r)}
            empty={<span className="muted">{t("rechnungen.dunning.empty")}</span>}
          />
        </div>
      </div>
    </div>
  );
}
