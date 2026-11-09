import { useEffect, useMemo, useState } from "react";
import { t, type TextKey } from "../../i18n";
import { useCurrentTab, useTabs } from "../../shell/tabs";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Message,
  PageHeader,
  PageTabs,
  Panel,
  useToast,
  type Column,
  type PageTab,
} from "../../ui";
import { chDate, chf, qrReference } from "./format";
import { useImports } from "./importStore";
import {
  errorText,
  FilterSelect,
  Kv,
  LoadError,
  Pager,
  RowPick,
  SearchBox,
  Summary,
  Toolbar,
  useInvoiceNumbers,
  useLoad,
} from "./parts";
import { useBuchhaltung } from "./service";
import { TAB } from "./tabs";
import type { CamtPayment, ImportResult, OpenInvoice } from "./types";

const PAGE_SIZE = 14;

export const reasonLabel = (p: CamtPayment): string =>
  p.restReason ? t(`bh.reason.${p.restReason}` as TextKey) : t("bh.reason.unknown");

type Fit = "same" | "similar" | "other";

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Vergleicht den Namen des Zahlers mit dem Debitor der Rechnung. */
export function nameFit(payer: string | undefined, debtor: string): Fit {
  const a = norm(payer ?? "");
  const b = norm(debtor);
  if (a.length > 0 && a.join(" ") === b.join(" ")) return "same";
  return a.some((w) => w.length >= 3 && b.includes(w)) ? "similar" : "other";
}

const fitRank: Record<Fit, number> = { same: 0, similar: 1, other: 2 };

function AutoView({ result }: { result: ImportResult | undefined }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(0);
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (result?.matched ?? [])
      .filter(
        (p) =>
          (status === "all" || status === "matched") &&
          (!needle || `${p.debtorName ?? ""} ${p.reference ?? ""}`.toLowerCase().includes(needle)),
      )
      .sort((a, b) => b.bookingDate.localeCompare(a.bookingDate));
  }, [result, search, status]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const shown = rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const numbers = useInvoiceNumbers(shown.map((p) => p.openItemId));

  const columns: Column<CamtPayment>[] = [
    { key: "date", header: t("bh.col.valuta"), width: "118px", cell: (p) => chDate(p.bookingDate) },
    { key: "payer", header: t("bh.col.payer"), cell: (p) => <b>{p.debtorName ?? "–"}</b> },
    {
      key: "ref",
      header: t("bh.col.qrRef"),
      width: "327px",
      cell: (p) => qrReference(p.reference),
    },
    {
      key: "amount",
      header: t("bh.col.amount"),
      width: "129px",
      align: "right",
      cell: (p) => chf(p.amountRappen),
    },
    {
      key: "invoice",
      header: t("bh.col.invoice"),
      width: "129px",
      cell: (p) => (p.openItemId ? (numbers.get(p.openItemId) ?? "–") : "–"),
    },
    // Die automatische Zuordnung bucht nur bei exakt passendem Betrag.
    { key: "diff", header: t("bh.col.diff"), width: "107px", align: "right", cell: () => chf(0) },
    {
      key: "status",
      header: t("bh.col.status"),
      width: "140px",
      cell: () => <Badge tone="ok">{t("bh.zuordnung.matched")}</Badge>,
    },
  ];

  return (
    <>
      {result && (
        <div className="bh-pad bh-pad--top">
          <Message
            tone="ok"
            title={t("bh.zuordnung.autoTitle", {
              matched: result.counts.matched,
              total: result.counts.total,
            })}
          >
            {t("bh.zuordnung.autoText")}
          </Message>
        </div>
      )}
      <Toolbar>
        <SearchBox placeholder={t("bh.zuordnung.autoSearch")} value={search} onChange={setSearch} />
        <FilterSelect
          label={t("bh.col.status")}
          value={status}
          onChange={setStatus}
          options={[
            { value: "all", label: t("bh.zuordnung.statusFilter", { value: t("bh.common.all") }) },
            {
              value: "matched",
              label: t("bh.zuordnung.statusFilter", { value: t("bh.zuordnung.matched") }),
            },
          ]}
        />
        <span className="bh-spacer" />
        <Summary
          shown={shown.length}
          total={rows.length}
          column={t("bh.zuordnung.sorted")}
          direction="desc"
        />
      </Toolbar>
      <div className="bh-pad">
        <DataTable
          label={t("bh.zuordnung.autoTable")}
          columns={columns}
          rows={shown}
          rowKey={(p) => p.id}
          empty={<EmptyState title={t("bh.common.empty")} />}
        />
      </div>
      <Pager
        text={t("bh.common.pageOf", { n: current + 1, total: pages })}
        hasPrev={current > 0}
        hasNext={current < pages - 1}
        onPrev={() => setPage(current - 1)}
        onNext={() => setPage(current + 1)}
      />
    </>
  );
}

