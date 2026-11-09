import { useEffect, useMemo, useState } from "react";
import { t, tp } from "../../i18n";
import { useTabs } from "../../shell/tabs";
import { useOnTabActivate } from "../../shell/useOnTabActivate";
import { Button, DataTable, EmptyState, PageHeader, Panel, type Column } from "../../ui";
import {
  FilterSelect,
  Kv,
  LoadError,
  Loading,
  SearchBox,
  dash,
  useAsync,
  useDebounced,
  useOnChange,
} from "./components";
import { formatDate, formatInt } from "./format";
import type { Firma, FirmaQuelle } from "./model";
import { PersonenNav } from "./PersonenNav";
import { usePersonen } from "./service";

const SORT = { key: "name", direction: "asc" } as const;

/** Firmenregister: Liste mit Seitenfenster (Design 3.9). */
export function FirmenregisterPage() {
  const svc = usePersonen();
  const tabs = useTabs();
  const [q, setQ] = useState("");
  const [quelle, setQuelle] = useState("");
  const dq = useDebounced(q, 250);
  const [extra, setExtra] = useState<Firma[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | undefined>();

  const query = useMemo(
    () => ({ q: dq.trim() || undefined, quelle: (quelle || undefined) as FirmaQuelle | undefined }),
    [dq, quelle],
  );
  const list = useAsync(() => svc.listFirmen(query), [svc, query]);
  useOnChange(list.reload);
  useOnTabActivate(list.reload);
  useEffect(() => {
    setExtra([]);
    setNext(list.data?.next ?? null);
  }, [list.data]);

  const rows = [...(list.data?.items ?? []), ...extra];
  const active = rows.find((f) => f.id === activeId) ?? rows[0];
  const x = svc.features.firmaExtras;

  const more = async () => {
    if (!next) return;
    const page = await svc.listFirmen({ ...query, cursor: next });
    setExtra((e) => [...e, ...page.items]);
    setNext(page.next);
  };

  const open = (f: Firma) =>
    tabs.openTab("firma", { key: f.id, params: { id: f.id }, title: f.name });

  const columns: Column<Firma>[] = [
    {
      key: "name",
      header: t("personen.firmen.col.firma"),
      width: "195px",
      cell: (f) => (
        <button type="button" className="name-link" onClick={() => open(f)}>
          {f.name}
        </button>
      ),
    },
    { key: "uid", header: t("personen.field.uid"), width: "140px", cell: (f) => dash(f.uid) },
    {
      key: "ort",
      header: t("personen.detail.plzOrt"),
      width: "151px",
      cell: (f) => `${f.plz} ${f.ort}`,
    },
    {
      key: "quelle",
      header: t("personen.firmen.col.quelle"),
      width: "151px",
      cell: (f) => (f.quelle ? t(`personen.quelle.${f.quelle}` as "personen.quelle.manuell") : "–"),
    },
    {
      key: "mitglieder",
      header: t("personen.firmen.col.mitglieder"),
      width: "96px",
      align: "right",
      cell: (f) => (f.mitglieder === null ? "–" : formatInt(f.mitglieder)),
    },
  ];

  const total = list.data?.total ?? rows.length;
  const count = next
    ? list.data?.total != null
      ? t("personen.firmen.countOf", { n: formatInt(rows.length), total: formatInt(total) })
      : t("personen.firmen.countLoaded", { n: formatInt(rows.length) })
    : tp("personen.firmen.count", total, { n: formatInt(total) });

  return (
    <div className="page">
      <PageHeader
        title={t("personen.firmen.title")}
        actions={
          <Button variant="primary" icon="plus" onClick={() => tabs.openTab("firma-form")}>
            {t("personen.firmen.new")}
          </Button>
        }
      />
      <PersonenNav current="firmenregister" />
      <div className="tool">
        <SearchBox label={t("personen.firmen.search")} value={q} onChange={setQ} />
        {x && (
          <FilterSelect
            label={t("personen.firmen.col.quelle")}
            value={quelle}
            onChange={setQuelle}
            options={[
              { value: "", label: t("personen.firmen.filter.alle") },
              { value: "manuell", label: t("personen.firmen.filter.manuell") },
              { value: "selbst", label: t("personen.firmen.filter.selbst") },
            ]}
          />
        )}
        <span className="tool__spacer" />
        <span className="muted" aria-live="polite">
          {list.data ? count : ""}
        </span>
      </div>
      {list.error ? (
        <LoadError onRetry={list.reload} />
      ) : !list.data ? (
        <Loading />
      ) : (
        <div className="split">
          <div className="split__main">
            <DataTable
              label={t("personen.firmen.title")}
              columns={columns}
              rows={rows}
              rowKey={(f) => f.id}
              selected={new Set(active ? [active.id] : [])}
              onRowSelect={(f) => setActiveId(f.id)}
              onRowActivate={open}
              sort={SORT}
              empty={
                <EmptyState
                  title={t("personen.firmen.empty.title")}
                  text={t("personen.firmen.empty.text")}
                  actions={
                    <Button
                      variant="primary"
                      icon="plus"
                      onClick={() => tabs.openTab("firma-form")}
                    >
                      {t("personen.firmen.new")}
                    </Button>
                  }
                />
              }
            />
            {next && (
              <div className="mt-3">
                <Button onClick={() => void more()}>{t("personen.list.more")}</Button>
              </div>
            )}
          </div>
          <div className="split__side split__side--340">
            {active && (
              <Panel title={active.name}>
                <Kv
                  size="narrow"
                  rows={[
                    [t("personen.field.uid"), dash(active.uid)],
                    [t("personen.field.mwst"), dash(active.mwstNr)],
                    [t("personen.field.strasse"), dash(active.strasse)],
                    [t("personen.detail.plzOrt"), `${active.plz} ${active.ort}`],
                    ...(active.mitglieder === null
                      ? []
                      : ([
                          [
                            t("personen.firmen.col.mitglieder"),
                            tp("personen.firmen.mitglieder", active.mitglieder),
                          ],
                        ] as Array<[string, string]>)),
                    [t("personen.firmen.registriert"), formatDate(active.erstelltAm)],
                  ]}
                />
                <div className="stack stack--sm mt-3">
                  <Button
                    icon="building"
                    onClick={() =>
                      tabs.openTab("firma", {
                        key: active.id,
                        params: { id: active.id },
                        title: active.name,
                      })
                    }
                  >
                    {t("personen.firmen.open")}
                  </Button>
                  <Button
                    icon="edit"
                    onClick={() =>
                      tabs.openTab("firma-form", {
                        key: `edit-${active.id}`,
                        params: { id: active.id },
                        title: t("personen.firmen.form.titleEdit.tab", { name: active.name }),
                      })
                    }
                  >
                    {t("personen.firmen.edit")}
                  </Button>
                </div>
              </Panel>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
