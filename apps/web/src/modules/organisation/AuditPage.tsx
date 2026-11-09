import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../i18n";
import { Button, DataTable, Icon, Message, PageHeader, useToast, type Column } from "../../ui";
import { useCurrentTab } from "../../shell/tabs";
import { formatDateTime, IconBadge, LoadError, useLoad } from "./common";
import type { AuditEntry, AuditQuery } from "./model";
import { useSettings } from "./service";

const PAGE_SIZE = 14;
const DAY_MS = 86_400_000;

const RANGES = [
  { value: "7", days: 7, label: t("settings.audit.range.7") },
  { value: "30", days: 30, label: t("settings.audit.range.30") },
  { value: "90", days: 90, label: t("settings.audit.range.90") },
  { value: "", days: 0, label: t("settings.audit.range.all") },
];

/** Aktionen, die das Protokoll heute kennt (`docs/modul-einstellungen-admin.md`). */
const ACTIONS = [
  "organisation.update",
  "organisation.logo.set",
  "organisation.logo.remove",
  "user.add",
  "user.role",
  "user.remove",
  "audit.export",
] as const;
const actionLabel = (code: string) =>
  (ACTIONS as readonly string[]).includes(code)
    ? t(`settings.audit.action.${code}` as Parameters<typeof t>[0])
    : code;

const SECTIONS = ["master", "sender", "bank", "fiscal-year", "modules"];
const targetLabel = (e: AuditEntry) =>
  e.action === "organisation.update" && SECTIONS.includes(e.target)
    ? t(`settings.audit.section.${e.target}` as Parameters<typeof t>[0])
    : e.target;

interface FilterProps {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}

