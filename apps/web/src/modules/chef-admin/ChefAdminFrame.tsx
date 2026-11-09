import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { SessionExpiredDialog } from "../../auth/SessionExpiredDialog";
import { useAuth } from "../../auth/auth";
import { t, type TextKey } from "../../i18n";
import { useGlobalShortcuts } from "../../shell/shortcuts";
import { useTheme } from "../../theme/ThemeProvider";
import { Button, Icon, Kbd, type IconName } from "../../ui";
import { AccountPage } from "./AccountPage";
import { CustomerCreatePage } from "./CustomerCreatePage";
import { CustomerDetailPage } from "./CustomerDetailPage";
import { CustomersPage } from "./CustomersPage";
import { RotationPage } from "./RotationPage";
import { ChefNavContext, type ChefNav, type View } from "./context";
import "./chef-admin.css";

const NAV: { view: View; labelKey: TextKey; icon: IconName }[] = [
  { view: { name: "customers" }, labelKey: "chef.nav.customers", icon: "building" },
  { view: { name: "rotation" }, labelKey: "chef.nav.rotation", icon: "key" },
  { view: { name: "account" }, labelKey: "chef.nav.account", icon: "shield" },
];

const section = (view: View) =>
  view.name === "account" || view.name === "rotation" ? view.name : "customers";

/**
 * Rahmen der Anbieter-Verwaltung (Design 10.1 bis 10.16): Seitenleiste mit drei Einträgen, Hinweiszeile statt
 * Tab-Leiste, Arbeitsfläche, Fusszeile. Er lädt keine Vereinsdaten: nur Kunden, Lizenzen und das eigene Konto.
 */
export function ChefAdminFrame() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const [view, setView] = useState<View>({ name: "customers" });
  const [searchRequest, setSearchRequest] = useState(0);
  const save = useRef<(() => void) | null>(null);

  const go = useCallback((next: View) => setView(next), []);
  const setSave = useCallback((handler: (() => void) | null) => {
    save.current = handler;
  }, []);
  const nav = useMemo<ChefNav>(
    () => ({ view, go, searchRequest, setSave }),
    [view, go, searchRequest, setSave],
  );

  const search = () => {
    setView({ name: "customers" });
    setSearchRequest((n) => n + 1);
  };
  useGlobalShortcuts({
    search,
    create: () => setView({ name: "new" }),
    save: () => save.current?.(),
    overview: () => undefined,
    nextTab: () => undefined,
    prevTab: () => undefined,
    closeTab: () => undefined,
    tabNumber: () => undefined,
  });

  const session = auth.session;
  const current = section(view);

  return (
    <ChefNavContext.Provider value={nav}>
      <div className="app">
        <a className="skip" href="#main">
          {t("shell.skip")}
        </a>
        <aside className="side">
          <div className="brand">
            <div className="mark" aria-hidden="true">
              A
            </div>
            <div>
              <div className="brand__name">{t("app.title")}</div>
              <div className="brand__org">{t("chef.brand.org")}</div>
            </div>
          </div>
          <nav className="nav" aria-label={t("chef.nav.label")}>
            {NAV.map((item) => {
              const on = section(item.view) === current;
              return (
                <button
                  key={item.view.name}
                  type="button"
                  className={on ? "nav__item is-active" : "nav__item"}
                  aria-current={on ? "page" : undefined}
                  onClick={() => go(item.view)}
                >
                  <Icon name={item.icon} size={18} />
                  <span>{t(item.labelKey)}</span>
                </button>
              );
            })}
          </nav>
          <div className="me">
            <b>{t("chef.me.role")}</b>
            {session && <span>{session.email}</span>}
            <div className="me__actions">
              <Button
                variant="ghost"
                small
                icon={theme === "dark" ? "sun" : "moon"}
                onClick={toggle}
              >
                {theme === "dark" ? t("shell.theme.toLight") : t("shell.theme.toDark")}
              </Button>
              <Button
                variant="ghost"
                small
                icon="logout"
                onClick={async () => {
                  await auth.signOut();
                  navigate("/anmelden");
                }}
              >
                {t("shell.logout")}
              </Button>
            </div>
          </div>
        </aside>
        <div className="main">
          <header className="ca-banner">
            <Icon name="lock" />
            <span>{t("chef.banner")}</span>
          </header>
          <main id="main" className="work" tabIndex={-1}>
            <div className="ca-page">
              {view.name === "customers" && <CustomersPage />}
              {view.name === "new" && <CustomerCreatePage />}
              {view.name === "customer" && <CustomerDetailPage key={view.id} id={view.id} />}
              {view.name === "rotation" && <RotationPage />}
              {view.name === "account" && <AccountPage />}
            </div>
          </main>
          <footer className="foot">
            <button type="button" className="foot__btn" onClick={search}>
              <Kbd>{t("shortcuts.search.keys")}</Kbd> {t("chef.footer.search")}
            </button>
            <button type="button" className="foot__btn" onClick={() => go({ name: "new" })}>
              <Kbd>{t("shortcuts.new.keys")}</Kbd> {t("chef.footer.new")}
            </button>
            <span>
              <Kbd>{t("shortcuts.save.keys")}</Kbd> {t("chef.footer.save")}
            </span>
            <span className="foot__spacer" />
            <span>{t("chef.footer.view")}</span>
          </footer>
        </div>
        {auth.expired && <SessionExpiredDialog />}
      </div>
    </ChefNavContext.Provider>
  );
}
