import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/auth";
import { t } from "../../i18n";
import { useCurrentTab, useTabs } from "../../shell/tabs";
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
  type Sort,
} from "../../ui";
import { belegNr, chDate, chf, isoDay } from "./format";
import {
  errorText,
  FilterSelect,
  Kv,
  LoadError,
  SearchBox,
  Summary,
  Toolbar,
  useLoad,
} from "./parts";
import { useBuchhaltung } from "./service";
import { TAB } from "./tabs";
import type { LedgerLine, LedgerOpenItem } from "./types";

/** Tab-Typen anderer Module. Fehlt das Modul, meldet die Schaltfläche, dass die Funktion nicht verfügbar ist. */
const PERSON_TAB = "person";
const NEW_INVOICE_TAB = "rechnung-neu";

type Row =
  | (LedgerLine & { total?: false })
  | { total: true; debit: number; credit: number; balance: number };

/** Debitorenkonto einer Person (Design 5.10). Parameter des Tabs: `personId`, optional `name`. */
export function DebitorPage() {
  const service = useBuchhaltung();
  const tab = useCurrentTab();
  const { openTab, modules } = useTabs();
  const { now } = useAuth();
  const toast = useToast();
  const today = isoDay(now);
  const personId = tab.params["personId"] ?? "";
  const [search, setSearch] = useState("");
  const [year, setYear] = useState(today.slice(0, 4));
  const [sort, setSort] = useState<Sort>({ key: "date", direction: "asc" });

  const ledger = useLoad(() => service.personLedger(personId), [service, personId]);
  const person = useLoad(() => service.getPerson(personId).catch(() => null), [service, personId]);
  const name = person.data?.name || tab.params["name"] || personId;

  const { setTitle } = tab;
  useEffect(() => {
    setTitle(t("bh.debitor.title", { name }));
  }, [setTitle, name]);

  const rows = useMemo<Row[]>(() => {
    const needle = search.trim().toLowerCase();
    const dir = sort.direction === "asc" ? 1 : -1;
    const lines = (ledger.data?.lines ?? [])
      .filter(
        (l) =>
          l.bookingDate.startsWith(year) &&
          (!needle ||
            `${belegNr({ number: l.entryNumber, bookingDate: l.bookingDate })} ${l.description}`
              .toLowerCase()
              .includes(needle)),
      )
      .sort(
        (a, b) =>
          dir * (a.bookingDate.localeCompare(b.bookingDate) || a.entryNumber - b.entryNumber),
      );
    return lines;
  }, [ledger.data, search, year, sort.direction]);

  const withTotal = useMemo<Row[]>(
    () =>
      ledger.data
        ? [
            ...rows,
            {
              total: true,
              debit: ledger.data.debit,
              credit: ledger.data.credit,
              balance: ledger.data.balance,
            },
          ]
        : rows,
    [rows, ledger.data],
  );

  const columns: Column<Row>[] = [
    {
      key: "date",
      header: t("bh.col.date"),
      width: "118px",
      sortable: true,
      cell: (r) => (r.total ? "" : chDate(r.bookingDate)),
    },
    {
      key: "beleg",
      header: t("bh.col.beleg"),
      width: "129px",
      cell: (r) => (r.total ? "" : belegNr({ number: r.entryNumber, bookingDate: r.bookingDate })),
    },
    {
      key: "text",
      header: t("bh.col.text2"),
      cell: (r) => (r.total ? t("bh.debitor.total", { date: chDate(today) }) : r.description),
    },
    {
      key: "debit",
      header: t("bh.col.debit"),
      width: "129px",
      align: "right",
      cell: (r) => (r.total ? chf(r.debit) : r.side === "debit" ? chf(r.amount) : ""),
    },
    {
      key: "credit",
      header: t("bh.col.credit"),
      width: "129px",
      align: "right",
      cell: (r) => (r.total ? chf(r.credit) : r.side === "credit" ? chf(r.amount) : ""),
    },
    {
      key: "balance",
      header: t("bh.col.balance"),
      width: "129px",
      align: "right",
      cell: (r) => chf(r.total ? r.balance : r.balanceAfter),
    },
  ];

  const itemColumns: Column<LedgerOpenItem>[] = [
    { key: "ref", header: t("bh.col.invoice"), width: "129px", cell: (i) => <b>{i.reference}</b> },
    { key: "due", header: t("bh.col.due"), width: "118px", cell: (i) => chDate(i.dueDate) },
    {
      key: "open",
      header: t("bh.col.open"),
      width: "129px",
      align: "right",
      cell: (i) => chf(i.remaining),
    },
    // Die Mahnstufe liefert das Mahnwesen der Rechnungen, nicht die Buchhaltung.
    { key: "dunning", header: t("bh.col.dunning"), width: "118px", cell: () => "–" },
    {
      key: "action",
      header: t("bh.col.action"),
      cell: (i) => (
        <Button
          small
          icon="link"
          aria-label={`${t("bh.offene.assign")} ${i.reference}`}
          onClick={() => openTab(TAB.zuordnung, { key: TAB.zuordnung, params: { view: "manual" } })}
        >
          {t("bh.offene.assign")}
        </Button>
      ),
    },
  ];

  const hasTab = (type: string) => modules.some((m) => m.tabTypes.some((x) => x.id === type));
  const open = (type: string, params: Record<string, string>, title?: string) => {
    if (!hasTab(type)) {
      toast.show({ tone: "error", title: t("bh.err.unavailable") });
      return;
    }
    openTab(type, { key: params["id"] ?? params["personId"], params, ...(title ? { title } : {}) });
  };

  const years = [Number(today.slice(0, 4)), Number(today.slice(0, 4)) - 1].map((y) => ({
    value: String(y),
    label: t("bh.common.year", { year: y }),
  }));

  if (!personId) {
    return (
      <div className="page">
        <EmptyState title={t("bh.debitor.noPerson")} />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        crumb={t("bh.crumb.debitor", { name })}
        title={t("bh.debitor.title", { name })}
        status={
          <>
            <Badge>{t("bh.debitor.account")}</Badge>
            <Badge tone="ok">{t("bh.debitor.active")}</Badge>
          </>
        }
        actions={
          <>
            <Button icon="user" onClick={() => open(PERSON_TAB, { id: personId }, name)}>
              {t("bh.debitor.openPerson")}
            </Button>
            <Button
              icon="download"
              onClick={() =>
                service
                  .downloadStatement(personId)
                  .catch((e: unknown) => toast.show({ tone: "error", title: errorText(e) }))
              }
            >
              {t("bh.debitor.statement")}
            </Button>
            <Button
              variant="primary"
              icon="plus"
              onClick={() => open(NEW_INVOICE_TAB, { personId })}
            >
              {t("bh.debitor.createInvoice")}
            </Button>
          </>
        }
      />
      <Toolbar>
        <SearchBox placeholder={t("bh.debitor.search")} value={search} onChange={setSearch} />
        <FilterSelect
          label={t("bh.common.period")}
          value={year}
          onChange={setYear}
          options={years}
        />
        <span className="bh-spacer" />
        <Summary
          shown={rows.length}
          total={rows.length}
          column={t("bh.debitor.sorted")}
          direction={sort.direction}
        />
      </Toolbar>
      {ledger.error ? (
        <LoadError
          error={ledger.error}
          what={t("bh.debitor.title", { name })}
          onRetry={ledger.reload}
        />
      ) : (
        <>
          <div className="bh-pad">
            <DataTable
              label={t("bh.debitor.table")}
              columns={columns}
              rows={withTotal}
              rowKey={(r) => (r.total ? "total" : `${r.entryNumber}:${r.side}:${r.balanceAfter}`)}
              selected={new Set(ledger.data ? ["total"] : [])}
              sort={sort}
              onSortChange={setSort}
            />
          </div>
          <div className="bh-cols bh-cols--below">
            <div className="bh-cols__wide">
              <Panel title={t("bh.debitor.openTitle")} flush>
                <DataTable
                  label={t("bh.debitor.openTitle")}
                  columns={itemColumns}
                  rows={ledger.data?.openItems ?? []}
                  rowKey={(i) => i.id}
                  empty={<EmptyState title={t("bh.common.empty")} />}
                />
              </Panel>
            </div>
            <div className="bh-cols__side">
              <div className="bh-stack">
                <Panel title={t("bh.debitor.person")}>
                  {/* Die Mitgliedsnummer führt die Personenverwaltung nicht als Feld. */}
                  <Kv
                    rows={[
                      [t("bh.debitor.memberNo"), "–"],
                      [t("bh.debitor.group"), person.data?.group ?? "–"],
                      [t("bh.debitor.email"), person.data?.email ?? "–"],
                    ]}
                  />
                </Panel>
                <Message tone="neutral" title={t("bh.debitor.onlyDebtorsTitle")}>
                  {t("bh.debitor.onlyDebtorsText")}
                </Message>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
