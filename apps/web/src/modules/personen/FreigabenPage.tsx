import { useMemo, useState } from "react";
import { t, tp } from "../../i18n";
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
  formatPhone,
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
import { formatDate, formatDateTime, formatInt } from "./format";
import type { Firma, FirmaInput, FirmaStatus, PersonDetail } from "./model";
import { PersonenNav } from "./PersonenNav";
import { usePersonen } from "./service";

const SORT = { key: "eingang", direction: "desc" } as const;

/** Eine Registrierung in der Liste: Firma oder Person. */
interface Eintrag {
  art: "firma" | "person";
  id: string;
  name: string;
  /** UID der Firma bzw. E-Mail-Adresse der Person. */
  kennung: string | null;
  erstelltAm: string;
  status: FirmaStatus;
  firma?: Firma;
  person?: PersonDetail;
}

const personStatus = (p: PersonDetail): FirmaStatus =>
  p.status === "ausstehend" ? "ausstehend" : p.status === "abgelehnt" ? "abgelehnt" : "freigegeben";

const asInput = (f: Firma): FirmaInput => ({
  name: f.name,
  uid: f.uid ?? undefined,
  mwstNr: f.mwstNr ?? undefined,
  strasse: f.strasse,
  plz: f.plz,
  ort: f.ort,
});

const key = (e: Eintrag) => `${e.art}:${e.id}`;

/** Angaben zur gewählten Registrierung. */
function details(e: Eintrag, firmaExtras: boolean): Array<[string, string]> {
  const f = e.firma;
  if (f) {
    return [
      [t("personen.field.uid"), dash(f.uid)],
      [t("personen.field.mwst"), dash(f.mwstNr)],
      [t("personen.freigaben.adresse"), `${f.strasse}, ${f.plz} ${f.ort}`],
      ...(firmaExtras
        ? ([[t("personen.freigaben.kontakt"), dash(f.kontaktperson)]] as Array<[string, string]>)
        : []),
      [t("personen.field.email"), dash(f.email)],
      [t("personen.freigaben.eingegangen"), formatDateTime(f.erstelltAm)],
    ];
  }
  const p = e.person as PersonDetail;
  return [
    [t("personen.freigaben.geburtsdatum"), formatDate(p.geburtsdatum)],
    [
      t("personen.freigaben.adresse"),
      [p.strasse, [p.plz, p.ortAdresse].filter(Boolean).join(" ")].filter(Boolean).join(", ") ||
        "–",
    ],
    [t("personen.field.email"), dash(p.email)],
    [t("personen.field.telefon"), dash(formatPhone(p.telefon))],
    [t("personen.freigaben.eingegangen"), p.erstelltAm ? formatDateTime(p.erstelltAm) : "–"],
  ];
}

