import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { t, tp } from "../i18n";
import { Button, Message, TextField } from "../ui";
import { useAuth } from "./auth";
import { AuthLayout } from "./AuthLayout";

/** Gleiche Untergrenze wie der Server (SR-06); er bleibt verbindlich. */
const MIN_LENGTH = 12;

/**
 * Einladungslink `/einladung#<token>`: Passwort festlegen. Das Token steht im Fragment, damit es weder in
 * Zugriffsprotokollen noch im Referer landet; die Seite entfernt es nach dem Lesen aus der Adresszeile.
 * Ungültig, abgelaufen und schon benutzt zeigen denselben Text (SR-05).
 */
export function InvitationPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { hash, pathname } = useLocation();
  const [token] = useState(() => hash.slice(1));
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [errors, setErrors] = useState<{ password?: string; repeat?: string }>({});
  const [alert, setAlert] = useState<{ title: string; text: string } | null>(null);
  const [invalid, setInvalid] = useState(token === "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (hash) navigate({ pathname, hash: "" }, { replace: true });
  }, [hash, pathname, navigate]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (!password) next.password = t("auth.invitation.passwordRequired");
    else if ([...password].length < MIN_LENGTH) next.password = t("auth.invitation.tooShort");
    if (!next.password && repeat !== password) next.repeat = t("auth.invitation.mismatch");
    setErrors(next);
    const count = Object.keys(next).length;
    if (count > 0) {
      setAlert({
        title: tp("auth.fieldsInvalid", count),
        text: t("auth.invitation.fieldsInvalidText"),
      });
      return;
    }
    setAlert(null);
    setBusy(true);
    try {
      const result = await auth.service.redeemInvitation(token, password);
      if (result.status === "ok") {
        navigate("/einladung/zwei-faktor", { replace: true });
      } else if (result.status === "invalid") {
        setInvalid(true);
      } else {
        setErrors({ password: result.message });
        setAlert({ title: tp("auth.fieldsInvalid", 1), text: result.message });
        setPassword("");
        setRepeat("");
      }
    } catch {
      setAlert({ title: t("auth.unavailableTitle"), text: t("auth.unavailableText") });
    } finally {
      setBusy(false);
    }
  };

  if (invalid) {
    return (
      <AuthLayout title={t("auth.invitation.title")} focusTitle>
        <Message tone="error" title={t("auth.invitation.invalidTitle")}>
          {t("auth.invitation.invalidText")}
        </Message>
        <button type="button" className="link" onClick={() => navigate("/anmelden")}>
          {t("auth.invitation.toLogin")}
        </button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t("auth.invitation.title")} subtitle={t("auth.invitation.intro")}>
      <form className="auth__form" onSubmit={submit} noValidate>
        {alert && (
          <Message tone="error" title={alert.title}>
            {alert.text}
          </Message>
        )}
        <TextField
          label={t("auth.invitation.password")}
          type="password"
          name="password"
          autoComplete="new-password"
          autoFocus
          value={password}
          error={errors.password}
          hint={errors.password ? undefined : t("auth.invitation.passwordHint")}
          onChange={(e) => setPassword(e.target.value)}
        />
        <TextField
          label={t("auth.invitation.repeat")}
          type="password"
          name="password-repeat"
          autoComplete="new-password"
          value={repeat}
          error={errors.repeat}
          onChange={(e) => setRepeat(e.target.value)}
        />
        <Button type="submit" variant="primary" icon="arrowRight" disabled={busy}>
          {t("auth.invitation.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}
