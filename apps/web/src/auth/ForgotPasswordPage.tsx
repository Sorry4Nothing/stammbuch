import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { t, tp } from "../i18n";
import { Button, Message, TextField } from "../ui";
import { useAuth } from "./auth";
import { AuthLayout } from "./AuthLayout";

/**
 * «Passwort vergessen»: Link per Mail anfordern. Die Seite zeigt nach dem Absenden immer denselben Text, egal ob es
 * zur Adresse ein Konto gibt (SR-05).
 */
export function ForgotPasswordPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState(auth.pendingEmail ?? "");
  const [error, setError] = useState<string | undefined>();
  const [alert, setAlert] = useState<{ title: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    const problem = !value
      ? t("auth.forgot.emailRequired")
      : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
        ? t("auth.forgot.emailFormat")
        : undefined;
    setError(problem);
    if (problem) {
      setAlert({ title: tp("auth.fieldsInvalid", 1), text: t("auth.forgot.fieldsInvalidText") });
      return;
    }
    setAlert(null);
    setBusy(true);
    try {
      await auth.service.requestPasswordReset(value);
      setSent(true);
    } catch {
      setAlert({ title: t("auth.unavailableTitle"), text: t("auth.unavailableText") });
    } finally {
      setBusy(false);
    }
  };

  const back = (
    <button type="button" className="link" onClick={() => navigate("/anmelden")}>
      {t("auth.forgot.back")}
    </button>
  );

  if (sent) {
    return (
      <AuthLayout title={t("auth.forgot.title")} focusTitle>
        <Message tone="ok" title={t("auth.forgot.sentTitle")}>
          {t("auth.forgot.sentText")}
        </Message>
        {back}
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t("auth.forgot.title")} subtitle={t("auth.forgot.intro")}>
      <form className="auth__form" onSubmit={submit} noValidate>
        {alert && (
          <Message tone="error" title={alert.title}>
            {alert.text}
          </Message>
        )}
        <TextField
          label={t("auth.forgot.email")}
          type="email"
          name="email"
          autoComplete="username"
          autoFocus
          value={email}
          error={error}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Button type="submit" variant="primary" icon="arrowRight" disabled={busy}>
          {t("auth.forgot.submit")}
        </Button>
        {back}
      </form>
    </AuthLayout>
  );
}
