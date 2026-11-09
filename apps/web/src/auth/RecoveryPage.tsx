import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router";
import { t, tp } from "../i18n";
import { Button, Message, TextField } from "../ui";
import { useAuth } from "./auth";
import { AuthLayout } from "./AuthLayout";

/** Vier Blöcke zu je vier Zeichen, Gross-/Kleinschreibung egal. */
export function normalizeRecoveryCode(input: string): string | null {
  const clean = input.replace(/[\s-]/g, "").toUpperCase();
  return /^[A-Z0-9]{16}$/.test(clean) ? clean.replace(/(.{4})(?=.)/g, "$1-") : null;
}

/** Anmeldung mit Wiederherstellungscode (Design 1.3). */
export function RecoveryPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [alert, setAlert] = useState<{ title: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Nach der Anmeldung (Sitzung gesetzt) leert sich die Adresse; dann gilt das Ziel von navigate("/").
  if (!auth.pendingEmail && !auth.session) return <Navigate to="/anmelden" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizeRecoveryCode(code);
    if (!normalized) {
      setError(t("auth.recovery.format"));
      return;
    }
    setError(undefined);
    setAlert(null);
    setBusy(true);
    try {
      const result = await auth.service.verifyRecovery(normalized);
      if (result.status === "ok") {
        auth.setSession(result.session);
        auth.setPendingEmail(null);
        navigate("/");
      } else if (result.status === "locked") {
        auth.setLock(result.lock);
        navigate("/anmelden/gesperrt");
      } else {
        setError(t("auth.recovery.invalid"));
        setAlert({
          title: t("auth.recovery.invalidTitle"),
          text: tp("auth.code.remaining", result.remainingAttempts),
        });
      }
    } catch {
      setAlert({ title: t("auth.unavailableTitle"), text: t("auth.unavailableText") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={t("auth.recovery.title")} subtitle={t("auth.recovery.intro")}>
      <form className="auth__form" onSubmit={submit} noValidate>
        {alert && (
          <Message tone="error" title={alert.title}>
            {alert.text}
          </Message>
        )}
        <Message tone="neutral" title={t("auth.recovery.onceTitle")}>
          {t("auth.recovery.onceText")}
        </Message>
        <TextField
          mono
          label={t("auth.recovery.label")}
          hint={t("auth.recovery.hint")}
          error={error}
          autoComplete="off"
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <Button type="submit" variant="primary" icon="key" disabled={busy}>
          {t("auth.recovery.submit")}
        </Button>
        <button type="button" className="link" onClick={() => navigate("/anmelden/code")}>
          {t("auth.recovery.back")}
        </button>
      </form>
    </AuthLayout>
  );
}