function ImportsView({ imports }: { imports: readonly ImportResult[] }) {
  const columns: Column<ImportResult>[] = [
    { key: "file", header: t("bh.col.file"), cell: (i) => i.fileName },
    {
      key: "at",
      header: t("bh.col.imported"),
      width: "118px",
      cell: (i) => chDate(new Date(i.importedAt).toISOString().slice(0, 10)),
    },
    {
      key: "n",
      header: t("bh.col.payments"),
      width: "118px",
      align: "right",
      cell: (i) => i.counts.total,
    },
    {
      key: "rest",
      header: t("bh.col.rest"),
      width: "69px",
      align: "right",
      cell: (i) => i.counts.rest,
    },
  ];
  return (
    <div className="bh-pad bh-pad--top">
      <Panel title={t("bh.zuordnung.importsTable")} flush>
        <DataTable
          label={t("bh.zuordnung.importsTable")}
          columns={columns}
          rows={imports}
          rowKey={(i) => i.importId}
          empty={<EmptyState title={t("bh.common.empty")} />}
        />
      </Panel>
    </div>
  );
}

interface ManualProps {
  payments: readonly CamtPayment[];
  invoices: readonly OpenInvoice[];
  pickedId: string | undefined;
  onPick: (id: string) => void;
  choice: string | undefined;
  onChoice: (id: string) => void;
}

