import { useEffect, type ReactNode } from "react";
import { t } from "../../i18n";
import { useCurrentTab, useTabs } from "../../shell/tabs";
import { Button, DataTable, PageHeader, Panel, type Column } from "../../ui";
import {
  FirmaStatusBadge,
  Kv,
  LoadError,
  Loading,
  PersonStatusBadge,
  dash,
  useAsync,
  useOnChange,
} from "./components";
import { formatDate } from "./format";
import type { PersonDetail } from "./model";
import { KontoList, RechnungenTable } from "./PersonDetailPage";
import { usePersonen } from "./service";

/** Firma im Register mit Kontaktpersonen, Mitgliedern und Konto (Design 3.10). */
export function FirmaDetailPage() {
  const svc = usePersonen();
  const tabs = useTabs();
  const tab = useCurrentTab();
  const id = tab.params["id"] ?? "";
  const firma = useAsync(() => svc.getFirma(id), [svc, id]);
  const mitglieder = useAsync(() => svc.firmaMitglieder(id), [svc, id]);
  const finanzen = useAsync(
    () => (svc.features.finanzen ? svc.getFinanzen(id) : Promise.resolve(undefined)),
    [svc, id],
  );
  useOnChange(() => {
    firma.reload();
    mitglieder.reload();
    finanzen.reload();
  });

  const name = firma.data?.name;
  useEffect(() => {
    if (name) tab.setTitle(name);
  }, [tab, name]);

  if (firma.error) return <LoadError onRetry={firma.reload} />;
  const f = firma.data;
  if (!f) return <Loading />;
  const fin = finanzen.data;
  const list = mitglieder.data ?? [];

  const kontakte: Column<PersonDetail>[] = [
    {
      key: "name",
      header: t("personen.firma.kontakt.name"),
      cell: (p) => <b>{`${p.vorname} ${p.nachname}`.trim()}</b>,
    },
    {
      key: "funktion",
      header: t("personen.firma.kontakt.funktion"),
      width: "173px",
      cell: (p) => dash(p.funktion),
    },
    { key: "email", header: t("personen.field.email"), width: "283px", cell: (p) => dash(p.email) },
  ];
  const members: Column<PersonDetail>[] = [
    { key: "nr", header: t("personen.col.nr"), width: "96px", cell: (p) => dash(p.nr) },
    { key: "name", header: t("personen.firma.mitglied"), cell: (p) => <b>{p.name}</b> },
    {
      key: "status",
      header: t("personen.col.status"),
      width: "118px",
      cell: (p) => <PersonStatusBadge status={p.status} />,
    },
  ];

  const registerRows: Array<[string, ReactNode]> = [
    [t("personen.field.firmenname"), f.name],
    [t("personen.field.uid"), dash(f.uid)],
    [t("personen.field.mwst"), dash(f.mwstNr)],
    [t("personen.field.strasse"), dash(f.strasse)],
    [t("personen.detail.plzOrt"), `${f.plz} ${f.ort}`],
    [
      t("personen.firma.erfasst"),
      f.erfasstVon
        ? t("personen.firma.erfasstVon", { date: formatDate(f.erstelltAm), name: f.erfasstVon })
        : formatDate(f.erstelltAm),
    ],
    ...(svc.features.firmaExtras
      ? ([
          [
            t("personen.firmen.col.quelle"),
            f.quelle ? t(`personen.quelle.${f.quelle}` as "personen.quelle.manuell") : "–",
          ],
        ] as Array<[string, ReactNode]>)
      : []),
  ];

  return (
    <div className="page">
      <PageHeader
        crumb={t("personen.firma.crumb", { id: f.uid ?? f.name })}
        title={f.name}
        status={<FirmaStatusBadge status={f.status} />}
        actions={
          <>
            <Button
              icon="plus"
              onClick={() =>
                tabs.openTab("person-form", {
                  params: { typ: "firma", firmaId: f.id },
                  title: t("personen.firma.memberNew.tab", { name: f.name }),
                })
              }
            >
              {t("personen.firma.memberNew")}
            </Button>
            <Button
              variant="primary"
              icon="edit"
              onClick={() =>
                tabs.openTab("firma-form", {
                  key: `edit-${f.id}`,
                  params: { id: f.id },
                  title: t("personen.firmen.form.titleEdit.tab", { name: f.name }),
                })
              }
            >
              {t("personen.firmen.edit")}
            </Button>
          </>
        }
      />
      <div className="cols">
        <div className="cols__a">
          <div className="stack">
            <Panel title={t("personen.firma.register")}>
              <Kv rows={registerRows} />
            </Panel>
            <Panel title={t("personen.firma.kontakte")} flush>
              <DataTable
                label={t("personen.firma.kontakte")}
                columns={kontakte}
                rows={list}
                rowKey={(p) => p.id}
                empty={<span className="muted">{t("personen.firma.kontakte.empty")}</span>}
              />
            </Panel>
            {fin && (
              <Panel title={t("personen.detail.letzteRechnungen")} flush>
                <RechnungenTable
                  rows={fin.rechnungen.slice(0, 3)}
                  label={t("personen.detail.letzteRechnungen")}
                />
              </Panel>
            )}
          </div>
        </div>
        <div className="cols__b">
          <div className="stack">
            <Panel title={t("personen.firma.mitglieder")} flush>
              <DataTable
                label={t("personen.firma.mitgliederLabel")}
                columns={members}
                rows={list}
                rowKey={(p) => p.id}
                onRowActivate={(p) =>
                  tabs.openTab("person", { key: p.id, params: { id: p.id }, title: p.name })
                }
                empty={<span className="muted">{t("personen.firma.mitglieder.empty")}</span>}
              />
            </Panel>
            {fin && (
              <>
                <Panel title={t("personen.detail.konto")}>
                  <KontoList finanzen={fin} />
                </Panel>
                <Panel title={t("personen.detail.tab.verlauf")}>
                  {fin.verlauf.length === 0 ? (
                    <span className="muted">{t("personen.detail.verlauf.empty")}</span>
                  ) : (
                    <Kv rows={fin.verlauf.map((v) => [formatDate(v.datum), v.text])} />
                  )}
                </Panel>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
