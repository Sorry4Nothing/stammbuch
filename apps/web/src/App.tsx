import { NavLink, Route, Routes } from "react-router";
import { t } from "./i18n";
import { modules } from "./modules";

const navEntries = [...modules].sort((a, b) => a.nav.order - b.nav.order);

/** Rahmen der Anwendung. Den Router liefert der Aufrufer (main.tsx bzw. Tests). */
export function App() {
  return (
    <>
      <header>
        <strong>{t("app.title")}</strong>
        <nav aria-label={t("app.nav.label")}>
          {navEntries.map((m) => (
            <NavLink key={m.id} to={m.nav.path}>
              {t(m.nav.labelKey)}
            </NavLink>
          ))}
        </nav>
      </header>
      <main>
        <Routes>
          {modules.flatMap((m) =>
            m.routes.map((r) => (
              <Route key={`${m.id}:${r.path}`} path={r.path} element={<r.component />} />
            )),
          )}
          <Route path="*" element={<p>{t("error.notFound")}</p>} />
        </Routes>
      </main>
    </>
  );
}