function ManualView({ payments, invoices, pickedId, onPick, choice, onChoice }: ManualProps) {
  const payment = payments.find((p) => p.id === pickedId) ?? payments[0];
  const byId = useMemo(() => new Map(invoices.map((i) => [i.id, i])), [invoices]);

  const candidates = useMemo(() => {
    if (!payment) return [];
    return invoices
      .map((i) => ({ invoice: i, fit: nameFit(payment.debtorName, i.debtorName) }))
      .sort(
        (a, b) =>
          Number(b.invoice.id === payment.openItemId) -
            Number(a.invoice.id === payment.openItemId) ||
          fitRank[a.fit] - fitRank[b.fit] ||
          a.invoice.dueDate.localeCompare(b.invoice.dueDate),
      )
      .slice(0, 8);
  }, [payment, invoices]);

  const chosen = candidates.find((c) => c.invoice.id === choice)?.invoice ?? candidates[0]?.invoice;
  // Die Vorauswahl gilt auch für «Zahlung zuordnen und buchen» im Seitenkopf.
  useEffect(() => {
    if (chosen && chosen.id !== choice) onChoice(chosen.id);
  }, [chosen, choice, onChoice]);

  const restColumns: Column<CamtPayment>[] = [
    {
      key: "date",
      header: t("bh.col.valuta"),
      width: "118px",
      cell: (p) => (
        <RowPick
          label={t("bh.zuordnung.payment", {
            date: chDate(p.bookingDate),
            payer: p.debtorName ?? "",
          })}
          pressed={p.id === payment?.id}
          onClick={() => onPick(p.id)}
        >
          {chDate(p.bookingDate)}
        </RowPick>
      ),
    },
    { key: "payer", header: t("bh.col.payer"), cell: (p) => <b>{p.debtorName ?? "–"}</b> },
    {
      key: "hint",
      header: t("bh.col.hint"),
      width: "173px",
      cell: (p) => (p.openItemId ? (byId.get(p.openItemId)?.number ?? "–") : "–"),
    },
    {
      key: "amount",
      header: t("bh.col.amount"),
      width: "129px",
      align: "right",
      cell: (p) => chf(p.amountRappen),
    },
    {
      key: "reason",
      header: t("bh.col.reason"),
      width: "250px",
      cell: (p) => <Badge tone="warning">{reasonLabel(p)}</Badge>,
    },
  ];

  const candColumns: Column<(typeof candidates)[number]>[] = [
    {
      key: "choice",
      header: t("bh.col.choice"),
      width: "69px",
      cell: ({ invoice: i }) => {
        const on = i.id === chosen?.id;
        return (
          <label className="opt">
            <input
              type="radio"
              className="chk-input"
              name="invoice-choice"
              checked={on}
              onChange={() => onChoice(i.id)}
            />
            <span className="rad" aria-hidden="true" />
            <span className="visually-hidden">
              {t(on ? "bh.zuordnung.picked" : "bh.zuordnung.pick", { nr: i.number ?? "" })}
            </span>
          </label>
        );
      },
    },
    {
      key: "nr",
      header: t("bh.col.invoice"),
      width: "129px",
      cell: ({ invoice: i }) => (i.id === chosen?.id ? <b>{i.number}</b> : i.number),
    },
    { key: "debtor", header: t("bh.col.debtor"), cell: ({ invoice: i }) => i.debtorName },
    {
      key: "due",
      header: t("bh.col.due"),
      width: "118px",
      cell: ({ invoice: i }) => chDate(i.dueDate),
    },
    {
      key: "open",
      header: t("bh.col.open"),
      width: "129px",
      align: "right",
      cell: ({ invoice: i }) => chf(i.openRappen),
    },
    {
      key: "fit",
      header: t("bh.col.fit"),
      width: "151px",
      cell: ({ fit }) => (
        <Badge tone={fit === "same" ? "ok" : "neutral"}>
          {t(`bh.zuordnung.fit.${fit}` as TextKey)}
        </Badge>
      ),
    },
  ];

  const previewColumns: Column<{ id: string }>[] = [
    { key: "debit", header: t("bh.col.debit"), width: "74px", cell: () => "1020" },
    { key: "credit", header: t("bh.col.credit"), width: "74px", cell: () => "1100" },
    {
      key: "amount",
      header: t("bh.col.amount"),
      align: "right",
      cell: () => chf(payment?.amountRappen ?? 0),
    },
  ];

  const rest = chosen && payment ? chosen.openRappen - payment.amountRappen : 0;

  return (
    <div className="bh-manual">
      <Panel title={t("bh.zuordnung.restTable")} flush>
        <DataTable
          label={t("bh.zuordnung.restTable")}
          columns={restColumns}
          rows={payments}
          rowKey={(p) => p.id}
          selected={new Set(payment ? [payment.id] : [])}
          empty={<EmptyState title={t("bh.common.empty")} />}
        />
      </Panel>
      {payment && (
        <div className="bh-manual__detail">
          <div className="bh-stack bh-stack--wide">
            <Panel
              title={t("bh.zuordnung.payment", {
                date: chDate(payment.bookingDate),
                payer: payment.debtorName ?? "–",
              })}
            >
              <Kv
                rows={[
                  [t("bh.zuordnung.mAmount"), <b key="a">{chf(payment.amountRappen)}</b>],
                  [t("bh.zuordnung.mMessage"), payment.remittanceInfo ?? "–"],
                  [t("bh.zuordnung.mIban"), payment.debtorIban ?? "–"],
                ]}
              />
            </Panel>
            <Panel title={t("bh.zuordnung.candidates")} flush>
              <DataTable
                label={t("bh.zuordnung.candidates")}
                columns={candColumns}
                rows={candidates}
                rowKey={(c) => c.invoice.id}
                selected={new Set(chosen ? [chosen.id] : [])}
                empty={<EmptyState title={t("bh.common.empty")} />}
              />
            </Panel>
          </div>
          <div className="bh-stack bh-stack--side">
            <Panel title={t("bh.zuordnung.preview")} flush>
              <DataTable
                label={t("bh.zuordnung.preview")}
                columns={previewColumns}
                rows={[{ id: payment.id }]}
                rowKey={(r) => r.id}
              />
              {chosen && (
                <div className="bh-preview">
                  <div className="bh-sub">
                    {t("bh.zuordnung.invoiceOf", { nr: chosen.number ?? "" })}
                  </div>
                  <b>{t("bh.zuordnung.restOpen", { amount: chf(Math.max(0, rest)) })}</b>
                </div>
              )}
            </Panel>
            {chosen && rest > 0 && (
              <Message tone="warning" title={t("bh.zuordnung.partialTitle")}>
                {t("bh.zuordnung.partialText", { amount: chf(rest) })}
              </Message>
            )}
            {chosen && rest < 0 && (
              <Message tone="warning" title={t("bh.zuordnung.overTitle")}>
                {t("bh.zuordnung.overText", { amount: chf(-rest) })}
              </Message>
            )}
            <Message tone="neutral" title={t("bh.zuordnung.manualTitle")}>
              {t("bh.zuordnung.manualText")}
            </Message>
          </div>
        </div>
      )}
    </div>
  );
}

