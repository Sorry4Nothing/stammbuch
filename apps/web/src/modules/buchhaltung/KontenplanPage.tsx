import { useMemo, useState } from "react";
import { t, type TextKey } from "../../i18n";
import {
  Badge,
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
import { accountTypes, chf } from "./format";
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
      else await service.createAccount({ code, name: name.trim(), type });
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
        hint={t("bh.kontenplan.codeHint")}
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
  const [dialog, setDialog] = useState<"create" | "rename" | undefined>();

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
    // Die API kennt weder MwSt-Satz noch Buchungszahl je Konto (siehe PR, «Fehlende API»).
    { key: "vat", header: t("bh.col.vat"), width: "85px", cell: () => "–" },
    { key: "count", header: t("bh.col.count"), width: "118px", align: "right", cell: () => "–" },
    {
      key: "balance",
      header: t("bh.col.balance"),
      width: "151px",
      align: "right",
      cell: (a) => chf(a.balance),
    },
  ];

  const unavailable = async (what: "accounts") => {
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
        status={
          <>
            <Badge>{t("bh.kontenplan.onlyDebtors")}</Badge>
            <Badge>{t("bh.kontenplan.currency")}</Badge>
          </>
        }
        actions={
          <>
            <Button icon="table" onClick={() => void unavailable("accounts")}>
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
        <Summary
          shown={rows.length}
          total={data?.length ?? 0}
          column={t("bh.kontenplan.sorted")}
          direction={sort.direction}
        />
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
                    [t("bh.col.debit"), chf(selected.debit)],
                    [t("bh.col.credit"), chf(selected.credit)],
                    [t("bh.col.balance"), <b key="b">{chf(selected.balance)}</b>],
                    [t("bh.col.count"), "–"],
                    [t("bh.kontenplan.last"), "–"],
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
                </div>
              </Panel>
              <Message tone="neutral" title={t("bh.kontenplan.noDeleteTitle")}>
                {t("bh.kontenplan.noDeleteText")}
              </Message>
            </div>
          )}
        </div>
      )}
      {dialog && (
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
