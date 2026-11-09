import { useEffect, useMemo, useState } from "react";
import { t, tp } from "../../i18n";
import { useCurrentTab, useTabs } from "../../shell/tabs";
import {
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
  FormSelect,
  LoadError,
  PDialog,
  PersonStatusBadge,
  SearchBox,
  dash,
  useAsync,
  useDebounced,
  useOnChange,
} from "./components";
import { formatInt, joinList } from "./format";
import type { PersonRow, PersonStatus, PersonTyp } from "./model";
import { usePersonen } from "./service";

const SORT = { key: "name", direction: "asc" } as const;

interface ListState {
  rows: PersonRow[];
  next: string | null;
  total: number | null;
  loading: boolean;
  error: boolean;
}

/** Mitgliederliste mit Auswahl und Sammelaktionen (Design 3.1). */
export function PersonenListPage() {
  const svc = usePersonen();
  const tabs = useTabs();
  const tab = useCurrentTab();
  const toast = useToast();

  const [q, setQ] = useState("");
  const [typ, setTyp] = useState("");
  const [gruppe, setGruppe] = useState(tab.params["gruppeId"] ?? "");
  const [status, setStatus] = useState("");
  const dq = useDebounced(q, 250);
  const [round, setRound] = useState(0);
  const [state, setState] = useState<ListState>({
    rows: [],
    next: null,
    total: null,
    loading: true,
    error: false,
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assigning, setAssigning] = useState(false);
  const gruppen = useAsync(() => svc.listGruppen(), [svc, round]);

  const filter = useMemo(
    () => ({
      q: dq.trim() || undefined,
      typ: (typ || undefined) as PersonTyp | undefined,
      gruppeId: gruppe || undefined,
      status: (status || undefined) as PersonStatus | undefined,
    }),
    [dq, typ, gruppe, status],
  );

  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: false }));
    svc.listPersonen(filter).then(
      (p) =>
        live &&
        setState({ rows: p.items, next: p.next, total: p.total, loading: false, error: false }),
      () => live && setState((s) => ({ ...s, loading: false, error: true })),
    );
    return () => {
      live = false;
    };
  }, [svc, filter, round]);

  useOnChange(() => setRound((n) => n + 1));

  const more = async () => {
    if (!state.next) return;
    setState((s) => ({ ...s, loading: true }));
    try {
      const p = await svc.listPersonen({ ...filter, cursor: state.next });
      setState((s) => ({
        rows: [...s.rows, ...p.items],
        next: p.next,
        total: p.total,
        loading: false,
        error: false,
      }));
    } catch {
      setState((s) => ({ ...s, loading: false, error: true }));
    }
  };

  const columns: Column<PersonRow>[] = [
    { key: "nr", header: t("personen.col.nr"), width: "85px", cell: (r) => dash(r.nr) },
    { key: "name", header: t("personen.col.name"), width: "206px", cell: (r) => <b>{r.name}</b> },
    {
      key: "typ",
      header: t("personen.col.typ"),
      width: "129px",
      cell: (r) => t(`personen.typ.${r.typ}` as "personen.typ.einzel"),
    },
    { key: "ort", header: t("personen.col.ort"), width: "129px", cell: (r) => dash(r.ort) },
    {
      key: "gruppe",
      header: t("personen.col.gruppe"),
      width: "151px",
      cell: (r) => dash(r.gruppeName),
    },
    {
      key: "status",
      header: t("personen.col.status"),
      width: "118px",
      cell: (r) => <PersonStatusBadge status={r.status} />,
    },
  ];

  const chosen = state.rows.filter((r) => selected.has(r.id));
  const names =
    chosen.length <= 3
      ? joinList(
          chosen.map((r) => r.name),
          t("personen.and"),
        )
      : t("personen.list.selection.more", {
          names: chosen
            .slice(0, 3)
            .map((r) => r.name)
            .join(", "),
          n: chosen.length - 3,
        });

  const count =
    state.total !== null
      ? t("personen.list.count", {
          n: formatInt(state.rows.length),
          total: formatInt(state.total),
        })
      : state.next
        ? t("personen.list.countLoaded", { n: formatInt(state.rows.length) })
        : t("personen.list.count", {
            n: formatInt(state.rows.length),
            total: formatInt(state.rows.length),
          });

  const filtered = Boolean(filter.q || typ || gruppe || status);
  const statusOptions = [
    { value: "", label: t("personen.filter.status.alle") },
    { value: "aktiv", label: t("personen.filter.status.aktiv") },
    ...(svc.features.statusAusstehend
      ? [{ value: "ausstehend", label: t("personen.filter.status.ausstehend") }]
      : []),
    { value: "ausgetreten", label: t("personen.filter.status.ausgetreten") },
  ];

  return (
    <div className="page">
      <PageHeader
        title={t("personen.list.title")}
        actions={
          <>
            <Button
              icon="upload"
              onClick={() => tabs.openTab("personen-import", { key: "import" })}
            >
              {t("personen.list.import")}
            </Button>
            <Button variant="primary" icon="plus" onClick={() => tabs.openTab("person-form")}>
              {t("personen.list.new")}
            </Button>
          </>
        }
      />
      <div className="tool">
        <SearchBox label={t("personen.list.search")} value={q} onChange={setQ} />
        <FilterSelect
          label={t("personen.col.typ")}
          value={typ}
          onChange={setTyp}
          options={[
            { value: "", label: t("personen.filter.typ.alle") },
            { value: "einzel", label: t("personen.filter.typ.einzel") },
            { value: "firma", label: t("personen.filter.typ.firma") },
          ]}
        />
        <FilterSelect
          label={t("personen.col.gruppe")}
          value={gruppe}
          onChange={setGruppe}
          options={[
            { value: "", label: t("personen.filter.gruppe.alle") },
            ...(gruppen.data ?? []).map((g) => ({
              value: g.id,
              label: t("personen.filter.gruppe.name", { name: g.name }),
            })),
            { value: "ohne", label: t("personen.filter.gruppe.ohne") },
          ]}
        />
        <FilterSelect
          label={t("personen.col.status")}
          value={status}
          onChange={setStatus}
          options={statusOptions}
        />
        <span className="tool__spacer" />
        <span className="muted" aria-live="polite">
          {state.loading && state.rows.length === 0 ? "" : count}
        </span>
        <span className="muted">{t("personen.list.sorted")}</span>
      </div>

      <div className="split">
        <div className="split__main">
          {state.error ? (
            <LoadError onRetry={() => setRound((n) => n + 1)} />
          ) : (
            <>
              <DataTable
                label={t("personen.list.title")}
                columns={columns}
                rows={state.rows}
                rowKey={(r) => r.id}
                selectable
                selected={selected}
                onSelectedChange={setSelected}
                sort={SORT}
                onRowActivate={(r) =>
                  tabs.openTab("person", { key: r.id, params: { id: r.id }, title: r.name })
                }
                empty={
                  state.loading ? (
                    <span role="status" className="is-loading">
                      {t("personen.loading")}
                    </span>
                  ) : filtered ? (
                    <EmptyState
                      title={t("personen.list.noHits.title")}
                      text={t("personen.list.noHits.text")}
                    />
                  ) : (
                    <EmptyState
                      title={t("personen.list.empty.title")}
                      text={t("personen.list.empty.text")}
                      actions={
                        <Button
                          variant="primary"
                          icon="plus"
                          onClick={() => tabs.openTab("person-form")}
                        >
                          {t("personen.list.new")}
                        </Button>
                      }
                    />
                  )
                }
              />
              {state.next && (
                <div className="mt-3">
                  <Button onClick={() => void more()} disabled={state.loading}>
                    {t("personen.list.more")}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        {selected.size > 0 && (
          <div className="split__side split__side--280">
            <Panel title={t("personen.list.selection.title", { n: selected.size })}>
              <div className="stack stack--sm">
                <span className="muted">{names}</span>
                <Button icon="people" onClick={() => setAssigning(true)}>
                  {t("personen.list.selection.assign")}
                </Button>
                <Button icon="mail" disabled title={t("personen.list.selection.later")}>
                  {t("personen.list.selection.mail")}
                </Button>
                <Button icon="list" disabled title={t("personen.list.selection.later")}>
                  {t("personen.list.selection.list")}
                </Button>
                <div className="rule" />
                <Button variant="ghost" onClick={() => setSelected(new Set())}>
                  {t("personen.list.selection.clear")}
                </Button>
              </div>
            </Panel>
            <Message title={t("personen.list.selection.hint.title")}>
              {tp("personen.list.selection.hint", selected.size)}
            </Message>
          </div>
        )}
      </div>

      {assigning && (
        <AssignDialog
          count={selected.size}
          groups={gruppen.data ?? []}
          onClose={() => setAssigning(false)}
          onAssign={async (gruppeId) => {
            const ids = [...selected];
            const r = await svc.sammelaktion(
              ids,
              gruppeId ? "gruppe_zuweisen" : "gruppe_entfernen",
              gruppeId || undefined,
            );
            setAssigning(false);
            setSelected(new Set());
            setRound((n) => n + 1);
            toast.show({
              tone: r.fehler > 0 ? "warning" : "ok",
              title: tp("personen.list.assign.done", r.ok),
              text: r.fehler > 0 ? tp("personen.list.assign.failed", r.fehler) : undefined,
            });
          }}
        />
      )}
    </div>
  );
}

function AssignDialog({
  count,
  groups,
  onClose,
  onAssign,
}: {
  count: number;
  groups: { id: string; name: string }[];
  onClose: () => void;
  onAssign: (gruppeId: string) => Promise<void>;
}) {
  const [gruppeId, setGruppeId] = useState(groups[0]?.id ?? "");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(false);
    try {
      await onAssign(gruppeId);
    } catch {
      setError(true);
      setBusy(false);
    }
  };
  return (
    <PDialog
      title={tp("personen.list.assign.title", count)}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button variant="primary" type="submit" icon="people" disabled={busy}>
            {t("personen.list.selection.assign")}
          </Button>
        </>
      }
    >
      {error && <Message tone="error" title={t("personen.list.assign.error")} />}
      <FormSelect
        label={t("personen.col.gruppe")}
        value={gruppeId}
        onChange={(e) => setGruppeId(e.target.value)}
        data-autofocus
        options={[
          ...groups.map((g) => ({ value: g.id, label: g.name })),
          { value: "", label: t("personen.form.gruppe.keine") },
        ]}
      />
      <Message title={t("personen.list.selection.hint.title")}>
        {tp("personen.list.selection.hint", count)}
      </Message>
    </PDialog>
  );
}
