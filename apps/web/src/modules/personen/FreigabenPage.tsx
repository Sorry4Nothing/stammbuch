import { useEffect, useMemo, useState } from "react";
import { t } from "../../i18n";
import { useTabs } from "../../shell/tabs";
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
  FirmaStatusBadge,
  Kv,
  LoadError,
  Loading,
  SearchBox,
  dash,
  notifyChange,
  useAsync,
  useOnChange,
} from "./components";
import { formatDateTime, formatInt } from "./format";
import type { Firma, FirmaInput } from "./model";
import { usePersonen } from "./service";

const SORT = { key: "eingang", direction: "desc" } as const;

const asInput = (f: Firma): FirmaInput => ({
  name: f.name,
  uid: f.uid ?? undefined,
  mwstNr: f.mwstNr ?? undefined,
  strasse: f.strasse,
  plz: f.plz,
  ort: f.ort,
});

/** Freigabe selbst registrierter Firmen (Design 3.14). */
export function FreigabenPage() {
  const svc = usePersonen();
  const tabs = useTabs();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [activeId, setActiveId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const list = useAsync(async () => {
    const page = await svc.listFirmen({ status: "alle" });
    // Nur selbst registrierte Firmen, soweit der Dienst die Quelle kennt.
    return page.items
      .filter((f) => f.quelle === null || f.quelle === "selbst")
      .sort((a, b) => b.erstelltAm.localeCompare(a.erstelltAm));
  }, [svc]);
  useOnChange(list.reload);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list.data ?? []).filter(
      (f) =>
        (!status || f.status === status) &&
        (!needle ||
          f.name.toLowerCase().includes(needle) ||
          (f.uid ?? "").toLowerCase().includes(needle)),
    );
  }, [list.data, q, status]);

  useEffect(() => {
    if (!rows.some((f) => f.id === activeId)) setActiveId(rows[0]?.id);
  }, [rows, activeId]);
  const active = rows.find((f) => f.id === activeId);

  const duplicates = useAsync(
    () => (active ? svc.firmaDuplikate(asInput(active), active.id) : Promise.resolve([])),
    [svc, active?.id],
  );

  const decide = async (freigeben: boolean) => {
    if (!active) return;
    setBusy(true);
    setFailed(false);
    try {
      await svc.setFirmaFreigabe(active.id, freigeben);
      notifyChange();
      list.reload();
      toast.show({
        tone: "ok",
        title: t(freigeben ? "personen.freigaben.approved" : "personen.freigaben.rejected"),
      });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<Firma>[] = [
    {
      key: "name",
      header: t("personen.firmen.col.firma"),
      width: "228px",
      cell: (f) => <b>{f.name}</b>,
    },
    { key: "uid", header: t("personen.field.uid"), width: "162px", cell: (f) => dash(f.uid) },
    {
      key: "eingang",
      header: t("personen.freigaben.col.eingang"),
      width: "173px",
      cell: (f) => formatDateTime(f.erstelltAm),
    },
    {
      key: "status",
      header: t("personen.col.status"),
      width: "140px",
      cell: (f) => <FirmaStatusBadge status={f.status} />,
    },
  ];

  const total = list.data?.length ?? 0;
  const hits = duplicates.data ?? [];

  return (
    <div className="page">
      <PageHeader
        title={t("personen.freigaben.title")}
        actions={
          <Button
            icon="building"
            onClick={() => tabs.openTab("firmenregister", { key: "firmenregister" })}
          >
            {t("personen.freigaben.register")}
          </Button>
        }
      />
      <div className="tool">
        <SearchBox label={t("personen.freigaben.search")} value={q} onChange={setQ} />
        <FilterSelect
          label={t("personen.col.status")}
          value={status}
          onChange={setStatus}
          options={[
            { value: "", label: t("personen.freigaben.filter.alle") },
            { value: "ausstehend", label: t("personen.freigaben.filter.ausstehend") },
            { value: "freigegeben", label: t("personen.freigaben.filter.freigegeben") },
            { value: "abgelehnt", label: t("personen.freigaben.filter.abgelehnt") },
          ]}
        />
        <span className="tool__spacer" />
        <span className="muted" aria-live="polite">
          {list.data
            ? t("personen.list.count", { n: formatInt(rows.length), total: formatInt(total) })
            : ""}
        </span>
        <span className="muted">{t("personen.freigaben.sorted")}</span>
      </div>
      {list.error ? (
        <LoadError onRetry={list.reload} />
      ) : !list.data ? (
        <Loading />
      ) : (
        <div className="split">
          <div className="split__main">
            <DataTable
              label={t("personen.freigaben.table")}
              columns={columns}
              rows={rows}
              rowKey={(f) => f.id}
              selected={new Set(activeId ? [activeId] : [])}
              onRowSelect={(f) => setActiveId(f.id)}
              sort={SORT}
              empty={
                <EmptyState
                  icon="check"
                  title={t("personen.freigaben.empty.title")}
                  text={t("personen.freigaben.empty.text")}
                />
              }
            />
            <div className="mt-4">
              <Message title={t("personen.freigaben.hint.title")}>
                {t("personen.freigaben.hint.text")}
              </Message>
            </div>
          </div>
          <div className="split__side split__side--380">
            {failed && <Message tone="error" title={t("personen.freigaben.failed")} />}
            {active && (
              <>
                <Panel title={active.name}>
                  <Kv
                    size="narrow"
                    rows={[
                      [t("personen.field.uid"), dash(active.uid)],
                      [t("personen.field.mwst"), dash(active.mwstNr)],
                      [
                        t("personen.freigaben.adresse"),
                        `${active.strasse}, ${active.plz} ${active.ort}`,
                      ],
                      ...(svc.features.firmaExtras
                        ? ([[t("personen.freigaben.kontakt"), dash(active.kontaktperson)]] as Array<
                            [string, string]
                          >)
                        : []),
                      [t("personen.field.email"), dash(active.email)],
                      [t("personen.freigaben.eingegangen"), formatDateTime(active.erstelltAm)],
                    ]}
                  />
                  <div className="stack stack--sm mt-3">
                    <Button
                      variant="primary"
                      icon="check"
                      disabled={busy || active.status !== "ausstehend"}
                      onClick={() => void decide(true)}
                    >
                      {t("personen.freigaben.approve")}
                    </Button>
                    <Button
                      icon="block"
                      disabled={busy || active.status !== "ausstehend"}
                      onClick={() => void decide(false)}
                    >
                      {t("personen.freigaben.reject")}
                    </Button>
                  </div>
                </Panel>
                {duplicates.data &&
                  (hits.length === 0 ? (
                    <Message tone="ok" title={t("personen.freigaben.noDup.title")}>
                      {t("personen.freigaben.noDup.text")}
                    </Message>
                  ) : (
                    <Message tone="warning" title={t("personen.freigaben.dup.title")}>
                      {t("personen.freigaben.dup.text", {
                        names: hits.map((h) => h.firma.name).join(", "),
                      })}
                    </Message>
                  ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
