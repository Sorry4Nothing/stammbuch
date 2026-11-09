import { useMemo, useRef, useState, type DragEvent } from "react";
import { useAuth } from "../../auth/auth";
import { t, tp } from "../../i18n";
import { useTabs } from "../../shell/tabs";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Icon,
  Message,
  PageHeader,
  Panel,
  RadioGroup,
  useToast,
  type Column,
} from "../../ui";
import { checksum, inspectCamt, MAX_CAMT_BYTES, type CamtInfo } from "./camtCheck";
import { chDate, chf, groups4, isoDay } from "./format";
import { recordImport } from "./importStore";
import {
  errorText,
  FilterSelect,
  Kv,
  SearchBox,
  Steps,
  Summary,
  Toolbar,
  useImportRows,
  useInvoiceNumbers,
  type ImportRow,
} from "./parts";
import { useBuchhaltung } from "./service";
import { TAB } from "./tabs";
import type { CamtPayment, ImportResult } from "./types";
import { reasonLabel } from "./ZuordnungPage";

const RESULT_PAGE_SIZE = 12;

interface Chosen {
  file: File;
  uploadedAt: number;
  info: CamtInfo | null;
  sum: string;
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", hour12: false });
const day = (ms: number) => chDate(isoDay(ms));

const sumOf = (list: readonly CamtPayment[]) => list.reduce((s, p) => s + p.amountRappen, 0);

function recentColumns(): Column<ImportRow>[] {
  return [
    { key: "file", header: t("bh.col.file"), cell: (i) => i.fileName },
    { key: "at", header: t("bh.col.imported"), width: "118px", cell: (i) => day(i.importedAt) },
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
}

function UploadStep({ onDone }: { onDone: (r: ImportResult) => void }) {
  const service = useBuchhaltung();
  const { now } = useAuth();
  const imports = useImportRows(service);
  const input = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<Chosen | undefined>();
  const [problem, setProblem] = useState<"large" | "invalid" | undefined>();
  const [type, setType] = useState("auto");
  const [failure, setFailure] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const take = async (file: File | undefined) => {
    setFailure(undefined);
    if (!file) return;
    if (file.size > MAX_CAMT_BYTES) {
      setChosen({ file, uploadedAt: now, info: null, sum: "" });
      setProblem("large");
      return;
    }
    const bytes = await file.arrayBuffer();
    const info = inspectCamt(new TextDecoder().decode(bytes));
    setChosen({ file, uploadedAt: now, info, sum: await checksum(bytes) });
    setProblem(info ? undefined : "invalid");
  };

  const reset = () => {
    setChosen(undefined);
    setProblem(undefined);
    setFailure(undefined);
    if (input.current) input.current.value = "";
  };

  const wrongKind = !!chosen?.info && type !== "auto" && type !== chosen.info.kind;
  const ready = !!chosen && !problem && !wrongKind && !busy;

  const run = async () => {
    if (!chosen || !ready) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await service.importFile(chosen.file, groups4(chosen.sum));
      recordImport(result);
      onDone(result);
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void take(e.dataTransfer.files[0]);
  };

  const check = () => {
    if (!chosen) return null;
    if (problem === "large") {
      return (
        <Message tone="error" title={t("bh.import.tooLargeTitle")}>
          {t("bh.import.tooLargeText")}
        </Message>
      );
    }
    if (problem === "invalid" || !chosen.info) {
      return (
        <Message tone="error" title={t("bh.import.invalidTitle")}>
          {t("bh.import.invalidText")}
        </Message>
      );
    }
    if (wrongKind) {
      return (
        <Message tone="error" title={t("bh.import.wrongKindTitle")}>
          {t("bh.import.wrongKindText", { kind: chosen.info.kind.toUpperCase() })}
        </Message>
      );
    }
    const i = chosen.info;
    return (
      <Message tone="ok" title={t("bh.import.validTitle", { kind: i.kind.toUpperCase() })}>
        {i.from && i.to && i.iban
          ? t("bh.import.validText", {
              n: i.count,
              from: chDate(i.from),
              to: chDate(i.to),
              iban: i.iban,
            })
          : tp("bh.import.validTextNoPeriod", i.count)}
      </Message>
    );
  };

  return (
    <>
      <PageHeader
        crumb={t("bh.crumb", { page: t("bh.tab.import") })}
        title={t("bh.import.title")}
        actions={
          <>
            <Button icon="close" onClick={reset}>
              {t("bh.import.cancel")}
            </Button>
            <Button variant="primary" icon="download" disabled={!ready} onClick={() => void run()}>
              {t("bh.import.submit")}
            </Button>
          </>
        }
      />
      <div className="bh-pad bh-pad--top">
        <Steps current={1} />
      </div>
      <div className="bh-cols">
        <div className="bh-cols__main">
          <Panel title={t("bh.import.fileTitle")}>
            <div
              className={dragging ? "bh-drop bh-drop--over" : "bh-drop"}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <Icon name="upload" size={32} />
              <div className="bh-drop__text">
                <b>{t("bh.import.drop")}</b>
              </div>
              <span className="bh-spacer" />
              <input
                name="file"
                ref={input}
                type="file"
                accept=".xml,text/xml,application/xml"
                className="visually-hidden"
                tabIndex={-1}
                aria-label={t("bh.import.choose")}
                onChange={(e) => void take(e.target.files?.[0])}
              />
              <Button icon="upload" onClick={() => input.current?.click()}>
                {t("bh.import.choose")}
              </Button>
            </div>
            {chosen && (
              <div className="bh-file">
                <Icon name="invoice" size={20} />
                <div>
                  <b>{chosen.file.name}</b>
                  <div className="bh-sub">
                    {t("bh.import.fileInfo", {
                      size: Math.max(1, Math.round(chosen.file.size / 1000)),
                      date: day(chosen.uploadedAt),
                      time: clock(chosen.uploadedAt),
                    })}
                  </div>
                </div>
                <span className="bh-spacer" />
                <Button
                  variant="ghost"
                  icon="close"
                  aria-label={t("bh.import.remove", { name: chosen.file.name })}
                  onClick={reset}
                />
              </div>
            )}
          </Panel>
          {chosen && (
            <Panel title={t("bh.import.checkTitle")}>
              <div className="bh-stack">
                {check()}
                {failure && <Message tone="error">{failure}</Message>}
              </div>
            </Panel>
          )}
        </div>
        <div className="bh-cols__side">
          <Panel title={t("bh.import.options")}>
            <div className="bh-stack">
              <RadioGroup
                legend={t("bh.import.type")}
                name="camt-type"
                value={type}
                onChange={setType}
                options={[
                  { value: "auto", label: t("bh.import.typeAuto") },
                  { value: "camt.053", label: t("bh.import.type053") },
                  { value: "camt.054", label: t("bh.import.type054") },
                ]}
              />
            </div>
          </Panel>
          <Panel title={t("bh.import.recent")} flush>
            <DataTable
              label={t("bh.import.recent")}
              columns={recentColumns()}
              rows={imports.slice(0, 6)}
              rowKey={(i) => i.importId}
              empty={<span className="muted">{t("bh.common.empty")}</span>}
            />
          </Panel>
        </div>
      </div>
    </>
  );
}

function ResultStep({
  result,
  onRest,
  onFinish,
}: {
  result: ImportResult;
  onRest: () => void;
  onFinish: () => void;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return [
      ...result.matched.map((p) => ({ p, rest: false })),
      ...result.rest.map((p) => ({ p, rest: true })),
    ].filter(
      ({ p, rest }) =>
        (status === "all" || (status === "rest") === rest) &&
        (!needle || (p.debtorName ?? "").toLowerCase().includes(needle)),
    );
  }, [result, search, status]);
  const shown = rows.slice(0, RESULT_PAGE_SIZE);
  const numbers = useInvoiceNumbers(shown.map((r) => r.p.openItemId));
  const restCount = result.rest.length;

  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: "date",
      header: t("bh.col.valuta"),
      width: "118px",
      cell: ({ p }) => chDate(p.bookingDate),
    },
    { key: "payer", header: t("bh.col.payer"), cell: ({ p }) => <b>{p.debtorName ?? "–"}</b> },
    {
      key: "amount",
      header: t("bh.col.amount"),
      width: "129px",
      align: "right",
      cell: ({ p }) => chf(p.amountRappen),
    },
    {
      key: "invoice",
      header: t("bh.col.invoice"),
      width: "151px",
      cell: ({ p, rest }) => (!rest && p.openItemId ? (numbers.get(p.openItemId) ?? "–") : "–"),
    },
    {
      key: "status",
      header: t("bh.col.status"),
      width: "151px",
      cell: ({ rest }) =>
        rest ? (
          <Badge tone="warning">{t("bh.import.restStatus")}</Badge>
        ) : (
          <Badge tone="ok">{t("bh.zuordnung.matched")}</Badge>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        crumb={t("bh.crumb", { page: t("bh.tab.import") })}
        title={t("bh.import.resultTitle")}
        status={<Badge>{result.fileName}</Badge>}
        actions={
          restCount > 0 ? (
            <Button variant="primary" icon="link" onClick={onRest}>
              {t("bh.import.toRest")}
            </Button>
          ) : (
            <Button variant="primary" icon="check" onClick={onFinish}>
              {t("bh.import.finish")}
            </Button>
          )
        }
      />
      <div className="bh-pad bh-pad--top">
        <Steps current={2} />
      </div>
      <div className="bh-pad bh-pad--top bh-stack">
        <Message tone="ok" title={t("bh.import.doneTitle")}>
          {t("bh.import.doneText", {
            matched: result.counts.matched,
            total: result.counts.total,
            amount: chf(sumOf(result.matched)),
          })}
        </Message>
        {restCount > 0 && (
          <Message
            tone="warning"
            title={tp("bh.import.restWarnTitle", restCount, { amount: chf(sumOf(result.rest)) })}
          />
        )}
      </div>
      <Toolbar>
        <SearchBox placeholder={t("bh.import.payerSearch")} value={search} onChange={setSearch} />
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
            {
              value: "rest",
              label: t("bh.zuordnung.statusFilter", { value: t("bh.import.restStatus") }),
            },
          ]}
        />
        <span className="bh-spacer" />
        <Summary shown={shown.length} total={rows.length} />
      </Toolbar>
      <div className="bh-pad">
        <DataTable
          label={t("bh.import.resultTable")}
          columns={columns}
          rows={shown}
          rowKey={({ p }) => p.id}
          empty={<EmptyState title={t("bh.common.empty")} />}
        />
      </div>
    </>
  );
}

