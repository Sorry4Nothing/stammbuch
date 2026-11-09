import { useEffect, useState, type ReactNode } from "react";
import { t, tp } from "../../i18n";
import { useCurrentTab, useTabs } from "../../shell/tabs";
import { useOnTabActivate } from "../../shell/useOnTabActivate";
import {
  Badge,
  Button,
  DataTable,
  Message,
  PageHeader,
  PageTabs,
  Panel,
  type Column,
  formatPhone,
} from "../../ui";
import {
  FormSelect,
  Kv,
  LoadError,
  Loading,
  PDialog,
  PersonStatusBadge,
  dash,
  useAsync,
  useOnChange,
} from "./components";
import { formatChf, formatDate } from "./format";
import type { Finanzen, Firma, PersonDetail, Rechnung } from "./model";
import { useModuleLinks } from "./moduleLinks";
import { usePersonen } from "./service";

const rechnungColumns = (): Column<Rechnung>[] => [
  { key: "nr", header: t("personen.rechnung.nr"), width: "128px", nowrap: true, cell: (r) => r.nr },
  {
    key: "datum",
    header: t("personen.rechnung.datum"),
    width: "108px",
    nowrap: true,
    cell: (r) => formatDate(r.datum),
  },
  {
    key: "betrag",
    header: t("personen.rechnung.betrag"),
    width: "112px",
    align: "right",
    cell: (r) => formatChf(r.betrag),
  },
  {
    key: "status",
    header: t("personen.rechnung.status"),
    nowrap: true,
    cell: (r) => (
      <Badge tone={r.status === "bezahlt" ? "ok" : "warning"}>
        {t(`personen.rechnung.status.${r.status}` as "personen.rechnung.status.offen")}
      </Badge>
    ),
  },
];

export function RechnungenTable({ rows, label }: { rows: Rechnung[]; label: string }) {
  return (
    <DataTable
      label={label}
      columns={rechnungColumns()}
      rows={rows}
      rowKey={(r) => r.nr}
      empty={<span className="muted">{t("personen.rechnung.empty")}</span>}
    />
  );
}

/** Debitorenkonto-Kennzahlen (Boards 3.2, 3.3, 3.10). */
export function KontoList({ finanzen, last }: { finanzen: Finanzen; last?: boolean }) {
  const year = new Date().getFullYear();
  const k = finanzen.konto;
  return (
    <Kv
      rows={[
        [t("personen.konto.offen"), formatChf(k.offen)],
        [t("personen.konto.bezahlt", { year }), formatChf(k.bezahltJahr)],
        [t("personen.konto.mahnstufe"), k.mahnstufe],
        ...(last
          ? ([[t("personen.konto.letzteZahlung"), formatDate(k.letzteZahlung)]] as Array<
              [string, ReactNode]
            >)
          : []),
      ]}
    />
  );
}

