import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { t, tp } from "../i18n";
import { Button, Message, TextField } from "../ui";
import { useAuth } from "./auth";
import { AuthLayout } from "./AuthLayout";

/** Gleiche Untergrenze wie der Server (SR-06); er bleibt verbindlich. */
const MIN_LENGTH = 12;

/**
 * Link `/passwort-zuruecksetzen#<token>`: neues Passwort, dazu der zweite Faktor (Einmalcode oder
 * Wiederherstellungscode). Das Token steht im Fragment, damit es weder in Zugriffsprotokollen noch im Referer
 * landet; die Seite entfernt es nach dem Lesen aus der Adresszeile. Link und Code sind für den Server nicht zu
 * unterscheiden, deshalb gibt es nur eine Fehlermeldung (SR-05).
 */
export function ResetPasswordPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { hash, pathname } = useLocation();
  const [token] = useState(() => hash.slice(1));
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [code, setCode] = useState("");
  const [errors, setErrors] = useState<{ password?: string; repeat?: string }>({});
  const [alert, setAlert] = useState<{ title: string; text: string } | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (hash) navigate({ pathname, hash: "" }, { replace: true });
  }, [hash, pathname, navigate]);

  const toLogin = (
    <button type="button" className="link" onClick={() => navigate("/anmelden")}>
      {t("auth.reset.toLogin")}
    </button>
  );
  const newLink = (
    <button type="button" className="link" onClick={() => navigate("/passwort-vergessen")}>
      {t("auth.reset.newLink")}
    </button>
  );

  if (token === "") {
    return (
      <AuthLayout title={t("auth.reset.title")} focusTitle>
        <Message tone="error" title={t("auth.reset.noLinkTitle")}>
          {t("auth.reset.noLinkText")}
        </Message>
        {newLink}
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout title={t("auth.reset.title")} focusTitle>
        <Message tone="ok" title={t("auth.reset.doneTitle")}>
          {t("auth.reset.doneText")}
        </Message>
        {toLogin}
      </AuthLayout>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (!password) next.password = t("auth.reset.passwordRequired");
    else if ([...password].length < MIN_LENGTH) next.password = t("auth.reset.tooShort");
    if (!next.password && repeat !== password) next.repeat = t("auth.reset.mismatch");
    setErrors(next);
    const count = Object.keys(next).length;
    if (count > 0) {
      setAlert({
        title: tp("auth.fieldsInvalid", count),
        text: t("auth.reset.fieldsInvalidText"),
      });
      return;
    }
    setAlert(null);
    setBusy(true);
    try {
      const result = await auth.service.resetPassword(token, password, code.trim());
      if (result.status === "ok") {
        setDone(true);
      } else if (result.status === "weak") {
        setErrors({ password: result.message });
        setAlert({ title: tp("auth.fieldsInvalid", 1), text: result.message });
        setPassword("");
        setRepeat("");
      } else {
        setAlert({
          title: t("auth.reset.invalidTitle"),
          text:
            result.status === "locked" ? t("auth.reset.lockedText") : t("auth.reset.invalidText"),
        });
        setCode("");
      }
    } catch {
      setAlert({ title: t("auth.unavailableTitle"), text: t("auth.unavailableText") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={t("auth.reset.title")} subtitle={t("auth.reset.intro")}>
      <form className="auth__form" onSubmit={submit} noValidate>
        {alert && (
          <Message tone="error" title={alert.title}>
            {alert.text}
          </Message>
        )}
        <div className="auth__fields">
          <TextField
            label={t("auth.reset.password")}
            type="password"
            name="password"
            autoComplete="new-password"
            autoFocus
            value={password}
            error={errors.password}
            hint={errors.password ? undefined : t("auth.reset.passwordHint")}
            onChange={(e) => setPassword(e.target.value)}
          />
          <TextField
            label={t("auth.reset.repeat")}
            type="password"
            name="password-repeat"
            autoComplete="new-password"
            value={repeat}
            error={errors.repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
          <TextField
            mono
            label={t("auth.reset.code")}
            name="code"
            autoComplete="one-time-code"
            value={code}
            hint={t("auth.reset.codeHint")}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        <Button type="submit" variant="primary" icon="arrowRight" disabled={busy}>
          {t("auth.reset.submit")}
        </Button>
        {newLink}
      </form>
    </AuthLayout>
  );
}
