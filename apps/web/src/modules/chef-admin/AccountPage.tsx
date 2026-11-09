import { useState, type ReactNode } from "react";
import { useAuth } from "../../auth/auth";
import { t } from "../../i18n";
import {
  Badge,
  Button,
  DataTable,
  Icon,
  PageHeader,
  Panel,
  useToast,
  type Column,
  type IconName,
} from "../../ui";
import { PasswordDialog, RecoveryCodesDialog, TotpDialog } from "./AccountDialogs";
import { useChefAdminService } from "./context";
import { formatDate, formatDateTime } from "./format";
import type { AuditRow, LoginRow, SessionRow } from "./model";
import { LoadFailed, auditLabel, useLoad } from "./shared";

const ACTION_LIMIT = 5;

/** Das Gerät erfasst die API nicht; die Sitzung heisst nach ihrem Beginn. */
const sessionLabel = (s: SessionRow) =>
  s.device ?? t("chef.account.sessionSince", { when: formatDateTime(s.since) });

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
  const [dialog, setDialog] = useState<"password" | "codes" | "totp" | null>(null);

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
      cell: (s) => (s.current ? <b>{sessionLabel(s)}</b> : sessionLabel(s)),
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
            aria-label={t("chef.account.endSessionFor", { device: sessionLabel(s) })}
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
    {
      key: "method",
      header: t("chef.account.col.login"),
      cell: (l) => t(`chef.account.method.${l.method}`),
    },
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
                a.passwordChangedAt
                  ? t("chef.account.passwordSince", { date: formatDate(a.passwordChangedAt) })
                  : t("chef.account.passwordNever")
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
              onClick={() => setDialog("totp")}
            />
            <Row
              title={t("chef.account.codes")}
              sub={t("chef.account.codesLeft", {
                unused: a.recoveryCodes.unused,
                total: a.recoveryCodes.total,
              })}
              icon="refresh"
              action={t("chef.account.codesRenew")}
              onClick={() => setDialog("codes")}
            />
          </Panel>
        </div>
        <div className="ca-split__side ca-side--560">
          <Panel title={t("chef.account.sessions", { n: a.sessions.length })} flush>
            <DataTable
              label={t("chef.account.sessionsPlain")}
              columns={sessionColumns}
              rows={a.sessions}
              rowKey={(s) => s.id}
            />
          </Panel>
          <Panel title={t("chef.account.logins")} flush>
            <DataTable
              label={t("chef.account.logins")}
              columns={loginColumns}
              rows={a.logins}
              rowKey={(l) => l.id}
              empty={<span className="muted">{t("chef.account.loginsEmpty")}</span>}
            />
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
      {dialog === "totp" && (
        <TotpDialog
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            account.reload();
          }}
        />
      )}
      {dialog === "codes" && (
        <RecoveryCodesDialog onClose={() => setDialog(null)} onRenewed={account.reload} />
      )}
    </>
  );
}