/** Detail Einzel- und Firmenmitglied (Design 3.2, 3.3). */
export function PersonDetailPage() {
  const svc = usePersonen();
  const tabs = useTabs();
  const tab = useCurrentTab();
  const id = tab.params["id"] ?? "";
  const [view, setView] = useState("stammdaten");
  const [changing, setChanging] = useState(false);

  const person = useAsync(() => svc.getPerson(id), [svc, id]);
  const finanzen = useAsync(
    () => (svc.features.finanzen ? svc.getFinanzen(id) : Promise.resolve(undefined)),
    [svc, id],
  );
  const firma = useAsync(async (): Promise<Firma | undefined> => {
    const p = person.data;
    return p?.firmaId ? svc.getFirma(p.firmaId) : undefined;
  }, [svc, person.data?.firmaId]);

  const reload = () => {
    person.reload();
    finanzen.reload();
  };
  useOnChange(reload);
  useOnTabActivate(reload);
  const links = useModuleLinks();

  const name = person.data?.name;
  useEffect(() => {
    if (name) tab.setTitle(name);
  }, [tab, name]);

  if (person.error) return <LoadError onRetry={person.reload} />;
  const p = person.data;
  if (!p) return <Loading />;

  const fin = finanzen.data;
  const isFirma = p.typ === "firma";
  const x = svc.features.personExtras;

  const stammdaten = isFirma ? (
    <FirmaPanel person={p} firma={firma.data} onOpen={() => openFirma(p)} extras={x} />
  ) : (
    <Panel title={t("personen.detail.stammdaten")}>
      <Kv
        rows={[
          ...(x ? ([[t("personen.field.nr"), dash(p.nr)]] as Array<[string, ReactNode]>) : []),
          [
            t("personen.field.anrede"),
            p.anrede ? t(`personen.anrede.${p.anrede}` as "personen.anrede.frau") : "–",
          ],
          [t("personen.field.vorname"), dash(p.vorname)],
          [t("personen.field.nachname"), dash(p.nachname)],
          ...(x
            ? ([
                [t("personen.field.geburtsdatum"), formatDate(p.geburtsdatum)],
                [t("personen.field.eintritt"), formatDate(p.eintritt)],
              ] as Array<[string, ReactNode]>)
            : []),
          [t("personen.field.strasse"), dash(p.strasse)],
          [t("personen.detail.plzOrt"), [p.plz, p.ortAdresse].filter(Boolean).join(" ") || "–"],
        ]}
      />
    </Panel>
  );

  function openFirma(person: PersonDetail) {
    if (person.firmaId) {
      tabs.openTab("firma", {
        key: person.firmaId,
        params: { id: person.firmaId },
        title: person.firmaName ?? undefined,
      });
    }
  }

  const kontakt = isFirma ? (
    <Panel title={t("personen.detail.kontakt")}>
      <Kv
        rows={[
          [t("personen.field.kontaktperson"), dash(`${p.vorname} ${p.nachname}`.trim())],
          [t("personen.field.email"), dash(p.email)],
          [t("personen.field.telefon"), dash(formatPhone(p.telefon))],
          ...(svc.features.firmaExtras
            ? ([[t("personen.field.rechnungsEmail"), dash(firma.data?.rechnungsEmail)]] as Array<
                [string, ReactNode]
              >)
            : []),
        ]}
      />
    </Panel>
  ) : (
    <Panel title={t("personen.detail.kontakt")}>
      <Kv
        rows={[
          [t("personen.field.email"), dash(p.email)],
          [t("personen.field.telefon"), dash(formatPhone(p.telefon))],
          ...(x
            ? ([
                [
                  t("personen.field.kanal"),
                  p.kanal ? t(`personen.kanal.${p.kanal}` as "personen.kanal.email") : "–",
                ],
              ] as Array<[string, ReactNode]>)
            : []),
        ]}
      />
    </Panel>
  );

  const left = (
    <div className="stack">
      {stammdaten}
      {kontakt}
      <Panel title={t("personen.detail.bemerkung")}>
        <span>{dash(p.notiz)}</span>
      </Panel>
    </div>
  );

  const right = (
    <div className="stack">
      <Panel title={t("personen.col.gruppe")}>
        {p.gruppeName ? (
          <div className="row">
            <Badge>{p.gruppeName}</Badge>
            {p.gruppeSeit && (
              <span className="muted">
                {t("personen.detail.seit", { date: formatDate(p.gruppeSeit) })}
              </span>
            )}
          </div>
        ) : (
          <span className="muted">{t("personen.detail.keineGruppe")}</span>
        )}
        <div className="mt-3">
          <Button small icon="people" onClick={() => setChanging(true)}>
            {t("personen.detail.gruppeAendern")}
          </Button>
        </div>
      </Panel>
      {fin && (
        <>
          <Panel title={t("personen.detail.konto")}>
            <KontoList finanzen={fin} last />
            {links.openDebtorAccount && (
              <div className="mt-3">
                <Button small icon="book" onClick={() => links.openDebtorAccount?.(p)}>
                  {t("personen.detail.kontoOeffnen")}
                </Button>
              </div>
            )}
          </Panel>
          <Panel title={t("personen.detail.letzteRechnungen")} flush>
            <RechnungenTable
              rows={fin.rechnungen.slice(0, 4)}
              label={t("personen.detail.letzteRechnungen")}
            />
          </Panel>
        </>
      )}
    </div>
  );

  const stamm = (
    <div className="cols">
      <div className="cols__a">{left}</div>
      <div className="cols__b">{right}</div>
    </div>
  );

  const tabsDef = fin
    ? [
        { id: "stammdaten", label: t("personen.detail.tab.stammdaten"), content: stamm },
        {
          id: "rechnungen",
          label: t("personen.detail.tab.rechnungen", { n: fin.rechnungen.length }),
          content: (
            <div className="pad-form">
              <Panel title={t("personen.detail.tab.rechnungenTitel")} flush>
                <RechnungenTable
                  rows={fin.rechnungen}
                  label={t("personen.detail.tab.rechnungenTitel")}
                />
              </Panel>
            </div>
          ),
        },
        {
          id: "mails",
          label: t("personen.detail.tab.mails", { n: fin.mails }),
          content: (
            <div className="pad-form">
              <p className="muted">{tp("personen.detail.mails.text", fin.mails)}</p>
            </div>
          ),
        },
        {
          id: "verlauf",
          label: t("personen.detail.tab.verlauf"),
          content: (
            <div className="pad-form">
              <Panel title={t("personen.detail.tab.verlauf")}>
                {fin.verlauf.length === 0 ? (
                  <span className="muted">{t("personen.detail.verlauf.empty")}</span>
                ) : (
                  <Kv rows={fin.verlauf.map((v) => [formatDate(v.datum), v.text])} />
                )}
              </Panel>
            </div>
          ),
        },
      ]
    : undefined;

  return (
    <div className="page">
      <PageHeader
        crumb={t("personen.detail.crumb", { id: p.nr ?? p.name })}
        title={p.name}
        status={
          <>
            <PersonStatusBadge status={p.status} />
            <Badge>{t(`personen.typ.${p.typ}` as "personen.typ.einzel")}</Badge>
          </>
        }
        actions={
          <>
            {links.writeMail && (
              <Button icon="mail" onClick={() => links.writeMail?.(p)}>
                {t("personen.detail.mail")}
              </Button>
            )}
            {links.createInvoice && (
              <Button icon="invoice" onClick={() => links.createInvoice?.(p)}>
                {t("personen.detail.rechnung")}
              </Button>
            )}
            <Button
              variant="primary"
              icon="edit"
              onClick={() =>
                tabs.openTab("person-form", {
                  key: `edit-${p.id}`,
                  params: { id: p.id },
                  title: t("personen.form.titleEdit.tab", { name: p.name }),
                })
              }
            >
              {t("personen.detail.edit")}
            </Button>
          </>
        }
      />
      {tabsDef ? <PageTabs label={p.name} tabs={tabsDef} value={view} onChange={setView} /> : stamm}
      {changing && (
        <ChangeGroupDialog
          person={p}
          onClose={() => setChanging(false)}
          onDone={() => {
            setChanging(false);
            person.reload();
          }}
        />
      )}
    </div>
  );
}

