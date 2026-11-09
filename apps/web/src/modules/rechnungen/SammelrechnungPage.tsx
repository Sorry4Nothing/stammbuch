import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/auth";
import { t, tp } from "../../i18n";
import { useCurrentTab } from "../../shell/tabs";
import {
  Badge,
  Button,
  Checkbox,
  DataTable,
  Dialog,
  Message,
  PageHeader,
  Panel,
  Select,
  TextField,
  useToast,
  type Column,
  type Sort,
} from "../../ui";
import { addDays, amount, chf, date, parseAmount, parseDate } from "./model";
import {
  errorText,
  FilterSelect,
  Kv,
  Loading,
  LoadError,
  Pager,
  SearchBox,
  Steps,
  useLoad,
} from "./parts";
import {
  useRechnungen,
  type CollectiveConfig,
  type CollectiveGroup,
  type CollectivePreview,
  type CollectivePreviewRow,
  type CollectiveSetup,
  type RechnungenService,
} from "./service";
import "./rechnungen.css";

type CollectiveResult = Awaited<ReturnType<RechnungenService["runCollective"]>>;

const PAGE_SIZE = 12;
const ALL = "all";
const TERMS = [10, 14, 20, 30, 60];

/** «1'158» */
const count = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "'");

/** Sammelrechnung in drei Schritten: konfigurieren, Vorschau, Bestätigung (Design 4.9 bis 4.11). */
export function SammelrechnungPage() {
  const service = useRechnungen();
  const { state, reload } = useLoad(() => service.collectiveSetup(), "collective");
  if (state.status === "error")
    return <LoadError what={t("rechnungen.collective.what")} state={state} onRetry={reload} />;
  if (state.status !== "ready") return <Loading />;
  return <Wizard setup={state.data} />;
}

