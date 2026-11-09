import { useMemo, useState } from "react";
import { t, tp } from "../../i18n";
import { useTabs } from "../../shell/tabs";
import { useOnTabActivate } from "../../shell/useOnTabActivate";
import {
  Button,
  DataTable,
  EmptyState,
  Message,
  PageHeader,
  Panel,
  useToast,
  type Column,
  type Sort,
} from "../../ui";
import {
  FormInput,
  FormTextArea,
  Kv,
  LoadError,
  Loading,
  PDialog,
  SearchBox,
  dash,
  notifyChange,
  useAsync,
  useOnChange,
} from "./components";
import { formatDate, formatInt, joinList } from "./format";
import { ApiError, FieldErrors, type Gruppe } from "./model";
import { PersonenNav } from "./PersonenNav";
import { usePersonen } from "./service";

/** Zeile der Tabelle: eine Gruppe oder der Sammelposten «Personen ohne Gruppe». */
type Row = { kind: "gruppe"; gruppe: Gruppe } | { kind: "ohne"; count: number };

type Dialog = { kind: "create" } | { kind: "rename" | "dissolve"; gruppe: Gruppe };

/** Gruppen: Liste, anlegen, umbenennen, auflösen (Design 3.5 bis 3.8). */
export function GruppenPage() {
  const svc = usePersonen();
  const tabs = useTabs();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "name", direction: "asc" });
  const [activeId, setActiveId] = useState<string | undefined>();
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const data = useAsync(async () => {
    const [gruppen, ohne] = await Promise.all([svc.listGruppen(), svc.countOhneGruppe()]);
    return { gruppen, ohne };
  }, [svc]);
  useOnChange(data.reload);
  useOnTabActivate(data.reload);

  const gruppen = useMemo(() => data.data?.gruppen ?? [], [data.data]);
  const sorted = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const dir = sort.direction === "asc" ? 1 : -1;
    return gruppen
      .filter((g) => !needle || g.name.toLowerCase().includes(needle))
      .sort((a, b) =>
        sort.key === "mitglieder"
          ? (a.mitglieder - b.mitglieder) * dir || a.name.localeCompare(b.name, "de-CH")
          : a.name.localeCompare(b.name, "de-CH") * dir,
      );
  }, [gruppen, q, sort]);

  const rows: Row[] = [
    ...sorted.map((gruppe): Row => ({ kind: "gruppe", gruppe })),
    ...(data.data?.ohne != null && !q.trim()
      ? [{ kind: "ohne", count: data.data.ohne } satisfies Row]
      : []),
  ];

  // Wie im Board ist anfangs die erste Gruppe gewählt.
  const active = gruppen.find((g) => g.id === activeId) ?? sorted[0];

  const x = svc.features.gruppenDetails;

  const columns: Column<Row>[] = [
    {
      key: "name",
      header: t("personen.gruppen.col.gruppe"),
      sortable: true,
      cell: (r) =>
        r.kind === "gruppe" ? (
          <b>{r.gruppe.name}</b>
        ) : (
          <span className="muted">{t("personen.gruppen.ohne")}</span>
        ),
    },
    {
      key: "mitglieder",
      header: t("personen.gruppen.col.mitglieder"),
      width: "118px",
      align: "right",
      sortable: true,
      cell: (r) => formatInt(r.kind === "gruppe" ? r.gruppe.mitglieder : r.count),
    },
    {
      key: "angelegt",
      header: t("personen.gruppen.col.angelegt"),
      width: "140px",
      cell: (r) => (r.kind === "gruppe" ? formatDate(r.gruppe.angelegt) : "–"),
    },
    {
      key: "aktion",
      header: t("personen.gruppen.col.aktion"),
      width: "96px",
      cell: (r) =>
        r.kind === "gruppe" ? (
          <Button
            variant="ghost"
            small
            icon="edit"
            aria-label={t("personen.gruppen.renameLabel", { name: r.gruppe.name })}
            onClick={() => setDialog({ kind: "rename", gruppe: r.gruppe })}
          />
        ) : null,
    },
  ];

  const done = (text: string) => {
    setDialog(null);
    data.reload();
    notifyChange();
    toast.show({ tone: "ok", title: text });
  };

  return (
    <div className="page">
      <PageHeader
        title={t("personen.gruppen.title")}
        actions={
          <Button variant="primary" icon="plus" onClick={() => setDialog({ kind: "create" })}>
            {t("personen.gruppen.new")}
          </Button>
        }
      />
      <PersonenNav current="gruppen" />
      <div className="tool">
        <SearchBox label={t("personen.gruppen.search")} value={q} onChange={setQ} />
        <span className="tool__spacer" />
        <span className="muted" aria-live="polite">
          {data.data ? tp("personen.gruppen.count", sorted.length) : ""}
        </span>
      </div>

      {data.error ? (
        <LoadError onRetry={data.reload} />
      ) : !data.data ? (
        <Loading />
      ) : (
        <div className="split">
          <div className="split__main">
            <DataTable
              label={t("personen.gruppen.title")}
              columns={columns}
              rows={rows}
              rowKey={(r) => (r.kind === "gruppe" ? r.gruppe.id : "ohne")}
              selected={new Set(active ? [active.id] : [])}
              onRowSelect={(r) => r.kind === "gruppe" && setActiveId(r.gruppe.id)}
              sort={sort}
              onSortChange={setSort}
              empty={
                <EmptyState
                  title={t("personen.gruppen.empty.title")}
                  text={t("personen.gruppen.empty.text")}
                />
              }
            />
          </div>
          <div className="split__side split__side--420">
            {active && (
              <Panel title={t("personen.gruppen.detail.title", { name: active.name })}>
                <Kv
                  size="wide"
                  rows={[
                    [t("personen.gruppen.col.mitglieder"), formatInt(active.mitglieder)],
                    ...(x
                      ? ([
                          [t("personen.gruppen.col.angelegt"), formatDate(active.angelegt)],
                          [t("personen.gruppen.detail.geaendert"), formatDate(active.geaendert)],
                          [
                            t("personen.gruppen.detail.adresslisten"),
                            dash(String(active.adresslisten?.length ?? "")),
                          ],
                        ] as Array<[string, string]>)
                      : []),
                  ]}
                />
                <div className="stack stack--sm mt-3">
                  <Button
                    icon="people"
                    onClick={() =>
                      tabs.openTab("personen", {
                        key: `gruppe-${active.id}`,
                        params: { gruppeId: active.id },
                        title: active.name,
                      })
                    }
                  >
                    {t("personen.gruppen.detail.show")}
                  </Button>
                  <Button icon="edit" onClick={() => setDialog({ kind: "rename", gruppe: active })}>
                    {t("personen.gruppen.detail.rename")}
                  </Button>
                  <Button
                    icon="trash"
                    onClick={() => setDialog({ kind: "dissolve", gruppe: active })}
                  >
                    {t("personen.gruppen.detail.dissolve")}
                  </Button>
                </div>
              </Panel>
            )}
          </div>
        </div>
      )}

      {dialog?.kind === "create" && (
        <CreateDialog
          names={gruppen.map((g) => g.name)}
          description={x}
          onClose={() => setDialog(null)}
          onSave={async (name, beschreibung) => {
            await svc.createGruppe(name, beschreibung);
            done(t("personen.gruppen.created"));
          }}
        />
      )}
      {dialog?.kind === "rename" && (
        <RenameDialog
          gruppe={dialog.gruppe}
          names={gruppen.map((g) => g.name)}
          onClose={() => setDialog(null)}
          onSave={async (name) => {
            await svc.renameGruppe(dialog.gruppe.id, name);
            done(t("personen.gruppen.renamed"));
          }}
        />
      )}
      {dialog?.kind === "dissolve" && (
        <DissolveDialog
          gruppe={dialog.gruppe}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await svc.dissolveGruppe(dialog.gruppe.id);
            done(t("personen.gruppen.dissolved"));
          }}
        />
      )}
    </div>
  );
}

