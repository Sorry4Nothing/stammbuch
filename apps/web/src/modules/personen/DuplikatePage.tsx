import { useMemo, useState } from "react";
import { t } from "../../i18n";
import { useTabs } from "../../shell/tabs";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Message,
  PageHeader,
  Panel,
  useToast,
  type Column,
} from "../../ui";
import {
  FilterSelect,
  Kv,
  LoadError,
  Loading,
  SearchBox,
  notifyChange,
  useAsync,
  useOnChange,
} from "./components";
import { formatInt } from "./format";
import type { Duplikat, DuplikatEintrag } from "./model";
import { usePersonen } from "./service";

const SORT = { key: "aehnlichkeit", direction: "desc" } as const;

export const trefferText = (d: Duplikat) =>
  d.trefferBei
    .map((x) => t(`personen.duplikate.treffer.${x}` as "personen.duplikate.treffer.name"))
    .join(", ");

const eintragText = (e: DuplikatEintrag) => (e.nr ? `${e.name} · ${e.nr}` : e.name);

/** Duplikate: Treffer prüfen, zusammenführen oder verwerfen (Design 3.12). */
export function DuplikatePage() {
  const svc = usePersonen();
  const tabs = useTabs();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [treffer, setTreffer] = useState("");
  const [status, setStatus] = useState("");
  const [activeId, setActiveId] = useState<string | undefined>();
  const [failed, setFailed] = useState(false);

  const list = useAsync(
    () => (svc.features.duplikate ? svc.listDuplikate() : Promise.resolve([] as Duplikat[])),
    [svc],
  );
  useOnChange(list.reload);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list.data ?? [])
      .filter(
        (d) =>
          (!treffer || d.trefferBei.includes(treffer as "name")) &&
          (!status || d.status === status) &&
          (!needle ||
            [d.a.name, d.b.name, d.a.nr ?? "", d.b.nr ?? ""].some((v) =>
              v.toLowerCase().includes(needle),
            )),
      )
      .sort((a, b) => b.aehnlichkeit - a.aehnlichkeit);
  }, [list.data, q, treffer, status]);

  const active = rows.find((d) => d.id === activeId) ?? rows[0];

  const columns: Column<Duplikat>[] = [
    {
      key: "a",
      header: t("personen.duplikate.col.a"),
      width: "283px",
      cell: (d) => (
        <>
          <b>{d.a.name}</b>
          {d.a.nr ? ` · ${d.a.nr}` : ""}
        </>
      ),
    },
    {
      key: "b",
      header: t("personen.duplikate.col.b"),
      width: "283px",
      cell: (d) => eintragText(d.b),
    },
    {
      key: "treffer",
      header: t("personen.duplikate.col.treffer"),
      width: "195px",
      cell: trefferText,
    },
    {
      key: "aehnlichkeit",
      header: t("personen.duplikate.col.aehnlichkeit"),
      width: "118px",
      align: "right",
      cell: (d) => t("personen.duplikate.prozent", { n: d.aehnlichkeit }),
    },
    {
      key: "status",
      header: t("personen.col.status"),
      width: "151px",
      cell: (d) => (
        <Badge tone={d.status === "offen" ? "warning" : "neutral"}>
          {t(`personen.duplikate.status.${d.status}` as "personen.duplikate.status.offen")}
        </Badge>
      ),
    },
  ];

  const mark = async () => {
    if (!active) return;
    setFailed(false);
    try {
      await svc.setKeinDuplikat(active.id);
      notifyChange();
      list.reload();
      toast.show({ tone: "ok", title: t("personen.duplikate.marked") });
    } catch {
      setFailed(true);
    }
  };

  const total = list.data?.length ?? 0;

  return (
    <div className="page">
      <PageHeader
        title={t("personen.duplikate.title")}
        actions={
          <Button icon="refresh" onClick={list.reload}>
            {t("personen.duplikate.recheck")}
          </Button>
        }
      />
      {!svc.features.duplikate ? (
        <div className="state-page">
          <EmptyState
            title={t("personen.duplikate.unavailable.title")}
            text={t("personen.duplikate.unavailable.text")}
          />
        </div>
      ) : (
        <>
          <div className="tool">
            <SearchBox label={t("personen.duplikate.search")} value={q} onChange={setQ} />
            <FilterSelect
              label={t("personen.duplikate.col.treffer")}
              value={treffer}
              onChange={setTreffer}
              options={[
                { value: "", label: t("personen.duplikate.filter.treffer.alle") },
                { value: "name", label: t("personen.duplikate.filter.treffer.name") },
                { value: "uid", label: t("personen.duplikate.filter.treffer.uid") },
                { value: "mwst", label: t("personen.duplikate.filter.treffer.mwst") },
              ]}
            />
            <FilterSelect
              label={t("personen.col.status")}
              value={status}
              onChange={setStatus}
              options={[
                { value: "", label: t("personen.duplikate.filter.status.alle") },
                { value: "offen", label: t("personen.duplikate.filter.status.offen") },
                { value: "kein_duplikat", label: t("personen.duplikate.filter.status.kein") },
              ]}
            />
            <span className="tool__spacer" />
            <span className="muted" aria-live="polite">
              {list.data
                ? t("personen.list.count", { n: formatInt(rows.length), total: formatInt(total) })
                : ""}
            </span>
            <span className="muted">{t("personen.duplikate.sorted")}</span>
          </div>
          {list.error ? (
            <LoadError onRetry={list.reload} />
          ) : !list.data ? (
            <Loading />
          ) : (
            <>
              <div className="pad-x">
                <DataTable
                  label={t("personen.duplikate.title")}
                  columns={columns}
                  rows={rows}
                  rowKey={(d) => d.id}
                  selected={new Set(active ? [active.id] : [])}
                  onRowSelect={(d) => setActiveId(d.id)}
                  sort={SORT}
                  empty={
                    <EmptyState
                      title={t("personen.duplikate.empty.title")}
                      text={t("personen.duplikate.empty.text")}
                    />
                  }
                />
              </div>
              <div className="split split--top">
                <div className="split__main">
                  {active && (
                    <Panel title={t("personen.duplikate.selected")}>
                      <Kv
                        size="wide"
                        rows={[
                          [t("personen.duplikate.col.a"), eintragText(active.a)],
                          [t("personen.duplikate.col.b"), eintragText(active.b)],
                          [t("personen.duplikate.col.treffer"), trefferText(active)],
                          [
                            t("personen.duplikate.col.aehnlichkeit"),
                            t("personen.duplikate.prozent", { n: active.aehnlichkeit }),
                          ],
                        ]}
                      />
                      {failed && (
                        <div className="mt-3">
                          <Message tone="error" title={t("personen.duplikate.failed")} />
                        </div>
                      )}
                      <div className="row mt-4">
                        <Button
                          variant="primary"
                          icon="merge"
                          onClick={() =>
                            tabs.openTab("duplikate-merge", {
                              key: active.id,
                              params: { id: active.id },
                              title: t("personen.merge.tab", { name: active.a.name }),
                            })
                          }
                        >
                          {t("personen.duplikate.merge")}
                        </Button>
                        <Button
                          icon="check"
                          disabled={active.status !== "offen"}
                          onClick={() => void mark()}
                        >
                          {t("personen.duplikate.mark")}
                        </Button>
                      </div>
                    </Panel>
                  )}
                </div>
                <div className="split__main stack stack--md">
                  <Message title={t("personen.duplikate.hint.title")}>
                    {t("personen.duplikate.hint.text")}
                  </Message>
                  <Message tone="warning" title={t("personen.duplikate.final.title")}>
                    {t(
                      svc.features.finanzen
                        ? "personen.duplikate.final.text"
                        : "personen.duplikate.final.textOhneFinanzen",
                    )}
                  </Message>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
