import { useState } from "react";
import { useNavigate } from "react-router";
import { t, tp } from "../i18n";
import { Button, Dialog, Message, TextField } from "../ui";
import { SESSION_HOURS, useAuth } from "./auth";

/**
 * Sitzung abgelaufen (Design 2.7). Liegt über der Oberfläche; die Tabs darunter bleiben
 * gemountet, ungespeicherte Eingaben gehen nicht verloren.
 */
export function SessionExpiredDialog() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [errors, setErrors] = useState<{ password?: string; code?: string }>({});
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const next: typeof errors = {};
    if (!password) next.password = t("auth.login.passwordRequired");
    if (!/^\d{6}$/.test(code)) next.code = t("auth.expired.codeFormat");
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    setAlert(null);
    try {
      const result = await auth.service.reauthenticate(password, code);
      if (result.status === "ok") {
        auth.setSession(result.session);
        setPassword("");
        setCode("");
      } else if (result.status === "locked") {
        auth.setLock(result.lock);
        await auth.signOut();
        navigate("/anmelden/gesperrt");
      } else {
        setAlert(tp("auth.expired.invalid", result.remainingAttempts));
      }
    } catch {
      setAlert(t("auth.unavailableText"));
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await auth.signOut();
    navigate("/anmelden");
  };

  return (
    <Dialog
      title={t("auth.expired.title")}
      width={520}
      top={130}
      // Abweichung vom Board 2.7: keine Schliessen-Schaltfläche, die Oberfläche bleibt ohne Anmeldung gesperrt.
      hideClose
      onClose={() => {
        /* Kein Schliessen ohne Anmeldung: Esc bleibt wirkungslos. */
      }}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={logout}>{t("auth.expired.logout")}</Button>
          <Button type="submit" variant="primary" icon="lock" disabled={busy}>
            {t("auth.expired.submit")}
          </Button>
        </>
      }
    >
      <Message tone="warning" title={t("auth.expired.alertTitle")}>
        {t("auth.expired.alertText", { hours: SESSION_HOURS })}
      </Message>
      {alert && <Message tone="error">{alert}</Message>}
      <TextField
        label={t("auth.login.email")}
        value={auth.session?.email ?? ""}
        readOnly
        autoComplete="username"
      />
      <TextField
        label={t("auth.login.password")}
        type="password"
        autoComplete="current-password"
        data-autofocus
        value={password}
        error={errors.password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <TextField
        mono
        className="in--code"
        label={t("auth.code.label")}
        hint={t("auth.expired.codeHint")}
        inputMode="numeric"
        autoComplete="one-time-code"
        value={code}
        error={errors.code}
        // Einfügen ist möglich: Leerzeichen und Trennzeichen fallen weg.
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
      />
    </Dialog>
  );
}
