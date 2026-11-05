import { Link, Route, Routes } from "react-router";
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
      <Route path="/" element={<AppShell modules={mods} />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
