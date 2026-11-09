import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../auth/auth";
import { t, type TextKey } from "../../i18n";
import { Button, DataTable, Icon, PageHeader, type Column, type Sort } from "../../ui";
import { useChefAdminService, useChefNav } from "./context";
import { daysUntil, formatDate } from "./format";
import { LICENCE_MODULES, type Customer, type CustomerStatus } from "./model";
import { LoadFailed, StatusBadge, orDash, useLoad } from "./shared";

const PAGE_SIZE = 16;
const SOON_DAYS = 90;
const SEARCH_DELAY_MS = 200;

type LicenceFilter = "all" | "soon" | "expired";

const STATUS_OPTIONS: { value: "all" | CustomerStatus; key: TextKey }[] = [
  { value: "all", key: "chef.customers.filter.status.all" },
  { value: "active", key: "chef.customers.filter.status.active" },
  { value: "suspended", key: "chef.customers.filter.status.suspended" },
  { value: "ended", key: "chef.customers.filter.status.ended" },
];

const LICENCE_OPTIONS: { value: LicenceFilter; key: TextKey }[] = [
  { value: "all", key: "chef.customers.filter.licence.all" },
  { value: "soon", key: "chef.customers.filter.licence.soon" },
  { value: "expired", key: "chef.customers.filter.licence.expired" },
];

const compare: Record<string, (a: Customer, b: Customer) => number> = {
  ref: (a, b) => a.ref.localeCompare(b.ref, "de-CH", { numeric: true }),
  name: (a, b) => a.name.localeCompare(b.name, "de-CH"),
  until: (a, b) => a.licenceUntil.localeCompare(b.licenceUntil),
};

/** Kundenliste (Design 10.1). Suche und Status filtert die API, Lizenzfilter, Sortierung und Seiten die Oberfläche. */
export function CustomersPage() {
  const service = useChefAdminService();
  const { go, searchRequest } = useChefNav();
  const { now } = useAuth();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | CustomerStatus>("all");
  const [licence, setLicence] = useState<LicenceFilter>("all");
  const [sort, setSort] = useState<Sort>({ key: "ref", direction: "desc" });
  const [page, setPage] = useState(1);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    if (searchRequest > 0) input.current?.focus();
  }, [searchRequest]);

  const list = useLoad(
    (signal) =>
      service.listCustomers(
        { ...(query ? { q: query } : {}), ...(status !== "all" ? { status } : {}) },
        signal,
      ),
    [service, query, status],
  );

  const rows = useMemo(() => {
    const items = (list.data?.items ?? []).filter((c) => {
      if (licence === "all") return true;
      const days = daysUntil(c.licenceUntil, now);
      return licence === "expired" ? days < 0 : days >= 0 && days <= SOON_DAYS;
    });
    const by = compare[sort.key] ?? compare["ref"]!;
    return items.sort((a, b) => (sort.direction === "asc" ? by(a, b) : by(b, a)));
  }, [list.data, licence, sort, now]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const shown = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const filtered = query !== "" || status !== "all" || licence !== "all";

  const open = (c: Customer) => go({ name: "customer", id: c.id });
  const columns: Column<Customer>[] = [
    {
      key: "ref",
      header: t("chef.customers.col.ref"),
      width: "107px",
      sortable: true,
      cell: (c) => <b>{c.ref}</b>,
    },
    {
      key: "name",
      header: t("chef.customers.col.org"),
      sortable: true,
      cell: (c) => (
        <a
          href={`#${c.ref}`}
          className="lk"
          onClick={(e) => {
            e.preventDefault();
            open(c);
          }}
        >
          {c.name}
        </a>
      ),
    },
    {
      key: "contact",
      header: t("chef.customers.col.contact"),
      width: "250px",
      cell: (c) => orDash(c.contact),
    },
    {
      key: "licenceNo",
      header: t("chef.customers.col.licenceNo"),
      width: "118px",
      cell: (c) => orDash(c.licenceNumber),
    },
    {
      key: "until",
      header: t("chef.customers.col.until"),
      width: "107px",
      sortable: true,
      cell: (c) => formatDate(c.licenceUntil),
    },
    {
      key: "status",
      header: t("chef.customers.col.status"),
      width: "129px",
      cell: (c) => <StatusBadge customer={c} />,
    },
    {
      key: "users",
      header: t("chef.customers.col.users"),
      width: "85px",
      align: "right",
      cell: (c) => orDash(c.userCount),
    },
    {
      key: "modules",
      header: t("chef.customers.col.modules"),
      width: "85px",
      align: "right",
      cell: (c) =>
        c.modules
          ? t("chef.customers.modules", { n: c.modules.length, total: LICENCE_MODULES.length })
          : t("chef.dash"),
    },
  ];

  return (
    <>
      <PageHeader
        crumb={`${t("chef.crumb.root")} / ${t("chef.crumb.customers")}`}
        title={t("chef.customers.title")}
        actions={
          <Button variant="primary" icon="plus" onClick={() => go({ name: "new" })}>
            {t("chef.customers.create")}
          </Button>
        }
      />
      <div className="ca-tool">
        <div className="in ca-search">
          <Icon name="search" />
          <input
            ref={input}
            type="search"
            aria-label={t("chef.customers.search")}
            placeholder={t("chef.customers.search")}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <span className="sel ca-filter">
          <select
            className="in"
            aria-label={t("chef.customers.filter.status")}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as "all" | CustomerStatus);
              setPage(1);
            }}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.key)}
              </option>
            ))}
          </select>
          <Icon name="chevronDown" />
        </span>
        <span className="sel ca-filter">
          <select
            className="in"
            aria-label={t("chef.customers.filter.licence")}
            value={licence}
            onChange={(e) => {
              setLicence(e.target.value as LicenceFilter);
              setPage(1);
            }}
          >
            {LICENCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.key)}
              </option>
            ))}
          </select>
          <Icon name="chevronDown" />
        </span>
        <span className="ca-tool__spacer" />
        {list.data && (
          <span className="muted" role="status">
            {t("chef.customers.count", { shown: shown.length, total: rows.length })}
          </span>
        )}
      </div>
      {list.failed ? (
        <LoadFailed onRetry={list.reload} />
      ) : !list.data ? (
        <div className="ca-state">
          <span className="muted is-loading" role="status">
            {t("chef.loading")}
          </span>
        </div>
      ) : (
        <>
          <div className="ca-table">
            <DataTable
              label={t("chef.customers.table")}
              columns={columns}
              rows={shown}
              rowKey={(c) => c.id}
              sort={sort}
              onSortChange={setSort}
              onRowActivate={open}
              empty={
                <span className="muted">
                  {filtered ? t("chef.customers.empty") : t("chef.customers.none")}
                </span>
              }
            />
          </div>
          {pages > 1 && (
            <div className="ca-pager">
              <Button
                variant="ghost"
                small
                icon="chevronLeft"
                aria-label={t("chef.customers.prev")}
                disabled={current <= 1}
                onClick={() => setPage(current - 1)}
              />
              <span>{t("chef.customers.page", { page: current, pages })}</span>
              <Button
                variant="ghost"
                small
                icon="chevronRight"
                aria-label={t("chef.customers.next")}
                disabled={current >= pages}
                onClick={() => setPage(current + 1)}
              />
            </div>
          )}
        </>
      )}
    </>
  );
}
