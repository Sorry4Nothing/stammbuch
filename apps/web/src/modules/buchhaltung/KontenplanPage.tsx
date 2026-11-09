import { useMemo, useState } from "react";
import { t, type TextKey } from "../../i18n";
import {
  Button,
  DataTable,
  Dialog,
  EmptyState,
  Message,
  PageHeader,
  Panel,
  Select,
  TextField,
  useToast,
  type Column,
  type Sort,
} from "../../ui";
import { useTabs } from "../../shell/tabs";
import { accountTypes, chf, taxRateAllowed, taxRateLabel, taxRates } from "./format";
import {
  DialogClose,
  errorText,
  FilterSelect,
  Kv,
  LoadError,
  RowPick,
  SearchBox,
  Summary,
  Toolbar,
  useLoad,
} from "./parts";
import { useBuchhaltung } from "./service";
import { TAB } from "./tabs";
import { type AccountRow, type AccountType } from "./types";

const classLabel = (type: AccountType) => t(`bh.kontenplan.class.${type}` as TextKey);

/** Auswahl des Steuersatzes; der Wert `""` heisst «ohne Steuer». */
const rateOptions = [
  { value: "", label: t("bh.kontenplan.vat.none") },
  ...taxRates.map((bp) => ({ value: String(bp), label: taxRateLabel(bp) })),
];