/** Zahlungszuordnung (Design 5.5, 5.6): automatisch zugeordnet, manuell zuordnen, Importe. */
export function ZuordnungPage() {
  const service = useBuchhaltung();
  const tab = useCurrentTab();
  const { openTab } = useTabs();
  const toast = useToast();
  const imports = useImports();
  const last = imports[0];
  const [view, setView] = useState(tab.params["view"] ?? "auto");
  const [pickedId, setPickedId] = useState<string | undefined>(tab.params["payment"]);
  const [choice, setChoice] = useState<string | undefined>(tab.params["invoice"]);
  const [busy, setBusy] = useState(false);
  const rest = useLoad(() => service.listRest(), [service]);
  const invoices = useLoad(() => service.listOpenInvoices(), [service]);

  const payments = useMemo(() => rest.data?.items ?? [], [rest.data]);
  const payment = payments.find((p) => p.id === pickedId) ?? payments[0];

  // Ein Vorschlag der Bank (Betrag weicht ab) ist die Vorauswahl.
  useEffect(() => {
    if (payment?.openItemId) setChoice(payment.openItemId);
  }, [payment?.id, payment?.openItemId]);

  const book = async () => {
    const target = choice;
    if (!payment || !target) return;
    setBusy(true);
    try {
      await service.assignRest(payment.id, target);
      toast.show({ tone: "ok", title: t("bh.zuordnung.booked") });
      setPickedId(undefined);
      setChoice(undefined);
      rest.reload();
      invoices.reload();
    } catch (e) {
      toast.show({ tone: "error", title: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const postpone = () =>
    payment &&
    service
      .postponePayment(payment.id)
      .catch((e: unknown) => toast.show({ tone: "error", title: errorText(e) }));

  const manualCount = payments.length;
  const tabs: PageTab[] = [
    {
      id: "auto",
      label: t("bh.zuordnung.tabAuto", { n: last?.counts.matched ?? 0 }),
      content: <AutoView result={last} />,
    },
    {
      id: "manual",
      label: t("bh.zuordnung.tabManual", { n: manualCount }),
      content: rest.error ? (
        <LoadError error={rest.error} what={t("bh.zuordnung.title")} onRetry={rest.reload} />
      ) : (
        <ManualView
          payments={payments}
          invoices={invoices.data ?? []}
          pickedId={payment?.id}
          onPick={(id) => {
            setPickedId(id);
            setChoice(undefined);
          }}
          choice={choice}
          onChoice={setChoice}
        />
      ),
    },
    {
      id: "imports",
      label: t("bh.zuordnung.tabImports", { n: imports.length }),
      content: <ImportsView imports={imports} />,
    },
  ];

  const importButton = (
    <Button icon="upload" onClick={() => openTab(TAB.import, { key: TAB.import })}>
      {t("bh.offene.import")}
    </Button>
  );

  return (
    <div className="page">
      <PageHeader
        crumb={t("bh.crumb", { page: t("bh.tab.zuordnung") })}
        title={t("bh.zuordnung.title")}
        status={
          view === "manual" ? (
            <Badge tone="warning">{t("bh.zuordnung.open", { n: manualCount })}</Badge>
          ) : view === "auto" && last ? (
            <Badge>{last.fileName}</Badge>
          ) : undefined
        }
        actions={
          view === "manual" ? (
            <>
              <Button disabled={!payment} onClick={() => void postpone()}>
                {t("bh.zuordnung.postpone")}
              </Button>
              <Button variant="primary" disabled={!payment || busy} onClick={() => void book()}>
                {t("bh.zuordnung.book")}
              </Button>
            </>
          ) : (
            importButton
          )
        }
      />
      <PageTabs label={t("bh.zuordnung.tabs")} tabs={tabs} value={view} onChange={setView} />
    </div>
  );
}
