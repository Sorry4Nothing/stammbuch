import { useState } from "react";
import { orgName } from "../config";
import { useAuth } from "../auth/auth";
import { t } from "../i18n";
import { useTheme } from "../theme/ThemeProvider";
import { Button, Icon } from "../ui";
import { NameDialog } from "./NameDialog";
import { useNavCounts } from "./navCounters";
import { useTabs } from "./tabs";

function formatSession(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return t("shell.session", { h: Math.floor(minutes / 60), min: minutes % 60 });
}

interface SidebarProps {
  onLogout: () => void;
}

/** Seitenleiste (Design 2.1): Marke, Module, Benutzer, Theme-Umschalter. */
export function Sidebar({ onLogout }: SidebarProps) {
  const { modules, active, openTab } = useTabs();
  const { session, now } = useAuth();
  const { theme, toggle } = useTheme();
  const [renaming, setRenaming] = useState(false);
  const counts = useNavCounts(active?.id);

  const sorted = [...modules].sort((a, b) => a.nav.order - b.nav.order);
  const main = sorted.filter((m) => (m.nav.section ?? "main") === "main");
  const footer = sorted.filter((m) => m.nav.section === "footer");

  const item = (m: (typeof sorted)[number]) => {
    const current = active?.moduleId === m.id;
    const count = counts[m.id];
    return (
      <button
        key={m.id}
        type="button"
        className={current ? "nav__item is-active" : "nav__item"}
        aria-current={current ? "page" : undefined}
        onClick={() => openTab(m.nav.tabType, { key: m.nav.tabType })}
      >
        <Icon name={m.nav.icon} size={18} />
        <span>{t(m.nav.labelKey)}</span>
        {count && count.count > 0 && (
          <span className="nav__count">
            <span aria-hidden="true">{count.count}</span>
            <span className="visually-hidden">{count.label}</span>
          </span>
        )}
      </button>
    );
  };

  return (
    <aside className="side">
      <div className="brand">
        <div className="mark" aria-hidden="true">
          S
        </div>
        <div>
          <div className="brand__name">{t("app.title")}</div>
          {(session?.organization || orgName) && (
            <div className="brand__org">{session?.organization || orgName}</div>
          )}
        </div>
      </div>
      <nav className="nav" aria-label={t("app.nav.label")}>
        {main.map(item)}
        {footer.length > 0 && <div className="nav__sep" role="separator" />}
        {footer.map(item)}
      </nav>
      <div className="me">
        {session && (
          <>
            <b>{session.name}</b>
            {session.email !== session.name && <span>{session.email}</span>}
            <span>{formatSession(now - session.startedAt)}</span>
          </>
        )}
        <div className="me__actions">
          <Button variant="ghost" small icon={theme === "dark" ? "sun" : "moon"} onClick={toggle}>
            {theme === "dark" ? t("shell.theme.toLight") : t("shell.theme.toDark")}
          </Button>
          {session && (
            <Button variant="ghost" small icon="edit" onClick={() => setRenaming(true)}>
              {t("shell.name.change")}
            </Button>
          )}
          {session && (
            <Button variant="ghost" small icon="logout" onClick={onLogout}>
              {t("shell.logout")}
            </Button>
          )}
        </div>
      </div>
      {renaming && <NameDialog onClose={() => setRenaming(false)} />}
    </aside>
  );
}
