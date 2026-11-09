import { useAuth } from "../../auth/auth";
import { t, tp, type TextKey } from "../../i18n";
import { useTabs } from "../../shell/tabs";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  PageHeader,
  Panel,
  Stat,
  type Column,
  type IconName,
} from "../../ui";
import { belegNr, chDate, chf, daysBetween, isoDay, pairLines } from "./format";
import { LoadError, useLoad } from "./parts";
import { useBuchhaltung } from "./service";
import { TAB } from "./tabs";
import type { AccountRow, Entry, OpenInvoice, RestPage } from "./types";

const areas: { tab: string; label: TextKey; icon: IconName }[] = [
  { tab: TAB.kontenplan, label: "bh.tab.kontenplan", icon: "book" },
  { tab: TAB.buchungen, label: "bh.tab.buchungen", icon: "list" },
  { tab: TAB.offene, label: "bh.tab.offene", icon: "clock" },
  { tab: TAB.zuordnung, label: "bh.tab.zuordnung", icon: "link" },
  { tab: TAB.import, label: "bh.tab.import", icon: "upload" },
];

/** Kasse und Bank im Kontenrahmen der Vereine. */
const LIQUID = ["1000", "1020"];
const LAST = 5;

interface Overview {
  liquid: AccountRow[];
  invoices?: OpenInvoice[];
  rest?: RestPage;
  recent?: Entry[];
}

const sum = (rows: readonly { openRappen: number }[]) => rows.reduce((s, r) => s + r.openRappen, 0);

/** Kennzahlen, offene Posten und letzte Buchungen aus den vorhandenen Routen. Eine ausgefallene Quelle fehlt in der Übersicht. */
async function loadOverview(
  service: ReturnType<typeof useBuchhaltung>,
  year: string,
): Promise<Overview> {
  const range = { from: `${year}-01-01`, to: `${year}-12-31` };
  const [accounts, invoices, rest, recent] = await Promise.allSettled([
    service.listAccounts(),
    service.listOpenInvoices(),
    service.listRest(),
    (async () => {
      // Die API liefert aufsteigend nach Belegnummer: die Gesamtzahl bestimmt den Beginn der letzten Seite.
      const { total = 0 } = await service.listEntries({ ...range, limit: 1, offset: 0 });
      const page = await service.listEntries({
        ...range,
        limit: LAST,
        offset: Math.max(0, total - LAST),
      });
      return page.items.reverse();
    })(),
  ]);
  const all = [accounts, invoices, rest, recent];
  const rejected = all.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (rejected.length === all.length) throw rejected[0]!.reason;
  return {
    liquid:
      accounts.status === "fulfilled"
        ? accounts.value.filter((a) => LIQUID.includes(a.code) && a.type === "asset")
        : [],
    invoices: invoices.status === "fulfilled" ? invoices.value : undefined,
    rest: rest.status === "fulfilled" ? rest.value : undefined,
    recent: recent.status === "fulfilled" ? recent.value : undefined,
  };
}

/** Einstieg des Moduls: Kennzahlen des Geschäftsjahrs und die Bereiche als Tabs. */
export function HubPage() {
  const service = useBuchhaltung();
  const { openTab } = useTabs();
  const { now } = useAuth();
  const today = isoDay(now);
  const year = today.slice(0, 4);
  const { data, error, reload } = useLoad(() => loadOverview(service, year), [service, year]);

  const overdue = (data?.invoices ?? []).filter((i) => daysBetween(i.dueDate, today) > 0);
  const restSum = (data?.rest?.items ?? []).reduce((s, p) => s + p.amountRappen, 0);

  const columns: Column<Entry>[] = [
    { key: "beleg", header: t("bh.col.beleg"), width: "129px", cell: (e) => <b>{belegNr(e)}</b> },
    { key: "date", header: t("bh.col.date"), width: "118px", cell: (e) => chDate(e.bookingDate) },
    { key: "text", header: t("bh.col.text"), cell: (e) => e.description },
    {
      key: "amount",
      header: t("bh.col.amount"),
      width: "129px",
      align: "right",
      cell: (e) => chf(pairLines(e.lines).reduce((s, p) => s + p.amount, 0)),
    },
  ];

  return (
    <div className="page">
      <PageHeader title={t("bh.tab.hub")} status={<Badge>{t("bh.hub.year", { year })}</Badge>} />
      <div className="page__body bh-hub">
        {error !== undefined && <LoadError error={error} what={t("bh.tab.hub")} onRetry={reload} />}
        {data && (
          <div
            className="bh-hub__stats"
            data-count={data.liquid.length + (data.invoices ? 2 : 0) + (data.rest ? 1 : 0)}
          >
            {data.liquid.map((a) => (
              <Stat
                key={a.code}
                label={a.name}
                value={chf(a.balance)}
                note={t("bh.common.account", { code: a.code })}
              />
            ))}
            {data.invoices && (
              <Stat
                label={t("bh.tab.offene")}
                value={chf(sum(data.invoices))}
                note={tp("bh.hub.items", data.invoices.length)}
              />
            )}
            {data.invoices && (
              <Stat
                label={t("bh.col.overdue")}
                value={chf(sum(overdue))}
                note={tp("bh.hub.items", overdue.length)}
              />
            )}
            {data.rest && (
              <Stat
                label={t("bh.hub.rest")}
                value={chf(restSum)}
                note={
                  data.rest.hasMore
                    ? t("bh.hub.restMore", { n: data.rest.items.length })
                    : tp("bh.hub.payments", data.rest.items.length)
                }
              />
            )}
          </div>
        )}
        <div className="bh-hub__cols">
          {data?.recent && (
            <Panel title={t("bh.hub.recent")} flush>
              <DataTable
                label={t("bh.hub.recent")}
                columns={columns}
                rows={data.recent}
                rowKey={(e) => e.id}
                empty={<EmptyState title={t("bh.hub.noEntries", { year })} />}
              />
            </Panel>
          )}
          <Panel title={t("bh.hub.areas")} plain>
            <div className="bh-hub__areas">
              {areas.map((a) => (
                <Button key={a.tab} icon={a.icon} onClick={() => openTab(a.tab, { key: a.tab })}>
                  {t(a.label)}
                </Button>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