function AccountDialog({
  account,
  onClose,
  onDone,
}: {
  /** Fehlt: neues Konto. Sonst nur die Bezeichnung ändern. */
  account?: AccountRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const service = useBuchhaltung();
  const toast = useToast();
  const [code, setCode] = useState(account?.code ?? "");
  const [name, setName] = useState(account?.name ?? "");
  const [type, setType] = useState<AccountType>(account?.type ?? "asset");
  const [rate, setRate] = useState(
    account?.taxRateBp === undefined ? "" : String(account.taxRateBp),
  );
  const [errors, setErrors] = useState<{ code?: string; name?: string }>({});
  const [failure, setFailure] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const next = {
      code: account || /^\d{4,6}$/.test(code) ? undefined : t("bh.kontenplan.codeError"),
      name: name.trim().length >= 2 ? undefined : t("bh.kontenplan.nameError"),
    };
    setErrors(next);
    setFailure(undefined);
    if (next.code || next.name || busy) return;
    setBusy(true);
    try {
      if (account) await service.renameAccount(account.code, name.trim());
      else {
        await service.createAccount({
          code,
          name: name.trim(),
          type,
          ...(rate && taxRateAllowed(type, code) ? { taxRateBp: Number(rate) } : {}),
        });
      }
      toast.show({
        tone: "ok",
        title: t(account ? "bh.kontenplan.renamed" : "bh.kontenplan.created"),
      });
      onDone();
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const title = t(account ? "bh.kontenplan.rename" : "bh.kontenplan.create");
  return (
    <Dialog
      title={title}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button variant="primary" type="submit" icon={account ? "edit" : "plus"} disabled={busy}>
            {title}
          </Button>
        </>
      }
    >
      <DialogClose onClick={onClose} />
      {failure && <Message tone="error">{failure}</Message>}
      <TextField
        label={t("bh.kontenplan.code")}
        required
        placeholder={t("bh.kontenplan.codeHint")}
        error={errors.code}
        value={code}
        readOnly={!!account}
        mono
        data-autofocus={account ? undefined : ""}
        onChange={(e) => setCode(e.target.value)}
      />
      <TextField
        label={t("bh.col.name")}
        required
        error={errors.name}
        value={name}
        data-autofocus={account ? "" : undefined}
        onChange={(e) => setName(e.target.value)}
      />
      {!account && (
        <Select
          label={t("bh.col.class")}
          value={type}
          onChange={(e) => setType(e.target.value as AccountType)}
          options={accountTypes.map((v) => ({ value: v, label: classLabel(v) }))}
        />
      )}
      {!account && taxRateAllowed(type, code) && (
        <Select
          label={t("bh.kontenplan.vat.label")}
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          options={rateOptions}
        />
      )}
    </Dialog>
  );
}

/** Steuersatz eines bestehenden Kontos ändern. Er gilt für neue Buchungen; frühere behalten ihren Satz. */
function TaxRateDialog({
  account,
  onClose,
  onDone,
}: {
  account: AccountRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const service = useBuchhaltung();
  const toast = useToast();
  const [rate, setRate] = useState(
    account.taxRateBp === undefined ? "" : String(account.taxRateBp),
  );
  const [failure, setFailure] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await service.setAccountTaxRate(account.code, rate ? Number(rate) : null);
      toast.show({ tone: "ok", title: t("bh.kontenplan.vat.saved") });
      onDone();
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const title = t("bh.kontenplan.vat.change");
  return (
    <Dialog
      title={title}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button variant="primary" type="submit" icon="edit" disabled={busy}>
            {title}
          </Button>
        </>
      }
    >
      <DialogClose onClick={onClose} />
      {failure && <Message tone="error">{failure}</Message>}
      <Select
        label={t("bh.kontenplan.vat.label")}
        hint={t("bh.kontenplan.vat.hintChange")}
        value={rate}
        data-autofocus=""
        onChange={(e) => setRate(e.target.value)}
        options={rateOptions}
      />
    </Dialog>
  );
}

/** Kontenplan (Design 5.1). Salden aus der Saldenliste der API. */
export function KontenplanPage() {
  const service = useBuchhaltung();
  const { openTab } = useTabs();
  const toast = useToast();
  const { data, error, reload } = useLoad(() => service.listAccounts(), [service]);
  const [search, setSearch] = useState("");
  const [klass, setKlass] = useState("all");
  const [sort, setSort] = useState<Sort>({ key: "code", direction: "asc" });
  const [picked, setPicked] = useState<string | undefined>();
  const [dialog, setDialog] = useState<"create" | "rename" | "vat" | undefined>();

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = (data ?? []).filter(
      (a) =>
        (klass === "all" || a.type === klass) &&
        (!needle || a.code.includes(needle) || a.name.toLowerCase().includes(needle)),
    );
    const dir = sort.direction === "asc" ? 1 : -1;
    return list.sort((a, b) => dir * a.code.localeCompare(b.code));
  }, [data, search, klass, sort.direction]);

  const selected = rows.find((a) => a.code === picked) ?? rows[0];

  const columns: Column<AccountRow>[] = [
    {
      key: "code",
      header: t("bh.col.account"),
      width: "85px",
      sortable: true,
      cell: (a) => (
        <RowPick
          label={t("bh.kontenplan.rowSelect", { code: a.code })}
          pressed={a.code === selected?.code}
          onClick={() => setPicked(a.code)}
        >
          {a.code}
        </RowPick>
      ),
    },
    { key: "name", header: t("bh.col.name"), cell: (a) => <b>{a.name}</b> },
    { key: "class", header: t("bh.col.class"), width: "107px", cell: (a) => classLabel(a.type) },
    { key: "vat", header: t("bh.col.vat"), width: "85px", cell: (a) => taxRateLabel(a.taxRateBp) },
    {
      key: "count",
      header: t("bh.col.count"),
      width: "118px",
      align: "right",
      cell: (a) => a.entryCount ?? "–",
    },
    {
      key: "balance",
      header: t("bh.col.balance"),
      width: "151px",
      align: "right",
      cell: (a) => chf(a.balance),
    },
  ];

  const exportXlsx = async (what: "accounts") => {
    try {
      await service.exportXlsx(what);
    } catch (e) {
      toast.show({ tone: "error", title: errorText(e) });
    }
  };

  const classOptions = [
    { value: "all", label: t("bh.kontenplan.classFilter", { value: t("bh.common.all") }) },
    ...accountTypes.map((v) => ({
      value: v,
      label: t("bh.kontenplan.classFilter", { value: classLabel(v) }),
    })),
  ];

  return (
    <div className="page">
      <PageHeader
        crumb={t("bh.crumb", { page: t("bh.tab.kontenplan") })}
        title={t("bh.kontenplan.title")}
        actions={
          <>
            <Button icon="table" onClick={() => void exportXlsx("accounts")}>
              {t("bh.common.export")}
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setDialog("create")}>
              {t("bh.kontenplan.create")}
            </Button>
          </>
        }
      />
      <Toolbar>
        <SearchBox placeholder={t("bh.kontenplan.search")} value={search} onChange={setSearch} />
        <FilterSelect
          label={t("bh.col.class")}
          value={klass}
          onChange={setKlass}
          options={classOptions}
        />
        <span className="bh-spacer" />
        <Summary shown={rows.length} total={data?.length ?? 0} />
      </Toolbar>
      {error ? (
        <LoadError error={error} what={t("bh.kontenplan.title")} onRetry={reload} />
      ) : (
        <div className="bh-split">
          <div className="bh-split__main">
            <DataTable
              label={t("bh.tab.kontenplan")}
              columns={columns}
              rows={rows}
              rowKey={(a) => a.code}
              selected={new Set(selected ? [selected.code] : [])}
              sort={sort}
              onSortChange={setSort}
              empty={<EmptyState title={t("bh.common.empty")} />}
            />
          </div>
          {selected && (
            <div className="bh-split__side">
              <Panel
                title={t("bh.kontenplan.detail", { code: selected.code, name: selected.name })}
              >
                <Kv
                  rows={[
                    [t("bh.col.class"), classLabel(selected.type)],
                    [t("bh.col.vat"), taxRateLabel(selected.taxRateBp)],
                    [t("bh.col.debit"), chf(selected.debit)],
                    [t("bh.col.credit"), chf(selected.credit)],
                    [t("bh.col.balance"), <b key="b">{chf(selected.balance)}</b>],
                    [t("bh.col.count"), selected.entryCount ?? "–"],
                  ]}
                />
                <div className="bh-stack">
                  <Button
                    icon="list"
                    onClick={() =>
                      openTab(TAB.buchungen, {
                        key: `konto-${selected.code}`,
                        params: { accountCode: selected.code },
                        title: `${t("bh.tab.buchungen")} ${selected.code}`,
                      })
                    }
                  >
                    {t("bh.kontenplan.showEntries")}
                  </Button>
                  <Button icon="clock" onClick={() => openTab(TAB.offene, { key: TAB.offene })}>
                    {t("bh.kontenplan.showOpen")}
                  </Button>
                  <Button icon="edit" onClick={() => setDialog("rename")}>
                    {t("bh.kontenplan.rename")}
                  </Button>
                  {taxRateAllowed(selected.type, selected.code) && (
                    <Button icon="edit" onClick={() => setDialog("vat")}>
                      {t("bh.kontenplan.vat.change")}
                    </Button>
                  )}
                </div>
              </Panel>
            </div>
          )}
        </div>
      )}
      {dialog === "vat" && selected && (
        <TaxRateDialog
          account={selected}
          onClose={() => setDialog(undefined)}
          onDone={() => {
            setDialog(undefined);
            reload();
          }}
        />
      )}
      {(dialog === "create" || dialog === "rename") && (
        <AccountDialog
          account={dialog === "rename" ? selected : undefined}
          onClose={() => setDialog(undefined)}
          onDone={() => {
            setDialog(undefined);
            reload();
          }}
        />
      )}
    </div>
  );
}
