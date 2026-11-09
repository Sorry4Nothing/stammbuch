import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../auth/auth";
import { t, tp, type TextKey } from "../../i18n";
import { useCurrentTab } from "../../shell/tabs";
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  Message,
  PageHeader,
  TextField,
  useToast,
  type Column,
  type Tone,
} from "../../ui";
import { belegNr, chDate, chf, entryKinds, isoDay, pairLines, parseChDate } from "./format";
import {
  DialogClose,
  errorText,
  FilterSelect,
  Kv,
  LoadError,
  Pager,
  RowPick,
  SearchBox,
  Summary,
  Toolbar,
  useLoad,
} from "./parts";
import { useBuchhaltung } from "./service";
import type { Entry, EntryKind } from "./types";

const PAGE_SIZE = 14;

interface Row {
  key: string;
  entry: Entry;
  /** «1/2» */
  position: string;
  debit: string;
  credit: string;
  amount: number;
}

const kindTone: Record<EntryKind, Tone> = {
  payment: "ok",
  reversal: "warning",
  invoice: "neutral",
  credit_note: "neutral",
  manual: "neutral",
};

const kindLabel = (k: EntryKind) => t(`bh.buchungen.kind.${k}` as TextKey);

function expand(entry: Entry): Row[] {
  const pairs = pairLines(entry.lines);
  return pairs.map((p, i) => ({
    key: `${entry.id}:${i}`,
    entry,
    position: `${i + 1}/${pairs.length}`,
    debit: p.debit,
    credit: p.credit,
    amount: p.amount,
  }));
}

