import type { ReactNode } from "react";
import { useAuth } from "../../auth/auth";
import { t } from "../../i18n";
import { Icon, Message, PageHeader, Panel, type IconName } from "../../ui";
import { formatDate, IconBadge, LoadError, useLoad } from "./common";
import type { Licence } from "./model";
import { useSettings } from "./service";

const DAY_MS = 86_400_000;

/** Tage von heute bis `iso` (negativ: vorbei). Es zählen Kalendertage, nicht Stunden. */
function daysUntil(iso: string, now: number): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const today = new Date(now);
  const a = Date.UTC(y!, m! - 1, d!);
  const b = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((a - b) / DAY_MS);
}

function Items({ icon, items }: { icon: IconName; items: string[] }) {
  return (
    <div className="set__stack set__stack--tight">
      {items.map((item) => (
        <span key={item} className="opt">
          <Icon name={icon} size={16} />
          {item}
        </span>
      ))}
    </div>
  );
}

/** Einstellungen / Lizenz (Boards 9.14 und 9.15): aktiv, oder abgelaufen im Nur-Lesen-Modus. */
export function LicencePage() {
  const service = useSettings();
  const { now } = useAuth();
  const [state, reload] = useLoad(service.loadLicence.bind(service), [service]);
  const [org] = useLoad(service.loadOrganisation.bind(service), [service]);

  if (state.status === "error") {
    return (
      <div className="page">
        <PageHeader title={t("settings.nav.licence")} />
        <LoadError state={state} onRetry={reload} />
      </div>
    );
  }
  if (state.status === "loading") {
    return (
      <div className="page">
        <PageHeader title={t("settings.nav.licence")} />
        <p className="set__sub muted">{t("settings.loading")}</p>
      </div>
    );
  }

  const licence: Licence = state.data;
  const active = licence.state === "active";
  const days = daysUntil(licence.validUntil, now);
  const optionalOn =
    org.status === "ready"
      ? [
          org.data.data.sammelrechnung && t("settings.modules.bulk"),
          org.data.data.mail && t("settings.modules.mail"),
          org.data.data.kalender && t("settings.modules.calendar"),
        ].filter((x): x is string => Boolean(x))
      : [];

  const badge: ReactNode = active ? (
    <IconBadge tone="ok" icon="check">
      {t("settings.licence.state.active")}
    </IconBadge>
  ) : (
    <IconBadge tone="error" icon="warning">
      {t(`settings.licence.state.${licence.state}`)}
    </IconBadge>
  );

  const status = active
    ? t(days === 1 ? "settings.licence.activeDays.one" : "settings.licence.activeDays", {
        n: days,
      })
    : licence.state === "expired"
      ? t(days === -1 ? "settings.licence.expiredDays.one" : "settings.licence.expiredDays", {
          n: Math.abs(days),
        })
      : t(`settings.licence.state.${licence.state}`);

  const rows: [string, ReactNode][] = [
    ...(licence.licensee
      ? ([[t("settings.licence.licensee"), licence.licensee]] as [string, ReactNode][])
      : []),
    ...(licence.customerId
      ? ([[t("settings.licence.customerId"), licence.customerId]] as [string, ReactNode][])
      : []),
    ...(licence.licenceNo
      ? ([[t("settings.licence.no"), licence.licenceNo]] as [string, ReactNode][])
      : []),
    ...(licence.validFrom
      ? ([[t("settings.licence.from"), formatDate(licence.validFrom)]] as [string, ReactNode][])
      : []),
    [t("settings.licence.until"), formatDate(licence.validUntil)],
    [
      t("settings.licence.status"),
      <IconBadge key="s" tone={active ? "ok" : "error"} icon={active ? "check" : "warning"}>
        {status}
      </IconBadge>,
    ],
    ...(licence.users !== undefined
      ? ([[t("settings.licence.users"), String(licence.users)]] as [string, ReactNode][])
      : []),
  ];

  const mail = licence.providerEmail ? `mailto:${licence.providerEmail}` : undefined;
  const contact = (
    <a
      className={active ? "btn btn--secondary" : "btn btn--primary"}
      href={mail}
      aria-disabled={mail ? undefined : true}
    >
      <Icon name="mail" />
      {t("settings.licence.contact")}
    </a>
  );
  const readOnly = !active;

  return (
    <div className="page">
      <PageHeader title={t("settings.nav.licence")} status={badge} />
      {readOnly && (
        <div className="set__intro">
          <Message
            tone="error"
            title={t(`settings.licence.alert.${licence.state}` as Parameters<typeof t>[0])}
          />
        </div>
      )}
      <div className="set__cols set__cols--gap">
        <div className="set__col set__col--wide">
          <Panel title={t("settings.licence.title")}>
            <dl className="kv set__kv">
              {rows.map(([label, value]) => (
                <KvRow key={label} label={label}>
                  {value}
                </KvRow>
              ))}
            </dl>
          </Panel>
          <div className="set__pair2 set__pair2--wide">
            {active ? (
              <>
                <Panel title={t("settings.licence.always")}>
                  <Items
                    icon="check"
                    items={[
                      t("settings.modules.people"),
                      t("settings.modules.invoices"),
                      t("settings.modules.accounting"),
                      t("settings.modules.reports"),
                    ]}
                  />
                </Panel>
                <Panel title={t("settings.licence.optional")}>
                  <Items icon="check" items={optionalOn} />
                </Panel>
              </>
            ) : (
              <>
                <Panel title={t("settings.licence.still")}>
                  <Items
                    icon="check"
                    items={[
                      t("settings.licence.still.view"),
                      t("settings.licence.still.search"),
                      t("settings.licence.still.export"),
                      t("settings.licence.still.audit"),
                    ]}
                  />
                </Panel>
                <Panel title={t("settings.licence.locked")}>
                  <Items
                    icon="ban"
                    items={[
                      t("settings.licence.locked.people"),
                      t("settings.licence.locked.invoices"),
                      t("settings.licence.locked.accounting"),
                      t("settings.licence.locked.mail"),
                    ]}
                  />
                </Panel>
              </>
            )}
          </div>
        </div>
        <div className="set__col">
          <Panel title={t("settings.licence.renew")}>
            <span className="muted set__lead">
              {active
                ? licence.customerId
                  ? t("settings.licence.renewTextId", { id: licence.customerId })
                  : t("settings.licence.renewText")
                : licence.customerId
                  ? t("settings.licence.renewExpiredId")
                  : t("settings.licence.renewExpired")}
            </span>
            {contact}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function KvRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}