/** Freigabe selbst registrierter Personen und Firmen (Design 3.14). */
export function FreigabenPage() {
  const svc = usePersonen();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [activeId, setActiveId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const list = useAsync(async (): Promise<Eintrag[]> => {
    const [firmen, personen] = await Promise.all([
      svc.listFirmen({ status: "alle" }),
      svc.features.statusAusstehend ? svc.listPersonenFreigaben() : Promise.resolve([]),
    ]);
    // Nur selbst registrierte Firmen, soweit der Dienst die Quelle kennt.
    const eintraege: Eintrag[] = [
      ...firmen.items
        .filter((f) => f.quelle === null || f.quelle === "selbst")
        .map((f): Eintrag => ({
          art: "firma",
          id: f.id,
          name: f.name,
          kennung: f.uid,
          erstelltAm: f.erstelltAm,
          status: f.status,
          firma: f,
        })),
      ...personen.map((p): Eintrag => ({
        art: "person",
        id: p.id,
        name: p.name,
        kennung: p.email,
        erstelltAm: p.erstelltAm ?? "",
        status: personStatus(p),
        person: p,
      })),
    ];
    return eintraege.sort((a, b) => b.erstelltAm.localeCompare(a.erstelltAm));
  }, [svc]);
  const duplikate = useAsync(
    () => (svc.features.duplikate ? svc.listDuplikate() : Promise.resolve([])),
    [svc],
  );
  const reload = () => {
    list.reload();
    duplikate.reload();
  };
  useOnChange(list.reload);
  useOnTabActivate(reload);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list.data ?? []).filter(
      (f) =>
        (!status || f.status === status) &&
        (!needle ||
          f.name.toLowerCase().includes(needle) ||
          (f.kennung ?? "").toLowerCase().includes(needle)),
    );
  }, [list.data, q, status]);

  const active = rows.find((f) => key(f) === activeId) ?? rows[0];

  // Firmen: Vorab-Prüfung wie beim Anlegen. Personen: offene Paare aus der Duplikatsuche.
  const firmaHits = useAsync(
    () =>
      active?.firma ? svc.firmaDuplikate(asInput(active.firma), active.id) : Promise.resolve([]),
    [svc, active?.id],
  );
  const hitNames = active?.firma
    ? (firmaHits.data ?? []).map((h) => h.firma.name)
    : (duplikate.data ?? [])
        .filter((d) => d.status === "offen" && (d.a.id === active?.id || d.b.id === active?.id))
        .map((d) => (d.a.id === active?.id ? d.b.name : d.a.name));
  const hitsReady = active?.firma ? firmaHits.data !== undefined : duplikate.data !== undefined;

  const decide = async (freigeben: boolean) => {
    if (!active) return;
    setBusy(true);
    setFailed(false);
    try {
      if (active.art === "firma") await svc.setFirmaFreigabe(active.id, freigeben);
      else await svc.setPersonFreigabe(active.id, freigeben);
      notifyChange();
      list.reload();
      duplikate.reload();
      const person = active.art === "person" ? ".person" : "";
      toast.show({
        tone: "ok",
        title: t(
          `personen.freigaben.${freigeben ? "approved" : "rejected"}${person}` as "personen.freigaben.approved",
        ),
      });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<Eintrag>[] = [
    {
      key: "name",
      header: t("personen.freigaben.col.name"),
      cell: (f) => <b>{f.name}</b>,
    },
    {
      key: "art",
      header: t("personen.freigaben.col.art"),
      width: "72px",
      cell: (f) => t(`personen.freigaben.art.${f.art}` as "personen.freigaben.art.firma"),
    },
    {
      key: "kennung",
      header: t("personen.freigaben.col.kennung"),
      width: "140px",
      cell: (f) => dash(f.kennung),
    },
    {
      key: "eingang",
      header: t("personen.freigaben.col.eingang"),
      width: "150px",
      cell: (f) => formatDateTime(f.erstelltAm),
    },
    {
      key: "status",
      header: t("personen.col.status"),
      width: "114px",
      cell: (f) => <FirmaStatusBadge status={f.status} />,
    },
  ];

  return (
    <div className="page">
      <PageHeader title={t("personen.freigaben.title")} />
      <PersonenNav current="firma-freigaben" />
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
            ? tp("personen.freigaben.count", rows.length, { n: formatInt(rows.length) })
            : ""}
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
              label={t("personen.freigaben.table")}
              columns={columns}
              rows={rows}
              rowKey={key}
              selected={new Set(active ? [key(active)] : [])}
              onRowSelect={(f) => setActiveId(key(f))}
              sort={SORT}
              empty={
                <EmptyState
                  title={t("personen.freigaben.empty.title")}
                  text={t("personen.freigaben.empty.text")}
                />
              }
            />
          </div>
          <div className="split__side split__side--380">
            {failed && <Message tone="error" title={t("personen.freigaben.failed")} />}
            {active && (
              <>
                <Panel title={active.name}>
                  <Kv size="narrow" rows={details(active, svc.features.firmaExtras)} />
                  <div className="stack stack--sm mt-3">
                    <Button
                      variant="primary"
                      icon="check"
                      disabled={busy || active.status !== "ausstehend"}
                      onClick={() => void decide(true)}
                    >
                      {t(
                        active.art === "firma"
                          ? "personen.freigaben.approve"
                          : "personen.freigaben.approve.person",
                      )}
                    </Button>
                    <Button
                      icon="block"
                      disabled={busy || active.status !== "ausstehend"}
                      onClick={() => void decide(false)}
                    >
                      {t(
                        active.art === "firma"
                          ? "personen.freigaben.reject"
                          : "personen.freigaben.reject.person",
                      )}
                    </Button>
                  </div>
                </Panel>
                {hitsReady && hitNames.length > 0 && (
                  <Message tone="warning" title={t("personen.freigaben.dup.title")}>
                    {t(
                      active.art === "firma"
                        ? "personen.freigaben.dup.text"
                        : "personen.freigaben.dup.person.text",
                      { names: hitNames.join(", ") },
                    )}
                  </Message>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