function Wizard({ setup }: { setup: CollectiveSetup }) {
  const service = useRechnungen();
  const tab = useCurrentTab();
  const toast = useToast();
  const [step, setStep] = useState<1 | 2>(1);
  const [year, setYear] = useState(String(setup.defaults.year));
  const [issueDate, setIssueDate] = useState(date(setup.defaults.issueDate));
  const [term, setTerm] = useState(setup.defaults.termDays);
  const [text, setText] = useState(setup.defaults.text);
  const [delivery, setDelivery] = useState<CollectiveConfig["delivery"]>("email-or-print");
  const [skipLeft, setSkipLeft] = useState(true);
  const [skipNoFee, setSkipNoFee] = useState(true);
  const [list, setList] = useState(setup.groups);
  const [groups, setGroups] = useState<Set<string>>(
    new Set(setup.groups.filter((g) => g.feeCents !== null).map((g) => g.id)),
  );
  const [errors, setErrors] = useState<{ date?: string; text?: string }>({});
  const [preview, setPreview] = useState<CollectivePreview | null>(null);
  const [confirm, setConfirm] = useState(false);

  // Ein Lauf ist nie «gespeichert»: der Tab gilt von Anfang an als ungespeichert.
  useEffect(() => {
    tab.setDirty(true);
  }, [tab]);
  useEffect(() => {
    tab.setTitle(t("rechnungen.collective.tab", { year }));
  }, [tab, year]);

  const issueIso = parseDate(issueDate);
  const config: CollectiveConfig = {
    year: Number(year),
    issueDate: issueIso ?? service.today(),
    termDays: term,
    text: text.trim(),
    delivery,
    skipLeft,
    skipNoFee,
    groupIds: [...groups],
  };

  const stats = useMemo(() => {
    const billed = (g: CollectiveGroup) =>
      groups.has(g.id) && g.feeCents !== null ? g.persons : 0;
    return {
      invoices: list.reduce((s, g) => s + billed(g), 0),
      cents: list.reduce((s, g) => s + billed(g) * (g.feeCents ?? 0), 0),
      noFee: list.filter((g) => g.feeCents === null).reduce((s, g) => s + g.persons, 0),
    };
  }, [list, groups]);

  // Der Beitrag gehört zur Gruppe und gilt für alle künftigen Läufe: er wird sofort gespeichert.
  const saveFee = async (g: CollectiveGroup, text: string): Promise<string | null> => {
    const cents = text.trim() === "" ? null : parseAmount(text);
    if (text.trim() !== "" && (cents === null || cents < 1 || cents > 100_000_000))
      return t("rechnungen.collective.err.fee");
    if (cents === g.feeCents) return null;
    try {
      await service.setGroupFee(g.id, cents);
      setList((all) => all.map((x) => (x.id === g.id ? { ...x, feeCents: cents } : x)));
      if (cents === null)
        setGroups((sel) => {
          const next = new Set(sel);
          next.delete(g.id);
          return next;
        });
      return null;
    } catch (e) {
      return errorText(e);
    }
  };

  const toPreview = async () => {
    const e = {
      ...(issueIso ? {} : { date: t("rechnungen.form.err.date") }),
      ...(text.trim() ? {} : { text: t("rechnungen.collective.err.text") }),
    };
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    try {
      setPreview(await service.collectivePreview(config));
      setStep(2);
    } catch (err) {
      toast.show({
        tone: "error",
        title: t("rechnungen.collective.previewFailed"),
        text: errorText(err),
      });
    }
  };

  const columns: Column<CollectiveGroup>[] = [
    { key: "name", header: t("rechnungen.collective.col.group"), cell: (g) => <b>{g.name}</b> },
    {
      key: "persons",
      header: t("rechnungen.collective.col.persons"),
      width: "118px",
      align: "right",
      cell: (g) => g.persons,
    },
    {
      key: "fee",
      header: t("rechnungen.collective.col.fee"),
      width: "140px",
      align: "right",
      cell: (g) => <FeeInput group={g} onSave={(text) => saveFee(g, text)} />,
    },
    {
      key: "invoices",
      header: t("rechnungen.collective.col.invoices"),
      width: "129px",
      align: "right",
      cell: (g) => (groups.has(g.id) && g.feeCents !== null ? g.persons : 0),
    },
    {
      key: "sum",
      header: t("rechnungen.collective.col.sum"),
      width: "151px",
      align: "right",
      cell: (g) => (groups.has(g.id) && g.feeCents !== null ? chf(g.persons * g.feeCents) : "–"),
    },
  ];

  if (step === 2 && preview) {
    return (
      <PreviewStep
        config={config}
        preview={preview}
        confirm={confirm}
        onBack={() => setStep(1)}
        onConfirm={() => setConfirm(true)}
        onCloseConfirm={() => setConfirm(false)}
        onDone={({ created, notMailed }) => {
          tab.setDirty(false);
          toast.show({ tone: "ok", title: t("rechnungen.collective.done", { n: count(created) }) });
          if (notMailed > 0)
            toast.show({
              tone: "warning",
              title: tp("rechnungen.collective.notMailedTitle", notMailed, { n: count(notMailed) }),
              text: t("rechnungen.collective.notMailedText"),
            });
          tab.close();
        }}
      />
    );
  }

  return (
    <div className="page">
      <PageHeader
        crumb={t("rechnungen.collective.crumb")}
        title={t("rechnungen.collective.titleConfig")}
        actions={
          <>
            <Button onClick={() => tab.close()}>{t("ui.cancel")}</Button>
            <Button variant="primary" icon="chevronRight" onClick={() => void toPreview()}>
              {t("rechnungen.collective.toPreview")}
            </Button>
          </>
        }
      />
      <Steps current={1} />
      <div className="rg-split rg-split--steps">
        <div className="rg-col--form">
          <Panel title={t("rechnungen.collective.panelRun")}>
            <div className="rg-stack rg-stack--form">
              <Select
                label={t("rechnungen.collective.year")}
                required
                value={year}
                onChange={(e) => setYear(e.target.value)}
                options={[
                  setup.defaults.year - 1,
                  setup.defaults.year,
                  setup.defaults.year + 1,
                ].map((y) => ({
                  value: String(y),
                  label: String(y),
                }))}
              />
              <TextField
                label={t("rechnungen.form.issueDate")}
                required
                value={issueDate}
                placeholder={t("rechnungen.form.dateHint")}
                error={errors.date}
                onChange={(e) => setIssueDate(e.target.value)}
              />
              <Select
                label={t("rechnungen.form.term")}
                required
                value={String(term)}
                onChange={(e) => setTerm(Number(e.target.value))}
                options={[...new Set([...TERMS, term])]
                  .sort((a, b) => a - b)
                  .map((d) => ({
                    value: String(d),
                    label: tp("rechnungen.form.days", d),
                  }))}
              />
              <TextField
                label={t("rechnungen.collective.text")}
                required
                value={text}
                error={errors.text}
                onChange={(e) => setText(e.target.value)}
              />
              <Select
                label={t("rechnungen.collective.delivery")}
                required
                value={delivery}
                onChange={(e) => setDelivery(e.target.value as CollectiveConfig["delivery"])}
                options={[
                  {
                    value: "email-or-print",
                    label: t("rechnungen.collective.delivery.emailOrPrint"),
                  },
                  { value: "email", label: t("rechnungen.collective.delivery.email") },
                  { value: "print", label: t("rechnungen.collective.delivery.print") },
                ]}
              />
              <Checkbox
                checked={skipLeft}
                onChange={(e) => setSkipLeft(e.target.checked)}
                label={t("rechnungen.collective.skipLeft")}
              />
              <Checkbox
                checked={skipNoFee}
                onChange={(e) => setSkipNoFee(e.target.checked)}
                label={t("rechnungen.collective.skipNoFee")}
              />
            </div>
          </Panel>
        </div>
        <div className="rg-col rg-stack">
          <Panel title={t("rechnungen.collective.panelGroups")} flush>
            <DataTable
              label={t("rechnungen.collective.panelGroups")}
              columns={columns}
              rows={list}
              rowKey={(g) => g.id}
              selectable
              selected={groups}
              onSelectedChange={setGroups}
            />
          </Panel>
          <Panel title={t("rechnungen.collective.panelSummary")}>
            <dl className="kv rg-kv rg-kv--120">
              <Kv label={t("rechnungen.collective.personsTotal")}>{count(setup.totalPersons)}</Kv>
              <Kv label={t("rechnungen.collective.invoices")}>{count(stats.invoices)}</Kv>
              <Kv label={t("rechnungen.collective.totalAmount")}>{chf(stats.cents)}</Kv>
              <Kv label={t("rechnungen.collective.withoutFee")}>
                {t("rechnungen.collective.personsN", { n: count(stats.noFee) })}
              </Kv>
            </dl>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function PreviewStep({
  config,
  preview,
  confirm,
  onBack,
  onConfirm,
  onCloseConfirm,
  onDone,
}: {
  config: CollectiveConfig;
  preview: CollectivePreview;
  confirm: boolean;
  onBack: () => void;
  onConfirm: () => void;
  onCloseConfirm: () => void;
  onDone: (result: CollectiveResult) => void;
}) {
  const toast = useToast();
  const { setPage } = useCurrentTab();
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState(ALL);
  const [check, setCheck] = useState(ALL);
  const [sort, setSort] = useState<Sort>({ key: "recipient", direction: "asc" });
  const [page, setPageState] = useState(1);

  const groupNames = [...new Set(preview.rows.map((r) => r.groupName))];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = preview.rows.filter(
      (r) =>
        (group === ALL || r.groupName === group) &&
        (check === ALL || r.check === check) &&
        (q === "" || r.recipient.toLowerCase().includes(q)),
    );
    const dir = sort.direction === "asc" ? 1 : -1;
    return [...list].sort((a, b) => dir * a.recipient.localeCompare(b.recipient, "de-CH"));
  }, [preview.rows, query, group, check, sort]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const visible = shown.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  useEffect(() => setPage(current, pages), [current, pages, setPage]);

  const columns: Column<CollectivePreviewRow>[] = [
    {
      key: "number",
      header: t("rechnungen.collective.col.number"),
      width: "151px",
      cell: (r) => r.number,
    },
    {
      key: "recipient",
      header: t("rechnungen.list.col.recipient"),
      sortable: true,
      cell: (r) => <b>{r.recipient}</b>,
    },
    {
      key: "group",
      header: t("rechnungen.collective.col.group"),
      width: "195px",
      cell: (r) => r.groupName,
    },
    {
      key: "fee",
      header: t("rechnungen.collective.col.fee"),
      width: "129px",
      align: "right",
      cell: (r) => chf(r.feeCents),
    },
    {
      key: "delivery",
      header: t("rechnungen.collective.col.delivery"),
      width: "129px",
      cell: (r) =>
        t(
          r.delivery === "email"
            ? "rechnungen.collective.deliveryEmail"
            : "rechnungen.collective.deliveryPrint",
        ),
    },
    {
      key: "check",
      header: t("rechnungen.collective.col.check"),
      width: "195px",
      cell: (r) => (
        <Badge tone={r.check === "ready" ? "ok" : "warning"}>
          {t(r.check === "ready" ? "rechnungen.collective.ready" : "rechnungen.collective.noEmail")}
        </Badge>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        crumb={t("rechnungen.collective.crumb")}
        title={t("rechnungen.collective.titlePreview")}
        status={<Badge tone="warning">{t("rechnungen.collective.nothingYet")}</Badge>}
        actions={
          <>
            <Button icon="chevronLeft" onClick={onBack}>
              {t("rechnungen.collective.backToConfig")}
            </Button>
            <Button
              icon="eye"
              onClick={() =>
                toast.show({
                  tone: "warning",
                  title: t("rechnungen.unavailable.title"),
                  text: t("rechnungen.unavailable.text"),
                })
              }
            >
              {t("rechnungen.collective.sample")}
            </Button>
            <Button variant="primary" icon="chevronRight" onClick={onConfirm}>
              {t("rechnungen.collective.toConfirm")}
            </Button>
          </>
        }
      />
      <Steps current={2} />
      <div className="rg-body">
        {preview.noAddress > 0 && (
          <Message
            tone="warning"
            title={tp("rechnungen.collective.noAddressTitle", preview.noAddress)}
          >
            {t("rechnungen.collective.noAddressText")}
          </Message>
        )}
        {preview.printCount > 0 && (
          <Message
            tone="warning"
            title={tp("rechnungen.collective.noEmailTitle", preview.printCount)}
          />
        )}
        <div>
          <div className="rg-tool rg-tool--flush">
            <SearchBox
              label={t("rechnungen.collective.search")}
              value={query}
              onChange={(v) => {
                setQuery(v);
                setPageState(1);
              }}
            />
            <FilterSelect
              label={t("rechnungen.collective.filterGroup")}
              value={group}
              onChange={(v) => {
                setGroup(v);
                setPageState(1);
              }}
              options={[
                { value: ALL, label: t("rechnungen.collective.groupAll") },
                ...groupNames.map((n) => ({
                  value: n,
                  label: t("rechnungen.collective.groupOne", { name: n }),
                })),
              ]}
            />
            <FilterSelect
              label={t("rechnungen.collective.filterCheck")}
              value={check}
              onChange={(v) => {
                setCheck(v);
                setPageState(1);
              }}
              options={[
                { value: ALL, label: t("rechnungen.collective.checkAll") },
                {
                  value: "ready",
                  label: t("rechnungen.collective.checkOne", {
                    name: t("rechnungen.collective.ready"),
                  }),
                },
                {
                  value: "no-email",
                  label: t("rechnungen.collective.checkOne", {
                    name: t("rechnungen.collective.noEmail"),
                  }),
                },
              ]}
            />
            <span className="rg-tool__spacer" />
            <span className="muted" aria-live="polite">
              {t("rechnungen.list.count", {
                shown: count(visible.length),
                total: count(shown.length),
              })}
            </span>
          </div>
          <DataTable
            label={t("rechnungen.collective.tablePreview")}
            columns={columns}
            rows={visible}
            rowKey={(r) => r.number}
            sort={sort}
            onSortChange={setSort}
          />
          <Pager
            page={current}
            pages={pages}
            onPage={setPageState}
            summary={t("rechnungen.collective.perPage", { n: PAGE_SIZE })}
          />
        </div>
      </div>
      {confirm && (
        <ConfirmDialog config={config} preview={preview} onClose={onCloseConfirm} onDone={onDone} />
      )}
    </div>
  );
}

function ConfirmDialog({
  config,
  preview,
  onClose,
  onDone,
}: {
  config: CollectiveConfig;
  preview: CollectivePreview;
  onClose: () => void;
  onDone: (result: CollectiveResult) => void;
}) {
  const service = useRechnungen();
  const { session } = useAuth();
  const [typed, setTyped] = useState("");
  const [test, setTest] = useState(false);
  const [error, setError] = useState("");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  // Eine Lauf-ID je Dialog: ein erneuter Versuch nach einem Fehler macht dort weiter, wo der Lauf stehen blieb.
  const [runId] = useState(() => crypto.randomUUID());
  const n = count(preview.count);

  const submit = async () => {
    if (typed.replace(/['’\s]/g, "") !== String(preview.count)) {
      setError(t("rechnungen.collective.err.count"));
      return;
    }
    setError("");
    setBusy(true);
    setFailure("");
    try {
      const result = await service.runCollective(config, {
        runId,
        onProgress: setProgress,
        ...(test && session ? { testMailTo: session.email } : {}),
      });
      onDone(result);
    } catch (e) {
      setFailure(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("rechnungen.collective.confirmTitle", { year: config.year, n })}
      width={640}
      closeLabel={t("rechnungen.dialog.close")}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button data-autofocus icon="chevronLeft" onClick={onClose}>
            {t("rechnungen.collective.backToPreview")}
          </Button>
          <Button type="submit" variant="primary" icon="send" disabled={busy}>
            {t("rechnungen.collective.confirmRun", { n })}
          </Button>
        </>
      }
    >
      <dl className="kv rg-kv rg-kv--136">
        <Kv label={t("rechnungen.collective.year")}>{config.year}</Kv>
        <Kv label={t("rechnungen.form.issueDate")}>{date(config.issueDate)}</Kv>
        <Kv label={t("rechnungen.collective.dueOn")}>
          {date(preview.dueDate || addDays(config.issueDate, config.termDays))}
        </Kv>
        <Kv label={t("rechnungen.collective.invoices")}>{n}</Kv>
        <Kv label={t("rechnungen.collective.totalAmount")}>{chf(preview.totalCents)}</Kv>
        <Kv label={t("rechnungen.collective.deliveryLabel")}>
          {t("rechnungen.collective.deliverySplit", {
            mail: count(preview.viaEmail),
            print: count(preview.printCount),
          })}
        </Kv>
      </dl>
      <Message tone="warning" title={t("rechnungen.collective.irreversibleTitle")}>
        {t("rechnungen.collective.irreversibleText", { n })}
      </Message>
      <TextField
        className="rg-w160"
        label={t("rechnungen.collective.countLabel")}
        required
        inputMode="numeric"
        autoComplete="off"
        value={typed}
        error={error}
        hint={t("rechnungen.collective.countHint", { n: preview.count })}
        onChange={(e) => setTyped(e.target.value)}
      />
      {session && (
        <Checkbox
          checked={test}
          onChange={(e) => setTest(e.target.checked)}
          label={t("rechnungen.collective.testSend", { email: session.email })}
        />
      )}
      {busy && (
        <Message>
          {t("rechnungen.collective.progress", { done: count(progress), total: n })}
        </Message>
      )}
      {failure && <Message tone="error">{failure}</Message>}
    </Dialog>
  );
}

/** Beitrag einer Gruppe als Eingabe in der Tabelle; leer = ohne Beitrag. Speichert beim Verlassen des Felds. */
function FeeInput({
  group,
  onSave,
}: {
  group: CollectiveGroup;
  onSave: (text: string) => Promise<string | null>;
}) {
  const shown = group.feeCents === null ? "" : amount(group.feeCents);
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(shown), [shown]);
  return (
    <span className="rg-fee">
      <input
        className={error ? "in in--err rg-w120" : "in rg-w120"}
        inputMode="decimal"
        aria-label={t("rechnungen.collective.feeLabel", { name: group.name })}
        aria-invalid={error ? true : undefined}
        placeholder={t("rechnungen.collective.noFee")}
        value={text}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void onSave(text).then(setError)}
      />
      {error && (
        <span className="rg-fee__err" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
