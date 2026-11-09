import { useState, type ReactNode } from "react";
import { useAuth } from "../../auth/auth";
import { t } from "../../i18n";
import {
  Badge,
  Button,
  DataTable,
  Icon,
  Message,
  PageHeader,
  Panel,
  useToast,
  type Column,
  type IconName,
} from "../../ui";
import { PasswordDialog, RecoveryCodesDialog } from "./AccountDialogs";
import { useChefAdminService } from "./context";
import { formatDate, formatDateTime } from "./format";
import type { AuditRow, LoginRow, SessionRow } from "./model";
import { LoadFailed, auditLabel, useLoad } from "./shared";

const ACTION_LIMIT = 5;

function Row({
  title,
  sub,
  icon,
  action,
  disabled,
  onClick,
}: {
  title: string;
  sub?: ReactNode;
  icon: IconName;
  action: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <div className="ca-row">
      <div className="ca-row__text">
        <b>{title}</b>
        {sub && <div className="muted">{sub}</div>}
      </div>
      <Button icon={icon} disabled={disabled} onClick={onClick}>
        {action}
      </Button>
    </div>
  );
}

/** Eigenes Konto und Sicherheit (Design 10.6): Passwort, Einmalcode, Wiederherstellungscodes, Sitzungen, Protokoll. */
export function AccountPage() {
  const service = useChefAdminService();
  const { session } = useAuth();
  const toast = useToast();
  const [dialog, setDialog] = useState<"password" | "codes" | null>(null);

  const account = useLoad((signal) => service.account(signal), [service]);
  const actions = useLoad((signal) => service.audit({ limit: ACTION_LIMIT }, signal), [service]);

  if (account.failed) return <LoadFailed onRetry={account.reload} />;
  const a = account.data;
  if (!a) {
    return (
      <div className="ca-state">
        <span className="muted" role="status">
          {t("chef.loading")}
        </span>
      </div>
    );
  }

  const endSession = async (row: SessionRow) => {
    try {
      await service.endSession(row.id);
      account.reload();
    } catch {
      toast.show({ tone: "error", title: t("chef.password.failed") });
    }
  };

  const sessionColumns: Column<SessionRow>[] = [
    {
      key: "device",
      header: t("chef.account.col.device"),
      cell: (s) =>
        s.current ? (
          <>
            <b>{t("chef.account.thisDevice")}</b> · {s.device}
          </>
        ) : (
          s.device
        ),
    },
    {
      key: "since",
      header: t("chef.account.col.since"),
      width: "151px",
      cell: (s) => formatDateTime(s.since),
    },
    {
      key: "end",
      header: t("chef.account.col.session"),
      width: "151px",
      cell: (s) =>
        s.current ? (
          <Badge tone="ok">
            <Icon name="check" size={12} />
            {t("chef.account.current")}
          </Badge>
        ) : (
          <Button
            small
            aria-label={t("chef.account.endSessionFor", { device: s.device })}
            onClick={() => void endSession(s)}
          >
            {t("chef.account.endSession")}
          </Button>
        ),
    },
  ];

  const loginColumns: Column<LoginRow>[] = [
    {
      key: "at",
      header: t("chef.detail.col.time"),
      width: "151px",
      cell: (l) => formatDateTime(l.at),
    },
    { key: "method", header: t("chef.account.col.login"), cell: (l) => l.method },
    {
      key: "result",
      header: t("chef.account.col.result"),
      width: "162px",
      cell: (l) =>
        l.success ? (
          <Badge tone="ok">
            <Icon name="shield" size={12} />
            {t("chef.account.loginOk")}
          </Badge>
        ) : (
          <Badge tone="error">
            <Icon name="warning" size={12} />
            {t("chef.account.loginFailed")}
          </Badge>
        ),
    },
  ];

  const actionColumns: Column<AuditRow>[] = [
    {
      key: "at",
      header: t("chef.detail.col.time"),
      width: "173px",
      sortable: true,
      cell: (e) => formatDateTime(e.at),
    },
    {
      key: "action",
      header: t("chef.account.col.action"),
      width: "250px",
      cell: (e) => <b>{auditLabel(e.action)}</b>,
    },
    { key: "target", header: t("chef.account.col.target"), cell: (e) => e.target },
  ];

  const unavailable = <Message tone="neutral">{t("chef.unavailable")}</Message>;

  return (
    <>
      <PageHeader
        crumb={`${t("chef.crumb.root")} / ${t("chef.crumb.account")}`}
        title={t("chef.account.title")}
        status={
          <Badge tone="ok">
            <Icon name="shield" size={12} />
            {t("chef.account.badge")}
          </Badge>
        }
      />
      <div className="ca-split">
        <div className="ca-split__main">
          <Panel title={t("chef.account.access")} flush>
            <div className="ca-row">
              <div className="ca-row__text">
                <b>{t("chef.account.account")}</b>
                <div className="muted">{`${t("chef.me.role")} · ${a.email || session?.email || ""}`}</div>
              </div>
            </div>
            <Row
              title={t("chef.account.password")}
              sub={
                a.passwordChangedAt &&
                t("chef.account.passwordSince", { date: formatDate(a.passwordChangedAt) })
              }
              icon="key"
              action={t("chef.account.passwordChange")}
              onClick={() => setDialog("password")}
            />
            <Row
              title={t("chef.account.totp")}
              sub={
                a.totpSetUpAt && t("chef.account.totpSince", { date: formatDate(a.totpSetUpAt) })
              }
              icon="qr"
              action={t("chef.account.totpRenew")}
              disabled
            />
            <Row
              title={t("chef.account.codes")}
              sub={
                a.recoveryCodes &&
                t("chef.account.codesLeft", {
                  unused: a.recoveryCodes.unused,
                  total: a.recoveryCodes.total,
                })
              }
              icon="refresh"
              action={t("chef.account.codesRenew")}
              onClick={() => setDialog("codes")}
            />
          </Panel>
        </div>
        <div className="ca-split__side ca-side--560">
          <Panel
            title={
              a.sessions
                ? t("chef.account.sessions", { n: a.sessions.length })
                : t("chef.account.sessionsPlain")
            }
            flush={!!a.sessions}
          >
            {a.sessions ? (
              <DataTable
                label={t("chef.account.sessionsPlain")}
                columns={sessionColumns}
                rows={a.sessions}
                rowKey={(s) => s.id}
              />
            ) : (
              unavailable
            )}
          </Panel>
          <Panel title={t("chef.account.logins")} flush={!!a.logins}>
            {a.logins ? (
              <DataTable
                label={t("chef.account.logins")}
                columns={loginColumns}
                rows={a.logins}
                rowKey={(l) => l.id}
              />
            ) : (
              unavailable
            )}
          </Panel>
        </div>
      </div>
      <div className="ca-full">
        <Panel title={t("chef.account.actions")} flush>
          {actions.failed ? (
            <LoadFailed onRetry={actions.reload} />
          ) : (
            <DataTable
              label={t("chef.account.actionsTable")}
              columns={actionColumns}
              rows={actions.data ?? []}
              rowKey={(e) => e.id}
              sort={{ key: "at", direction: "desc" }}
              empty={<span className="muted">{t("chef.detail.auditEmpty")}</span>}
            />
          )}
        </Panel>
      </div>
      {dialog === "password" && (
        <PasswordDialog onClose={() => setDialog(null)} onChanged={() => setDialog(null)} />
      )}
      {dialog === "codes" && (
        <RecoveryCodesDialog onClose={() => setDialog(null)} onRenewed={account.reload} />
      )}
    </>
  );
}