function RestStep({ result, onFinish }: { result: ImportResult; onFinish: () => void }) {
  const service = useBuchhaltung();
  const { openTab } = useTabs();
  const toast = useToast();
  const numbers = useInvoiceNumbers(result.rest.map((p) => p.openItemId));
  const n = result.rest.length;
  const [postponed, setPostponed] = useState<ReadonlySet<string>>(new Set());
  const postpone = async (id: string) => {
    try {
      await service.postponePayment(id);
      setPostponed((s) => new Set(s).add(id));
      toast.show({ tone: "ok", title: t("bh.zuordnung.postponed") });
    } catch (e) {
      toast.show({ tone: "error", title: errorText(e) });
    }
  };

  const columns: Column<CamtPayment>[] = [
    { key: "date", header: t("bh.col.valuta"), width: "107px", cell: (p) => chDate(p.bookingDate) },
    { key: "payer", header: t("bh.col.payer"), cell: (p) => <b>{p.debtorName ?? "–"}</b> },
    {
      key: "hint",
      header: t("bh.col.hint"),
      width: "145px",
      cell: (p) => (p.openItemId ? (numbers.get(p.openItemId) ?? "–") : "–"),
    },
    {
      key: "amount",
      header: t("bh.col.amount"),
      width: "123px",
      align: "right",
      cell: (p) => chf(p.amountRappen),
    },
    {
      key: "reason",
      header: t("bh.col.reason"),
      width: "217px",
      cell: (p) => <Badge tone="warning">{reasonLabel(p)}</Badge>,
    },
    {
      key: "action",
      header: t("bh.col.action"),
      width: "338px",
      cell: (p) => (
        <>
          <Button
            small
            icon="link"
            onClick={() =>
              openTab(TAB.zuordnung, {
                key: TAB.zuordnung,
                params: { view: "manual", payment: p.id },
              })
            }
          >
            {t("bh.offene.assign")}
          </Button>{" "}
          {postponed.has(p.id) ? (
            <Badge>{t("bh.zuordnung.postponedBadge")}</Badge>
          ) : (
            <Button small variant="ghost" onClick={() => void postpone(p.id)}>
              {t("bh.zuordnung.postpone")}
            </Button>
          )}
        </>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        crumb={t("bh.crumb", { page: t("bh.tab.import") })}
        title={t("bh.import.restTitle")}
        actions={
          <Button variant="primary" icon="check" onClick={onFinish}>
            {t("bh.import.finish")}
          </Button>
        }
      />
      <div className="bh-pad bh-pad--top">
        <Steps current={3} />
      </div>
      <div className="bh-pad bh-pad--top bh-stack">
        <Message tone="warning" title={tp("bh.import.notBookedTitle", n)}>
          {tp("bh.import.notBookedText", n, { amount: chf(sumOf(result.rest)) })}
        </Message>
        <DataTable
          label={t("bh.import.restTable")}
          columns={columns}
          rows={result.rest}
          rowKey={(p) => p.id}
          empty={<EmptyState title={t("bh.common.empty")} />}
        />
        <div className="bh-cols bh-cols--flush">
          <div className="bh-cols__main">
            <Panel title={t("bh.import.log")}>
              <Kv
                rows={[
                  [t("bh.import.logFile"), result.fileName],
                  [
                    t("bh.import.logAt"),
                    t("bh.import.logAtValue", {
                      date: day(result.importedAt),
                      time: clock(result.importedAt),
                      name: result.importedBy,
                    }),
                  ],
                  [t("bh.import.logSum"), result.checksum],
                  [
                    t("bh.import.logPayments"),
                    t("bh.import.logPaymentsValue", {
                      total: result.counts.total,
                      matched: result.counts.matched,
                    }),
                  ],
                ]}
              />
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}

/** Zahlungsimport in drei Schritten (Design 5.7 bis 5.9). */
export function ImportPage() {
  const [phase, setPhase] = useState<
    { step: "upload" } | { step: "result" | "rest"; result: ImportResult }
  >({
    step: "upload",
  });
  const finish = () => setPhase({ step: "upload" });
  return (
    <div className="page">
      {phase.step === "upload" && (
        <UploadStep onDone={(result) => setPhase({ step: "result", result })} />
      )}
      {phase.step === "result" && (
        <ResultStep
          result={phase.result}
          onRest={() => setPhase({ step: "rest", result: phase.result })}
          onFinish={finish}
        />
      )}
      {phase.step === "rest" && <RestStep result={phase.result} onFinish={finish} />}
    </div>
  );
}
