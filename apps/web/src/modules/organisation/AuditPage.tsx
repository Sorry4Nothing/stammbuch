import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../i18n";
import { Button, DataTable, Icon, PageHeader, useToast, type Column } from "../../ui";
import { useCurrentTab } from "../../shell/tabs";
import { useOnTabActivate } from "../../shell/useOnTabActivate";
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

/** Aktionen, die das Protokoll kennt, nach Bereich. Jede hat ein Label in `settings.audit.action.*`. */
const ACTION_GROUPS = [
  {
    key: "auth",
    actions: [
      "login_success",
      "login_failure",
      "login_locked",
      "logout",
      "mfa_success",
      "mfa_failure",
      "mfa_replay",
      "mfa_enrolled",
      "mfa_renewed",
      "mfa_reset",
      "mfa_reset_denied",
      "recovery_used",
      "recovery_codes_renewed",
      "recovery_failure",
      "stepup_failure",
      "password_changed",
      "password_change_failure",
      "password_reset_requested",
      "password_reset_done",
      "password_reset_failure",
      "password_reset_rejected",
      "name_changed",
      "invitation_redeemed",
      "invitation_rejected",
      "invitation_failure",
      "csrf_rejected",
      "session_rejected",
      "notice_failed",
    ],
  },
  {
    key: "people",
    actions: [
      "mitglied.anlegen",
      "mitglied.aendern",
      "mitglied.freigeben",
      "mitglied.ablehnen",
      "mitglied.zusammenfuehren",
      "mitglied.import",
      "mitglied.export",
      "mitglied.sammelaktion",
      "duplikat.kein_duplikat",
      "gruppe.anlegen",
      "gruppe.aendern",
      "gruppe.aufloesen",
      "gruppe.zuweisen",
      "gruppe.entfernen",
      "firma.anlegen",
      "firma.aendern",
      "firma.freigeben",
      "firma.ablehnen",
      "firma.zusammenfuehren",
      "registrierung.person",
      "registrierung.firma",
    ],
  },
  {
    key: "accounting",
    actions: [
      "buchung.anlegen",
      "buchung.zahlung",
      "buchung.stornieren",
      "zuordnung.anlegen",
      "zuordnung.aufheben",
      "periode.abschliessen",
      "periode.oeffnen",
      "konto.anlegen",
      "konto.aendern",
    ],
  },
  {
    key: "invoices",
    actions: [
      "invoice.create",
      "invoice.update",
      "invoice.delete",
      "invoice.send",
      "invoice.email",
      "invoice.email-batch",
      "invoice.cancel",
      "invoice.credit",
      "invoice.collective",
      "invoice.payment",
      "invoice.payment-reverse",
      "invoice.reminder",
      "invoice.reminder-email",
      "invoice.settings",
      "camt.import",
      "camt.assign",
      "camt.postpone",
      "camt.restore",
    ],
  },
  {
    key: "events",
    actions: [
      "event.create",
      "event.update",
      "event.invite",
      "aufgabe.anlegen",
      "aufgabe.erledigen",
    ],
  },
  {
    key: "mail",
    actions: [
      "mail.send",
      "mail.campaign.pause",
      "mail.campaign.send-now",
      "mail.campaign.reschedule",
      "mail.campaign.cancel",
      "mail.reply",
      "mail.delete",
    ],
  },
  {
    key: "settings",
    actions: [
      "organisation.update",
      "organisation.logo.set",
      "organisation.logo.remove",
      "user.add",
      "user.role",
      "user.remove",
      "audit.export",
    ],
  },
] as const;
const KNOWN: ReadonlySet<string> = new Set(ACTION_GROUPS.flatMap((g) => g.actions));
/** Unbekannte Schlüssel erscheinen nie roh. */
const actionLabel = (code: string) =>
  t(
    (KNOWN.has(code)
      ? `settings.audit.action.${code}`
      : "settings.audit.action.other") as Parameters<typeof t>[0],
  );