function ReverseDialog({
  entry,
  onClose,
  onDone,
}: {
  entry: Entry;
  onClose: () => void;
  onDone: () => void;
}) {
  const service = useBuchhaltung();
  const { now } = useAuth();
  const toast = useToast();
  const key = useRef(crypto.randomUUID());
  const [date, setDate] = useState(chDate(isoDay(now)));
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<{ date?: string; reason?: string }>({});
  const [failure, setFailure] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const nr = belegNr(entry);
  const pairs = pairLines(entry.lines);
  const total = pairs.reduce((s, p) => s + p.amount, 0);

  const submit = async () => {
    const iso = parseChDate(date);
    const next = {
      date: iso ? undefined : t("bh.storno.dateError"),
      reason: reason.trim().length >= 3 ? undefined : t("bh.storno.reasonError"),
    };
    setErrors(next);
    setFailure(undefined);
    if (!iso || next.reason || busy) return;
    setBusy(true);
    try {
      await service.reverseEntry(entry.id, {
        idempotencyKey: key.current,
        bookingDate: iso,
        reason: reason.trim(),
      });
      toast.show({ tone: "ok", title: t("bh.storno.done") });
      onDone();
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<Row>[] = [
    { key: "line", header: t("bh.col.line"), width: "63px", cell: (r) => r.position },
    { key: "debit", header: t("bh.col.debit"), width: "74px", cell: (r) => r.debit },
    { key: "credit", header: t("bh.col.credit"), width: "74px", cell: (r) => r.credit },
    { key: "text", header: t("bh.col.text2"), cell: () => t("bh.storno.rowText", { nr }) },
    {
      key: "amount",
      header: t("bh.col.amount"),
      width: "118px",
      align: "right",
      cell: (r) => chf(r.amount),
    },
  ];
  // Die Gegenbuchung vertauscht Soll und Haben.
  const preview = expand(entry).map((r) => ({ ...r, debit: r.credit, credit: r.debit }));

  return (
    <Dialog
      title={t("bh.storno.title", { nr })}
      width={640}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button data-autofocus onClick={onClose}>
            {t("ui.cancel")}
          </Button>
          <Button variant="primary" type="submit" icon="check" disabled={busy}>
            {t("bh.storno.submit")}
          </Button>
        </>
      }
    >
      <DialogClose onClick={onClose} />
      {failure && <Message tone="error">{failure}</Message>}
      <Kv
        rows={[
          [
            t("bh.storno.beleg"),
            t("bh.storno.belegValue", {
              nr,
              date: chDate(entry.bookingDate),
              lines: tp("bh.storno.lines", pairs.length),
            }),
          ],
          [t("bh.storno.text"), entry.description],
          [t("bh.storno.amount"), chf(total)],
        ]}
      />
      <div>
        <b>{t("bh.storno.preview")}</b>
      </div>
      <DataTable
        label={t("bh.storno.previewLabel")}
        columns={columns}
        rows={preview}
        rowKey={(r) => r.key}
      />
      <div className="bh-form-row">
        <TextField
          label={t("bh.storno.date")}
          required
          hint={t("bh.storno.dateHint")}
          error={errors.date}
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <TextField
          label={t("bh.storno.reason")}
          required
          error={errors.reason}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <Message tone="warning" title={t("bh.storno.keepTitle")}>
        {t("bh.storno.keepText")}
      </Message>
    </Dialog>
  );
}

/** Buchungen (Design 5.2, 5.3): nur lesen und per Gegenbuchung korrigieren. */
export function BuchungenPage() {
  const service = useBuchhaltung();
  const tab = useCurrentTab();
  const { now } = useAuth();
  const accountCode = tab.params["accountCode"];
  const thisYear = Number(isoDay(now).slice(0, 4));
  const [year, setYear] = useState(String(thisYear));
  const [kind, setKind] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [pickedId, setPickedId] = useState<string | undefined>();
  const [reversing, setReversing] = useState<Entry | undefined>();

  const { data, error, reload } = useLoad(
    () =>
      service.listEntries({
        from: `${year}-01-01`,
        to: `${year}-12-31`,
        accountCode,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    [service, year, accountCode, page],
  );

  useEffect(() => {
    tab.setPage(page + 1, data?.hasMore ? page + 2 : page + 1);
  }, [tab, page, data?.hasMore]);

  const all = useMemo(() => (data?.items ?? []).flatMap(expand), [data]);
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return all.filter(
      (r) =>
        (kind === "all" || r.entry.kind === kind) &&
        (!needle ||
          [belegNr(r.entry), r.entry.description, r.debit, r.credit]
            .join(" ")
            .toLowerCase()
            .includes(needle)),
    );
  }, [all, kind, search]);

  const picked = data?.items.find((e) => e.id === pickedId);
  const selected = new Set(rows.filter((r) => r.entry.id === pickedId).map((r) => r.key));

  const columns: Column<Row>[] = [
    {
      key: "beleg",
      header: t("bh.col.beleg"),
      width: "129px",
      // Nur die erste Zeile eines Belegs ist bedienbar; die weiteren zeigen die Nummer als Text.
      cell: (r) =>
        r.position.startsWith("1/") ? (
          <RowPick
            label={t("bh.buchungen.select", { nr: belegNr(r.entry) })}
            pressed={r.entry.id === pickedId}
            onClick={() => setPickedId(r.entry.id)}
          >
            <b>{belegNr(r.entry)}</b>
          </RowPick>
        ) : (
          <b>{belegNr(r.entry)}</b>
        ),
    },
    { key: "line", header: t("bh.col.line"), width: "74px", cell: (r) => r.position },
    {
      key: "date",
      header: t("bh.col.date"),
      width: "118px",
      cell: (r) => chDate(r.entry.bookingDate),
    },
    { key: "text", header: t("bh.col.text"), cell: (r) => r.entry.description },
    { key: "debit", header: t("bh.col.debit"), width: "74px", cell: (r) => r.debit },
    { key: "credit", header: t("bh.col.credit"), width: "74px", cell: (r) => r.credit },
    {
      key: "amount",
      header: t("bh.col.amount"),
      width: "129px",
      align: "right",
      cell: (r) => chf(r.amount),
    },
    {
      key: "kind",
      header: t("bh.col.kind"),
      width: "118px",
      cell: (r) => <Badge tone={kindTone[r.entry.kind]}>{kindLabel(r.entry.kind)}</Badge>,
    },
    // Die API liefert nur die Benutzerkennung; Namen löst sie nicht auf (siehe PR, «Fehlende API»).
    {
      key: "by",
      header: t("bh.col.by"),
      width: "140px",
      cell: (r) => (r.entry.kind === "payment" ? t("bh.buchungen.system") : r.entry.createdBy),
    },
  ];

  const years = [thisYear, thisYear - 1].map((y) => ({
    value: String(y),
    label: t("bh.common.year", { year: y }),
  }));
  const kinds = [
    { value: "all", label: t("bh.buchungen.kindFilter", { value: t("bh.common.all") }) },
    ...entryKinds.map((k) => ({
      value: k,
      label: t("bh.buchungen.kindFilter", { value: kindLabel(k) }),
    })),
  ];

  return (
    <div className="page">
      <PageHeader
        crumb={t("bh.crumb", { page: t("bh.tab.buchungen") })}
        title={t("bh.buchungen.title")}
        status={
          <>
            <Badge>{t("bh.buchungen.appendOnly")}</Badge>
            {accountCode && <Badge>{t("bh.common.account", { code: accountCode })}</Badge>}
          </>
        }
        actions={
          <Button
            variant="primary"
            icon="undo"
            disabled={!picked}
            onClick={() => setReversing(picked)}
          >
            {t("bh.buchungen.reverse")}
          </Button>
        }
      />
      <div className="bh-pad bh-pad--tight">
        <Message tone="neutral" title={t("bh.buchungen.immutableTitle")}>
          {t("bh.buchungen.immutableText")}
        </Message>
      </div>
      <Toolbar>
        <SearchBox placeholder={t("bh.buchungen.search")} value={search} onChange={setSearch} />
        <FilterSelect
          label={t("bh.common.period")}
          value={year}
          onChange={(v) => {
            setYear(v);
            setPage(0);
          }}
          options={years}
        />
        <FilterSelect label={t("bh.col.kind")} value={kind} onChange={setKind} options={kinds} />
        <span className="bh-spacer" />
        <Summary shown={rows.length} total={all.length} column={t("bh.buchungen.sorted")} />
      </Toolbar>
      {error ? (
        <LoadError error={error} onRetry={reload} />
      ) : (
        <>
          <div className="bh-pad">
            <DataTable
              label={t("bh.tab.buchungen")}
              columns={columns}
              rows={rows}
              rowKey={(r) => r.key}
              selected={selected}
              onRowActivate={(r) => {
                setPickedId(r.entry.id);
                setReversing(r.entry);
              }}
              empty={<EmptyState icon="book" title={t("bh.common.empty")} />}
            />
          </div>
          <Pager
            text={t("bh.common.page", { n: page + 1 })}
            hasPrev={page > 0}
            hasNext={!!data?.hasMore}
            onPrev={() => setPage((p) => p - 1)}
            onNext={() => setPage((p) => p + 1)}
            note={t("bh.buchungen.perPage", { n: PAGE_SIZE })}
          />
        </>
      )}
      {reversing && (
        <ReverseDialog
          entry={reversing}
          onClose={() => setReversing(undefined)}
          onDone={() => {
            setReversing(undefined);
            setPickedId(undefined);
            reload();
          }}
        />
      )}
    </div>
  );
}
