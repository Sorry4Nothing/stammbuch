import { Fragment, useState } from "react";
import { useAuth } from "../../auth/auth";
import { t } from "../../i18n";
import { Button, DataTable, Message, PageHeader, Panel, useToast, type Column } from "../../ui";
import { formatDate, IconBadge, LoadError, useLoad } from "./common";
import type { SecurityInfo, SettingsUser } from "./model";
import { useSettings } from "./service";
import {
  AddUserDialog,
  PasswordDialog,
  RecoveryCodesDialog,
  RemoveUserDialog,
  TotpDialog,
} from "./UserDialogs";

type Open = "add" | "password" | "totp" | "codes" | { remove: SettingsUser } | null;

/** Einstellungen / Benutzer und Sicherheit (Boards 9.9 bis 9.12). */
export function UsersPage() {
  const service = useSettings();
  const { session } = useAuth();
  const toast = useToast();
  const [users, reloadUsers] = useLoad(service.listUsers.bind(service), [service]);
  const [security, reloadSecurity] = useLoad(service.loadSecurity.bind(service), [service]);
  const [dialog, setDialog] = useState<Open>(null);
  const features = service.features;

  const close = () => setDialog(null);
  const done = (text: Parameters<typeof t>[0], reload?: () => void) => {
    close();
    reload?.();
    toast.show({ tone: "ok", title: t(text) });
  };

  const rows = users.status === "ready" ? users.data : [];
  const columns: Column<SettingsUser>[] = [
    {
      key: "name",
      header: t("settings.users.col.name"),
      width: "184px",
      nowrap: true,
      cell: (u) => (
        <>
          <b>{u.name}</b>
          {u.email === session?.email && <span className="muted"> {t("settings.users.you")}</span>}
        </>
      ),
    },
    { key: "email", header: t("settings.users.col.email"), cell: (u) => u.email },
    {
      key: "totp",
      header: t("settings.users.col.totp"),
      width: "140px",
      nowrap: true,
      cell: (u) =>
        (u.totpEnrolled ?? u.status === "active") ? (
          <IconBadge tone="ok" icon="check">
            {t("settings.users.totp.active")}
          </IconBadge>
        ) : (
          <IconBadge tone="neutral" icon="clock">
            {t("settings.users.totp.pending")}
          </IconBadge>
        ),
    },
    ...(features.lastLogin
      ? [
          {
            key: "lastLogin",
            header: t("settings.users.col.lastLogin"),
            width: "162px",
            nowrap: true,
            cell: (u: SettingsUser) => u.lastLogin ?? "–",
          },
        ]
      : []),
    {
      key: "action",
      header: <span className="visually-hidden">{t("settings.users.col.action")}</span>,
      width: "184px",
      nowrap: true,
      cell: (u) =>
        u.email === session?.email ? (
          <span className="muted">–</span>
        ) : (
          <Button
            small
            icon="trash"
            aria-label={t("settings.users.removeAria", { name: u.name })}
            onClick={() => setDialog({ remove: u })}
          >
            {t("settings.users.remove")}
          </Button>
        ),
    },
  ];

  const info: SecurityInfo | undefined = security.status === "ready" ? security.data : undefined;
  const securityRows: [string, string | null][] = info
    ? [
        [
          t("settings.users.me.password"),
          info.passwordChangedAt
            ? t("settings.users.me.changed", { date: formatDate(info.passwordChangedAt) })
            : null,
        ],
        [
          t("settings.users.me.totp"),
          info.totpSince
            ? t("settings.users.me.since", { date: formatDate(info.totpSince) })
            : null,
        ],
        [
          t("settings.users.me.recovery"),
          info.recoveryLeft !== null && info.recoveryTotal !== null
            ? t("settings.users.me.left", { left: info.recoveryLeft, total: info.recoveryTotal })
            : null,
        ],
      ]
    : [];

  return (
    <div className="page">
      <PageHeader
        crumb={`${t("settings.title")} / ${t("settings.nav.users")}`}
        title={t("settings.nav.users")}
        actions={
          <Button variant="primary" icon="plus" onClick={() => setDialog("add")}>
            {t("settings.users.add")}
          </Button>
        }
      />
      {users.status === "error" ? (
        <LoadError state={users} onRetry={reloadUsers} />
      ) : (
        <div className="page__body">
          <Panel
            title={
              users.status === "ready"
                ? t("settings.users.title", { n: rows.length })
                : t("settings.users.titlePlain")
            }
            flush
          >
            <DataTable
              label={t("settings.users.label")}
              columns={columns}
              rows={rows}
              rowKey={(u) => u.id}
              empty={
                <span className="muted">
                  {t(users.status === "loading" ? "settings.loading" : "settings.empty")}
                </span>
              }
            />
          </Panel>
          <div className="set__cols set__cols--flush">
            <div className="set__col set__col--mid">
              <Panel title={t("settings.users.me.title")}>
                {features.securityInfo && info && (
                  <dl className="kv set__kv">
                    {securityRows.map(([label, value]) => (
                      <Fragment key={label}>
                        <dt>{label}</dt>
                        <dd>{value ?? "–"}</dd>
                      </Fragment>
                    ))}
                  </dl>
                )}
                <div className="set__row set__row--top">
                  <Button icon="lock" onClick={() => setDialog("password")}>
                    {t("settings.users.me.changePassword")}
                  </Button>
                  <Button
                    icon="shield"
                    disabled={!features.totpRenewal}
                    onClick={() => setDialog("totp")}
                  >
                    {t("settings.users.me.renewTotp")}
                  </Button>
                  <Button icon="key" onClick={() => setDialog("codes")}>
                    {t("settings.users.me.newCodes")}
                  </Button>
                </div>
              </Panel>
            </div>
            <div className="set__col">
              <div className="set__stack">
                <Message tone="warning" title={t("settings.users.noRolesTitle")}>
                  {t("settings.users.noRolesText")}
                </Message>
                <Message tone="neutral" title={t("settings.users.otpOnlyTitle")}>
                  {t("settings.users.otpOnlyText")}
                </Message>
              </div>
            </div>
          </div>
        </div>
      )}
      {dialog === "add" && (
        <AddUserDialog onClose={close} onDone={() => done("settings.users.added", reloadUsers)} />
      )}
      {typeof dialog === "object" && dialog !== null && (
        <RemoveUserDialog
          user={dialog.remove}
          showLastLogin={features.lastLogin}
          onClose={close}
          onDone={() => done("settings.users.removed", reloadUsers)}
        />
      )}
      {dialog === "password" && (
        <PasswordDialog
          onClose={close}
          onDone={() => done("settings.password.done", reloadSecurity)}
        />
      )}
      {dialog === "totp" && (
        <TotpDialog onClose={close} onDone={() => done("settings.totp.done", reloadSecurity)} />
      )}
      {dialog === "codes" && (
        <RecoveryCodesDialog
          onClose={close}
          onDone={() => {
            close();
            reloadSecurity();
          }}
        />
      )}
    </div>
  );
}
