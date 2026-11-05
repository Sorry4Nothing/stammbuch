import type { ReactNode } from "react";
import { Link, Navigate, Route, Routes } from "react-router";
import { useAuth } from "./auth/auth";
import { CodePage } from "./auth/CodePage";
import { ForgotPasswordPage } from "./auth/ForgotPasswordPage";
import { InvitationPage } from "./auth/InvitationPage";
import { LockedPage } from "./auth/LockedPage";
import { LoginPage } from "./auth/LoginPage";
import { RecoveryPage } from "./auth/RecoveryPage";
import { ResetPasswordPage } from "./auth/ResetPasswordPage";
import { TotpSetupPage } from "./auth/TotpSetupPage";
import { t } from "./i18n";
import { modules } from "./modules";
import type { ModuleDefinition } from "./modules/types";
import { AppShell } from "./shell/AppShell";

function NotFound() {
  return (
    <main className="auth">
      <div className="card">
        <h1>{t("error.notFound")}</h1>
        <Link to="/" className="link">
          {t("error.notFound.back")}
        </Link>
      </div>
    </main>
  );
}

/** Der Rahmen nur mit Sitzung; sonst zur Anmeldung. Der Server prüft jede Anfrage selbst (SR-13). */
function RequireSession({ children }: { children: ReactNode }) {
  const { session, ready } = useAuth();
  if (!ready) return null;
  return session ? children : <Navigate to="/anmelden" replace />;
}

/**
 * Oberste Routen: Zugangsseiten und App-Rahmen. Innerhalb des Rahmens navigieren die Tabs,
 * nicht der Router. Router, Theme, Auth und Toasts liefert der Aufrufer (main.tsx bzw. Tests).
 */
export function App({ mods = modules }: { mods?: readonly ModuleDefinition[] }) {
  return (
    <Routes>
      <Route path="/anmelden" element={<LoginPage />} />
      <Route path="/anmelden/code" element={<CodePage />} />
      <Route path="/anmelden/wiederherstellung" element={<RecoveryPage />} />
      <Route path="/anmelden/gesperrt" element={<LockedPage />} />
      <Route path="/passwort-vergessen" element={<ForgotPasswordPage />} />
      <Route path="/passwort-zuruecksetzen" element={<ResetPasswordPage />} />
      <Route path="/einladung" element={<InvitationPage />} />
      <Route path="/einladung/zwei-faktor" element={<TotpSetupPage />} />
      <Route
        path="/"
        element={
          <RequireSession>
            <AppShell modules={mods} />
          </RequireSession>
        }
      />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
