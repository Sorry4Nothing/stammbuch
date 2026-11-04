import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { orgName } from "../config";
import { t, tp } from "../i18n";
import { Button, Message, TextField, useToast } from "../ui";
import { useAuth } from "./auth";
import { AuthLayout } from "./AuthLayout";

/** Anmeldung Schritt 1: E-Mail-Adresse und Passwort (Design 1.1, Fehler 1.4). */
export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [email, setEmail] = useState(auth.pendingEmail ?? "");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [alert, setAlert] = useState<{ title: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (!email.trim()) next.email = t("auth.login.emailRequired");
    if (!password) next.password = t("auth.login.passwordRequired");
    setErrors(next);
    const count = Object.keys(next).length;
    if (count > 0) {
      setAlert({
        title: tp("auth.fieldsInvalid", count),
        text: t("auth.login.fieldsInvalidText"),
      });
      return;
    }
    setAlert(null);
    setBusy(true);
    try {
      const result = await auth.service.signIn(email.trim(), password);
      if (result.status === "otp_required") {
        auth.setPendingEmail(email.trim());
        auth.setRecoveryCodes(result.recoveryCodes ?? null);
        navigate("/anmelden/code");
      } else if (result.status === "locked") {
        auth.setLock(result.lock);
        navigate("/anmelden/gesperrt");
      } else {
        setErrors({ password: t("auth.login.passwordWrong") });
        setAlert({
          title: t("auth.login.failedTitle"),
          text: tp("auth.login.failedText", result.remainingAttempts),
        });
        setPassword("");
      }
    } catch {
      setAlert({ title: t("auth.unavailableTitle"), text: t("auth.unavailableText") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title={t("auth.login.title")}
      subtitle={orgName ? `${orgName} · ${t("auth.login.tagline")}` : t("auth.login.tagline")}
      note={t("auth.login.membersNote")}
    >
      <form className="auth__form" onSubmit={submit} noValidate>
        {alert && (
          <Message tone="error" title={alert.title}>
            {alert.text}
          </Message>
        )}
        <TextField
          label={t("auth.login.email")}
          type="email"
          name="email"
          autoComplete="username"
          autoFocus
          value={email}
          error={errors.email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          label={t("auth.login.password")}
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          error={errors.password}
          hint={errors.password ? undefined : t("auth.login.passwordHint")}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" variant="primary" icon="arrowRight" disabled={busy}>
          {t("auth.login.submit")}
        </Button>
        {/* Das Zurücksetzen hat im Design keinen Bildschirm; bis dahin erklärt ein Hinweis. */}
        <button
          type="button"
          className="link"
          onClick={() => toast.show({ tone: "neutral", title: t("auth.login.forgotSoon") })}
        >
          {t("auth.login.forgot")}
        </button>
      </form>
    </AuthLayout>
  );
}