const SECTIONS = ["master", "sender", "bank", "fiscal-year", "modules"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Das Objekt nie als rohe ID zeigen; was die API nicht auflösen kann, bleibt «–». */
const targetLabel = (e: AuditEntry) =>
  e.action === "organisation.update" && SECTIONS.includes(e.target)
    ? t(`settings.audit.section.${e.target}` as Parameters<typeof t>[0])
    : !e.target || UUID.test(e.target)
      ? "–"
      : e.target;

interface FilterProps {
  label: string;
  value: string;
  options: readonly { value: string; label: string; group?: string }[];
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
      <select
        name="filter"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options
          .filter((o) => !o.group)
          .map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        {[...new Set(options.flatMap((o) => (o.group ? [o.group] : [])))].map((g) => (
          <optgroup key={g} label={g}>
            {options
              .filter((o) => o.group === g)
              .map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </span>
  );
}

/** Einstellungen / Protokoll (Board 9.13): nur lesen, filtern, exportieren. */
/** Voreinstellung des Zeitraums; sie gilt nicht als Filter. */
const DEFAULT_RANGE = "30";

export function AuditPage() {
  const service = useSettings();
  const toast = useToast();
  const tab = useCurrentTab();
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [range, setRange] = useState(DEFAULT_RANGE);
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

  useOnTabActivate(reload);

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
    ...ACTION_GROUPS.flatMap((g) =>
      g.actions.map((a) => ({
        value: a,
        label: actionLabel(a),
        group: t(`settings.audit.group.${g.key}` as Parameters<typeof t>[0]),
      })),
    ),
  ];

  const clearSearch = () => {
    setInput("");
    setQ("");
  };
  const active = [
    range !== DEFAULT_RANGE && {
      key: "range",
      label: t("settings.audit.filter.range"),
      clear: () => setRange(DEFAULT_RANGE),
    },
    actor && { key: "actor", label: t("settings.audit.filter.actor"), clear: () => setActor("") },
    action && {
      key: "action",
      label: t("settings.audit.filter.action"),
      clear: () => setAction(""),
    },
    q && { key: "q", label: t("settings.audit.filter.q"), clear: clearSearch },
  ].filter((x): x is { key: string; label: string; clear: () => void } => Boolean(x));
  const valueOf = (key: string) =>
    key === "range"
      ? (RANGES.find((r) => r.value === range)?.label ?? "")
      : key === "actor"
        ? (actors.find((a) => a.value === actor)?.label ?? actor)
        : key === "q"
          ? q
          : actionLabel(action);

  const resetFilters = () => {
    setRange(DEFAULT_RANGE);
    setActor("");
    setAction("");
    clearSearch();
    setPage(0);
  };

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
      width: "148px",
      nowrap: true,
      cell: (e) => formatDateTime(e.at),
    },
    {
      key: "actor",
      header: t("settings.audit.col.actor"),
      width: "168px",
      nowrap: true,
      cell: (e) => {
        const who = names.get(e.actor) ?? e.actor;
        return (
          <span className="set__clip" title={who}>
            {who}
          </span>
        );
      },
    },
    {
      key: "action",
      header: t("settings.audit.col.action"),
      width: "140px",
      cell: (e) => <b>{actionLabel(e.action)}</b>,
    },
    { key: "target", header: t("settings.audit.col.target"), cell: targetLabel },
    ...(service.features.auditResult
      ? [
          {
            key: "result",
            header: t("settings.audit.col.result"),
            width: "148px",
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
        title={t("settings.nav.audit")}
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
          <div className="set__tool">
            <label className="in set__search">
              <Icon name="search" />
              <input
                name="q"
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
            <span className="muted set__nowrap" aria-live="polite">
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
              <Button variant="ghost" small onClick={resetFilters}>
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
                result.status === "loading" ? (
                  <span className="muted">{t("settings.loading")}</span>
                ) : (
                  <span className="muted">
                    {t("settings.audit.none")}
                    {active.length > 0 && (
                      <>
                        {" "}
                        <Button variant="secondary" small onClick={resetFilters}>
                          {t("settings.audit.resetFilters")}
                        </Button>
                      </>
                    )}
                  </span>
                )
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