/** Gemeinsame Behandlung von Speichern in den Dialogen: Namensfehler am Feld, sonst Fehlermeldung. */
function useSubmit(check: () => string | undefined, action: () => Promise<void>) {
  const [error, setError] = useState<string | undefined>();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setFailed(false);
    const invalid = check();
    setError(invalid);
    if (invalid) return;
    setBusy(true);
    try {
      await action();
    } catch (e) {
      if (e instanceof FieldErrors) setError(e.fields["name"] ?? t("personen.gruppen.error.name"));
      else if (e instanceof ApiError && e.status === 409)
        setError(t("personen.gruppen.error.duplicate"));
      else setFailed(true);
      setBusy(false);
    }
  };
  return { error, failed, busy, run };
}

const taken = (names: string[], name: string, except?: string) =>
  names.some((n) => n.toLowerCase() === name.toLowerCase() && n !== except);

function CreateDialog({
  names,
  description,
  onClose,
  onSave,
}: {
  names: string[];
  description: boolean;
  onClose: () => void;
  onSave: (name: string, beschreibung?: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const submit = useSubmit(
    () =>
      !name.trim()
        ? t("personen.gruppen.error.required")
        : taken(names, name.trim())
          ? t("personen.gruppen.error.duplicate")
          : undefined,
    () => onSave(name.trim(), text.trim() || undefined),
  );
  return (
    <PDialog
      title={t("personen.gruppen.create.title")}
      onClose={onClose}
      onSubmit={() => void submit.run()}
      footer={
        <>
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button variant="primary" type="submit" icon="plus" disabled={submit.busy}>
            {t("personen.gruppen.create.confirm")}
          </Button>
        </>
      }
    >
      {submit.failed && <Message tone="error" title={t("personen.gruppen.create.failed")} />}
      <FormInput
        label={t("personen.gruppen.create.name")}
        required
        value={name}
        error={submit.error}
        onChange={(e) => setName(e.target.value)}
        data-autofocus
      />
      {description && (
        <FormTextArea
          label={t("personen.gruppen.create.description")}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
    </PDialog>
  );
}

function RenameDialog({
  gruppe,
  names,
  onClose,
  onSave,
}: {
  gruppe: Gruppe;
  names: string[];
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(gruppe.name);
  const submit = useSubmit(
    () =>
      !name.trim()
        ? t("personen.gruppen.error.required")
        : taken(names, name.trim(), gruppe.name)
          ? t("personen.gruppen.error.duplicate")
          : undefined,
    () => onSave(name.trim()),
  );
  return (
    <PDialog
      title={t("personen.gruppen.rename.title", { name: gruppe.name })}
      onClose={onClose}
      onSubmit={() => void submit.run()}
      footer={
        <>
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button variant="primary" type="submit" icon="edit" disabled={submit.busy}>
            {t("personen.gruppen.rename.confirm")}
          </Button>
        </>
      }
    >
      {submit.failed && <Message tone="error" title={t("personen.gruppen.rename.failed")} />}
      <FormInput
        label={t("personen.gruppen.rename.name")}
        required
        value={name}
        error={submit.error}
        onChange={(e) => setName(e.target.value)}
        data-autofocus
      />
    </PDialog>
  );
}

function DissolveDialog({
  gruppe,
  onClose,
  onConfirm,
}: {
  gruppe: Gruppe;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const submit = useSubmit(() => undefined, onConfirm);
  const lists = gruppe.adresslisten ?? [];
  const listText =
    lists.length > 0
      ? `${tp("personen.gruppen.dissolve.lists", lists.length, {
          names: joinList(
            lists.map((l) => `«${l}»`),
            t("personen.and"),
          ),
        })} `
      : "";
  return (
    <PDialog
      title={t("personen.gruppen.dissolve.title", { name: gruppe.name })}
      width={540}
      onClose={onClose}
      onSubmit={() => typed === gruppe.name && void submit.run()}
      footer={
        <>
          <Button data-autofocus onClick={onClose}>
            {t("ui.cancel")}
          </Button>
          <Button
            variant="danger"
            type="submit"
            icon="trash"
            disabled={typed !== gruppe.name || submit.busy}
          >
            {t("personen.gruppen.dissolve.confirm")}
          </Button>
        </>
      }
    >
      {submit.failed && <Message tone="error" title={t("personen.gruppen.dissolve.failed")} />}
      <Message
        tone="warning"
        title={tp("personen.gruppen.dissolve.warning.title", gruppe.mitglieder)}
      >
        {t("personen.gruppen.dissolve.warning.text", { lists: listText })}
      </Message>
      <FormInput
        label={t("personen.gruppen.dissolve.label")}
        required
        value={typed}
        hint={t("personen.gruppen.dissolve.hint", { name: gruppe.name })}
        onChange={(e) => setTyped(e.target.value)}
        autoComplete="off"
      />
    </PDialog>
  );
}
