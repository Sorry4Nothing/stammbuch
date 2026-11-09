import { useState } from "react";
import { useAuth } from "../../auth/auth";
import { t, tp } from "../../i18n";
import {
  Badge,
  Button,
  DataTable,
  Icon,
  Message,
  PageHeader,
  Panel,
  type Column,
  type Sort,
} from "../../ui";
import {
  ExtendDialog,
  ReactivateDialog,
  ResetTwoFactorDialog,
  SuspendDialog,
} from "./CustomerDialogs";
import { useChefAdminService } from "./context";
import { daysUntil, formatDate, formatDateTime } from "./format";
import type { AuditRow, Customer, CustomerUser } from "./model";
import { LoadFailed, StatusBadge, auditLabel, orDash, useLoad } from "./shared";

const AUDIT_LIMIT = 50;

type Dialog = { kind: "reset"; user: CustomerUser } | { kind: "suspend" | "reactivate" | "extend" };

/** «31.12.2026 (noch 59 Tage)» */
function endText(c: Customer, now: number): string {
  const date = formatDate(c.licenceUntil);
  const days = daysUntil(c.licenceUntil, now);
  if (days < 0) return t("chef.detail.endPast", { date });
  if (days === 0) return t("chef.detail.endToday", { date });
  return tp("chef.detail.endDays", days, { date });
}

