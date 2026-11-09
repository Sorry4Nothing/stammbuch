import { useMemo, useState } from "react";
import { t, type TextKey } from "../../i18n";
import { useTabs } from "../../shell/tabs";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Message,
  PageHeader,
  type Column,
  type Sort,
} from "../../ui";
import { formatDate } from "./format";
import { useMailService } from "./mailContext";
import type { AddressListSummary, ListKind } from "./mailService";
import {
  FilterSelect,
  Loading,
  LoadError,
  MailLayout,
  SearchBox,
  SelectionBar,
  ToolCount,
} from "./parts";
import { useLoad, useOnActivate } from "./useMail";

const number = (n: number | null) => (n === null ? "–" : String(n));

type TypeFilter = "all" | ListKind;

/** Adresslisten (Design 7.8). */
export function ListsPage() {
  const service = useMailService();
  const { openTab } = useTabs();
  const [load, reload] = useLoad((signal) => service.lists(signal), [service]);
  useOnActivate(reload);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<TypeFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<Sort>({ key: "name", direction: "asc" });

  const data = load.status === "ready" ? load.data : undefined;
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = (data ?? []).filter(
      (l) =>
        (type === "all" || l.kind === type) && (!needle || l.name.toLowerCase().includes(needle)),
    );
    const dir = sort.direction === "asc" ? 1 : -1;
    return list.sort((a, b) => a.name.localeCompare(b.name, "de") * dir);
  }, [data, query, type, sort]);

  const one = selected.size === 1 ? data?.find((l) => selected.has(l.id)) : undefined;

  const edit = () => {
    if (!one) return;
    openTab(one.kind === "manual" ? "mail-list" : "mail-list-groups", {
      key: `list:${one.id}`,
      params: { listId: one.id },
      title: one.name,
    });
  };

  const columns: Column<AddressListSummary>[] = [
    {
      key: "name",
      header: t("mail.lists.col.name"),
      width: "195px",
      sortable: true,
      cell: (l) => <b>{l.name}</b>,
    },
    {
      key: "kind",
      header: t("mail.lists.col.type"),
      width: "107px",
      cell: (l) => <Badge tone="neutral">{t(`mail.lists.type.${l.kind}` as TextKey)}</Badge>,
    },
    { key: "source", header: t("mail.lists.col.source"), cell: (l) => l.source },
    {
      key: "persons",
      header: t("mail.lists.col.persons"),
      width: "85px",
      align: "right",
      cell: (l) => number(l.persons),
    },
    {
      key: "without",
      header: t("mail.lists.col.withoutEmail"),
      width: "107px",
      align: "right",
      cell: (l) => number(l.withoutEmail),
    },
    {
      key: "recipients",
      header: t("mail.lists.col.recipients"),
      width: "96px",
      align: "right",
      cell: (l) => <b>{number(l.recipients)}</b>,
    },
    {
      key: "last",
      header: t("mail.lists.col.lastUsed"),
      width: "135px",
      cell: (l) => formatDate(l.lastUsedAt),
    },
  ];

  return (
    <MailLayout current="lists">
      <PageHeader
        crumb={t("mail.crumb.lists")}
        title={t("mail.lists.title")}
        actions={
          <>
            <Button
              icon="people"
              onClick={() =>
                openTab("mail-list-groups", { params: {}, title: t("mail.listGroups.tab") })
              }
            >
              {t("mail.lists.fromGroups")}
            </Button>
            <Button
              variant="primary"
              icon="plus"
              onClick={() => openTab("mail-list", { params: {}, title: t("mail.listEdit.new") })}
            >
              {t("mail.lists.new")}
            </Button>
          </>
        }
      />
      <div className="tool">
        <SearchBox label={t("mail.lists.search")} value={query} onChange={setQuery} />
        <FilterSelect
          label={t("mail.lists.col.type")}
          value={type}
          options={(["all", "group", "groups", "manual"] as const).map((k) => ({
            value: k,
            label: `${t("mail.lists.col.type")}: ${k === "all" ? t("mail.filter.status.all") : t(`mail.lists.type.${k}` as TextKey)}`,
          }))}
          onChange={(v) => setType(v as TypeFilter)}
        />
        <ToolCount shown={rows.length} total={data?.length ?? 0} sortLabel={t("mail.lists.sort")} />
      </div>
      <SelectionBar count={selected.size}>
        <Button icon="edit" disabled={!one} onClick={edit}>
          {t("mail.lists.edit")}
        </Button>
        <Button
          icon="mail"
          disabled={!one}
          onClick={() =>
            one &&
            openTab("mail-bulk", {
              key: `mail-bulk:${one.id}`,
              params: { listId: one.id },
              title: t("mail.bulk.title"),
            })
          }
        >
          {t("mail.lists.write")}
        </Button>
      </SelectionBar>
      {load.status === "loading" && <Loading />}
      {load.status === "error" && <LoadError load={load} onRetry={reload} />}
      {data && (
        <>
          <div className="mail__table">
            <DataTable
              label={t("mail.lists.title")}
              columns={columns}
              rows={rows}
              rowKey={(l) => l.id}
              selectable
              selected={selected}
              onSelectedChange={setSelected}
              sort={sort}
              onSortChange={setSort}
              onRowActivate={(l) => {
                setSelected(new Set([l.id]));
                openTab(l.kind === "manual" ? "mail-list" : "mail-list-groups", {
                  key: `list:${l.id}`,
                  params: { listId: l.id },
                  title: l.name,
                });
              }}
              empty={
                <EmptyState title={t("mail.lists.empty.title")} text={t("mail.lists.empty.text")} />
              }
            />
          </div>
          <div className="mail__note">
            <Message tone="neutral" title={t("mail.lists.note.title")}>
              {t("mail.lists.note.text")}
            </Message>
          </div>
        </>
      )}
    </MailLayout>
  );
}