/** Filter wie im Board: sichtbar eine Schaltfläche mit Auswahl, darunter das native Auswahlfeld (Tastatur und Screenreader). */
function Filter({ label, value, options, onChange }: FilterProps) {
  const shown = options.find((o) => o.value === value)?.label ?? "";
  return (
    <span className="in set__filter">
      <span aria-hidden="true">
        {label}: {shown}
      </span>
      <Icon name="chevronDown" />
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/** Einstellungen / Protokoll (Board 9.13): nur lesen, filtern, exportieren. */
export function AuditPage() {
  const service = useSettings();
  const toast = useToast();
  const tab = useCurrentTab();
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [range, setRange] = useState("30");
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [page, setPage] = useState(0);
  const [users] = useLoad(service.listUsers.bind(service), [service]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(input.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [input]);

  const filter = useMemo(() => {
    const days = RANGES.find((r) => r.value === range)?.days ?? 0;
    return {
      ...(days > 0 && { from: new Date(Date.now() - days * DAY_MS).toISOString() }),
      ...(actor && { actor }),
      ...(action && { action }),
      ...(q && { q }),
    };
    // `from` gilt ab dem Moment der Auswahl, nicht fortlaufend.
  }, [range, actor, action, q]);

  const query: AuditQuery = useMemo(
    () => ({ ...filter, offset: page * PAGE_SIZE, limit: PAGE_SIZE }),
    [filter, page],
  );
  const [result, reload] = useLoad((signal) => service.queryAudit(query, signal), [service, query]);

  const total = result.status === "ready" ? result.data.total : 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const { setPage: setTabPage } = tab;
  useEffect(() => setTabPage(page + 1, pages), [setTabPage, page, pages]);
  useEffect(() => () => setTabPage(1, 1), [setTabPage]);

  const names = useMemo(
    () => new Map((users.status === "ready" ? users.data : []).map((u) => [u.email, u.name])),
    [users],
  );
  const actors = [
    { value: "", label: t("settings.audit.all") },
    ...(users.status === "ready" ? users.data : []).map((u) => ({ value: u.email, label: u.name })),
  ];
  const actions = [
    { value: "", label: t("settings.audit.all") },
    ...ACTIONS.map((a) => ({ value: a, label: actionLabel(a) })),
  ];

  const active = [
    range && { key: "range", label: t("settings.audit.filter.range"), clear: () => setRange("") },
    actor && { key: "actor", label: t("settings.audit.filter.actor"), clear: () => setActor("") },
    action && {
      key: "action",
      label: t("settings.audit.filter.action"),
      clear: () => setAction(""),
    },
  ].filter((x): x is { key: string; label: string; clear: () => void } => Boolean(x));
  const valueOf = (key: string) =>
    key === "range"
      ? (RANGES.find((r) => r.value === range)?.label ?? "")
      : key === "actor"
        ? (actors.find((a) => a.value === actor)?.label ?? actor)
        : actionLabel(action);

  const change =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPage(0);
    };

  const columns: Column<AuditEntry>[] = [
    {
      key: "at",
      header: t("settings.audit.col.time"),
      width: "151px",
      nowrap: true,
      cell: (e) => formatDateTime(e.at),
    },
    {
      key: "actor",
      header: t("settings.audit.col.actor"),
      width: "123px",
      nowrap: true,
      cell: (e) => names.get(e.actor) ?? e.actor,
    },
    {
      key: "action",
      header: t("settings.audit.col.action"),
      width: "195px",
      nowrap: true,
      cell: (e) => <b>{actionLabel(e.action)}</b>,
    },
    { key: "target", header: t("settings.audit.col.target"), cell: targetLabel },
    ...(service.features.auditResult
      ? [
          {
            key: "result",
            header: t("settings.audit.col.result"),
            width: "151px",
            nowrap: true,
            cell: (e: AuditEntry) =>
              e.result === "ok" ? (
                <IconBadge tone="ok" icon="check">
                  {t("settings.audit.result.ok")}
                </IconBadge>
              ) : (
                <IconBadge tone="error" icon="warning">
                  {t("settings.audit.result.failed")}
                </IconBadge>
              ),
          },
        ]
      : []),
  ];

  const exportLog = useCallback(async () => {
    try {
      const file = await service.exportAudit(filter);
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.filename;
      link.click();
      URL.revokeObjectURL(url);
      toast.show(
        file.truncated
          ? { tone: "warning", title: t("settings.audit.export.truncated") }
          : { tone: "ok", title: t("settings.audit.export.done") },
      );
    } catch {
      toast.show({ tone: "error", title: t("settings.audit.export.failed") });
    }
  }, [service, filter, toast]);

  return (
    <div className="page">
      <PageHeader
        crumb={`${t("settings.title")} / ${t("settings.nav.audit")}`}
        title={t("settings.nav.audit")}
        status={
          <IconBadge tone="neutral" icon="lock">
            {t("settings.audit.readOnly")}
          </IconBadge>
        }
        actions={
          <Button variant="primary" icon="table" onClick={() => void exportLog()}>
            {t(
              service.features.auditXlsx
                ? "settings.audit.export.xlsx"
                : "settings.audit.export.csv",
            )}
          </Button>
        }
      />
      {result.status === "error" ? (
        <LoadError state={result} onRetry={reload} />
      ) : (
        <>
          <div className="set__intro set__intro--tight">
            <Message tone="neutral" title={t("settings.audit.fixedTitle")}>
              {t("settings.audit.fixedText")}
            </Message>
          </div>
          <div className="set__tool">
            <label className="in set__search">
              <Icon name="search" />
              <input
                type="search"
                aria-label={t("settings.audit.search")}
                placeholder={t("settings.audit.searchPlaceholder")}
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
            </label>
            <Filter
              label={t("settings.audit.filter.range")}
              value={range}
              options={RANGES}
              onChange={change(setRange)}
            />
            <Filter
              label={t("settings.audit.filter.actor")}
              value={actor}
              options={actors}
              onChange={change(setActor)}
            />
            <Filter
              label={t("settings.audit.filter.action")}
              value={action}
              options={actions}
              onChange={change(setAction)}
            />
            <span className="phead__spacer" />
            <span className="muted" aria-live="polite">
              {result.status === "ready"
                ? t("settings.audit.count", {
                    n: result.data.items.length,
                    total: String(result.data.total).replace(/\B(?=(\d{3})+(?!\d))/g, "'"),
                  })
                : ""}
            </span>
          </div>
          {active.length > 0 && (
            <div className="set__chips">
              <span className="muted">{t("settings.audit.active")}</span>
              {active.map((f) => (
                <span key={f.key} className="tag">
                  {f.label}: {valueOf(f.key)}
                  <Button
                    variant="ghost"
                    small
                    icon="close"
                    aria-label={t("settings.audit.filter.remove", { name: f.label })}
                    onClick={() => {
                      f.clear();
                      setPage(0);
                    }}
                  />
                </span>
              ))}
              <Button
                variant="ghost"
                small
                onClick={() => {
                  setRange("");
                  setActor("");
                  setAction("");
                  setPage(0);
                }}
              >
                {t("settings.audit.reset")}
              </Button>
            </div>
          )}
          <div className="set__table">
            <DataTable
              label={t("settings.audit.label")}
              columns={columns}
              rows={result.status === "ready" ? result.data.items : []}
              rowKey={(e) => e.id}
              sort={{ key: "at", direction: "desc" }}
              empty={
                <span className="muted">
                  {t(result.status === "loading" ? "settings.loading" : "settings.audit.none")}
                </span>
              }
            />
          </div>
          <div className="set__pager">
            <Button
              variant="ghost"
              small
              icon="chevronLeft"
              aria-label={t("settings.audit.prev")}
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            />
            <Button
              variant="ghost"
              small
              icon="chevronRight"
              aria-label={t("settings.audit.next")}
              disabled={page + 1 >= pages}
              onClick={() => setPage((p) => p + 1)}
            />
          </div>
        </>
      )}
    </div>
  );
}