/** Kunde-Detail (Design 10.3) mit den Dialogen 10.4 und 10.5. Zeigt nur Vertragsdaten, nie Daten des Kunden. */
export function CustomerDetailPage({ id }: { id: string }) {
  const service = useChefAdminService();
  const { now } = useAuth();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [auditSort, setAuditSort] = useState<Sort>({ key: "at", direction: "desc" });

  const customer = useLoad((signal) => service.getCustomer(id, signal), [service, id]);
  const users = useLoad((signal) => service.customerUsers(id, signal), [service, id]);
  const name = customer.data?.name;
  const audit = useLoad(
    async (signal) =>
      name ? service.audit({ q: name, limit: AUDIT_LIMIT }, signal) : ([] as AuditRow[]),
    [service, name],
  );

  if (customer.failed) return <LoadFailed onRetry={customer.reload} />;
  const c = customer.data;
  if (!c) {
    return (
      <div className="ca-state">
        <span className="muted is-loading" role="status">
          {t("chef.loading")}
        </span>
      </div>
    );
  }

  const changed = () => {
    setDialog(null);
    customer.reload();
    users.reload();
    audit.reload();
  };

  const userColumns: Column<CustomerUser>[] = [
    {
      key: "name",
      header: t("chef.detail.col.name"),
      width: "129px",
      cell: (u) => <b>{u.name}</b>,
    },
    { key: "email", header: t("chef.detail.col.email"), cell: (u) => u.email },
    {
      key: "totp",
      header: t("chef.detail.col.totp"),
      width: "129px",
      cell: (u) =>
        u.totp === "set" ? (
          <Badge tone="ok">
            <Icon name="check" size={12} />
            {t("chef.detail.totp.set")}
          </Badge>
        ) : (
          <Badge tone="warning">
            <Icon name="warning" size={12} />
            {t("chef.detail.totp.missing")}
          </Badge>
        ),
    },
    {
      key: "lastLogin",
      header: t("chef.detail.col.lastLogin"),
      width: "151px",
      cell: (u) => formatDateTime(u.lastLogin),
    },
    {
      key: "action",
      header: t("chef.detail.col.action"),
      width: "160px",
      cell: (u) => (
        <Button
          small
          aria-label={t("chef.detail.resetFor", { name: u.name })}
          onClick={() => setDialog({ kind: "reset", user: u })}
        >
          {t("chef.detail.reset")}
        </Button>
      ),
    },
  ];

  const auditRows = [...(audit.data ?? [])].sort((a, b) =>
    auditSort.direction === "desc" ? b.at.localeCompare(a.at) : a.at.localeCompare(b.at),
  );
  const auditColumns: Column<AuditRow>[] = [
    {
      key: "at",
      header: t("chef.detail.col.time"),
      width: "151px",
      sortable: true,
      cell: (e) => formatDateTime(e.at),
    },
    { key: "actor", header: t("chef.detail.col.by"), width: "118px", cell: (e) => e.actor },
    {
      key: "action",
      header: t("chef.detail.col.what"),
      width: "195px",
      cell: (e) => <b>{auditLabel(e.action)}</b>,
    },
    { key: "target", header: t("chef.detail.col.detail"), cell: (e) => e.target },
  ];

  return (
    <>
      <PageHeader
        crumb={`${t("chef.crumb.root")} / ${t("chef.crumb.customers")} / ${c.ref}`}
        title={c.name}
        status={<StatusBadge customer={c} />}
      />
      <div className="ca-split">
        <div className="ca-split__main">
          <Panel title={t("chef.detail.licence")}>
            <dl className="kv">
              <dt>{t("chef.detail.ref")}</dt>
              <dd>{c.ref}</dd>
              <dt>{t("chef.detail.licenceNo")}</dt>
              <dd>{orDash(c.licenceNumber)}</dd>
              <dt>{t("chef.detail.start")}</dt>
              <dd>{formatDate(c.licenceStart)}</dd>
              <dt>{t("chef.detail.end")}</dt>
              <dd>{endText(c, now)}</dd>
              <dt>{t("chef.detail.modules")}</dt>
              <dd>{orDash(c.modules && c.modules.map((m) => t(`chef.module.${m}`)).join(", "))}</dd>
              <dt>{t("chef.detail.contact")}</dt>
              <dd>{orDash(c.contact)}</dd>
            </dl>
          </Panel>
          <Panel
            title={
              users.data
                ? t("chef.detail.users", { n: users.data.length })
                : t("chef.detail.usersPlain")
            }
            flush={!!users.data?.length}
          >
            {users.failed ? (
              <LoadFailed onRetry={users.reload} />
            ) : users.data ? (
              users.data.length === 0 ? (
                <Message tone="neutral">{t("chef.detail.usersEmpty")}</Message>
              ) : (
                <DataTable
                  label={t("chef.detail.usersTable")}
                  columns={userColumns}
                  rows={users.data}
                  rowKey={(u) => u.id}
                />
              )
            ) : (
              <span className="muted is-loading" role="status">
                {t("chef.loading")}
              </span>
            )}
          </Panel>
          <Panel title={t("chef.detail.audit")} flush>
            {audit.failed ? (
              <LoadFailed onRetry={audit.reload} />
            ) : (
              <DataTable
                label={t("chef.detail.audit")}
                columns={auditColumns}
                rows={auditRows}
                rowKey={(e) => e.id}
                sort={auditSort}
                onSortChange={setAuditSort}
                empty={<span className="muted">{t("chef.detail.auditEmpty")}</span>}
              />
            )}
          </Panel>
        </div>
        <div className="ca-split__side ca-side--360">
          <Panel title={t("chef.detail.actions")}>
            <div className="ca-stack ca-stack--tight">
              {c.status !== "ended" && (
                <Button icon="refresh" onClick={() => setDialog({ kind: "extend" })}>
                  {t("chef.detail.extend")}
                </Button>
              )}
              {c.status === "suspended" && (
                <Button icon="undo" onClick={() => setDialog({ kind: "reactivate" })}>
                  {t("chef.detail.reactivate")}
                </Button>
              )}
              {c.status !== "ended" && (
                <Button icon="ban" onClick={() => setDialog({ kind: "suspend" })}>
                  {t("chef.detail.suspend")}
                </Button>
              )}
            </div>
          </Panel>
          <Panel title={t("chef.detail.hidden")}>
            <div className="ca-stack ca-stack--tight">
              {(
                [
                  "chef.detail.hidden.members",
                  "chef.detail.hidden.invoices",
                  "chef.detail.hidden.mails",
                  "chef.detail.hidden.events",
                ] as const
              ).map((key) => (
                <span key={key} className="ca-hidden">
                  <Icon name="lock" />
                  {t(key)}
                </span>
              ))}
            </div>
          </Panel>
        </div>
      </div>

      {dialog?.kind === "reset" && (
        <ResetTwoFactorDialog
          customer={c}
          user={dialog.user}
          onClose={() => setDialog(null)}
          onDone={changed}
        />
      )}
      {dialog?.kind === "suspend" && (
        <SuspendDialog customer={c} onClose={() => setDialog(null)} onChanged={changed} />
      )}
      {dialog?.kind === "reactivate" && (
        <ReactivateDialog customer={c} onClose={() => setDialog(null)} onChanged={changed} />
      )}
      {dialog?.kind === "extend" && (
        <ExtendDialog customer={c} onClose={() => setDialog(null)} onChanged={changed} />
      )}
    </>
  );
}