function FirmaPanel({
  person,
  firma,
  onOpen,
  extras,
}: {
  person: PersonDetail;
  firma: Firma | undefined;
  onOpen: () => void;
  extras: boolean;
}) {
  return (
    <Panel
      title={t("personen.detail.firma")}
      actions={
        <Button small icon="link" onClick={onOpen}>
          {t("personen.detail.firmaOeffnen")}
        </Button>
      }
    >
      <Kv
        rows={[
          [t("personen.field.firmenname"), dash(person.firmaName)],
          [t("personen.field.uid"), dash(firma?.uid)],
          [t("personen.field.mwst"), dash(firma?.mwstNr)],
          [t("personen.field.strasse"), dash(firma?.strasse)],
          [t("personen.detail.plzOrt"), firma ? `${firma.plz} ${firma.ort}` : "–"],
          ...(extras
            ? ([[t("personen.field.eintritt"), formatDate(person.eintritt)]] as Array<
                [string, ReactNode]
              >)
            : []),
        ]}
      />
    </Panel>
  );
}

function ChangeGroupDialog({
  person,
  onClose,
  onDone,
}: {
  person: PersonDetail;
  onClose: () => void;
  onDone: () => void;
}) {
  const svc = usePersonen();
  const gruppen = useAsync(() => svc.listGruppen(), [svc]);
  const [value, setValue] = useState(person.gruppeId ?? "");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(false);
    try {
      await svc.sammelaktion(
        [person.id],
        value ? "gruppe_zuweisen" : "gruppe_entfernen",
        value || undefined,
      );
      onDone();
    } catch {
      setError(true);
      setBusy(false);
    }
  };

  return (
    <PDialog
      title={t("personen.detail.gruppeAendern.title", { name: person.name })}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button variant="primary" type="submit" icon="people" disabled={busy}>
            {t("personen.detail.gruppeAendern.confirm")}
          </Button>
        </>
      }
    >
      {error && <Message tone="error" title={t("personen.detail.gruppeAendern.error")} />}
      <FormSelect
        label={t("personen.col.gruppe")}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        data-autofocus
        options={[
          { value: "", label: t("personen.form.gruppe.keine") },
          ...(gruppen.data ?? []).map((g) => ({ value: g.id, label: g.name })),
        ]}
      />
    </PDialog>
  );
}
