import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router";
import { t, tp } from "../i18n";
import { Button, Message, OtpInput } from "../ui";
import { useAuth, type CodeResult } from "./auth";
import { AuthLayout } from "./AuthLayout";

/** Anmeldung Schritt 2: Einmalcode der Authenticator-App (Design 1.2, Fehler 1.5). */
export function CodePage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [alert, setAlert] = useState<{ title: string; text: string } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);

  // Nach der Anmeldung (Sitzung gesetzt) leert sich die Adresse; dann gilt das Ziel von navigate("/").
  if (!auth.pendingEmail && !auth.session) return <Navigate to="/anmelden" replace />;

  const handle = (result: CodeResult) => {
    if (result.status === "ok") {
      auth.setSession(result.session);
      auth.setPendingEmail(null);
      navigate("/");
    } else if (result.status === "locked") {
      auth.setLock(result.lock);
      navigate("/anmelden/gesperrt");
    } else {
      setInvalid(true);
      setAlert({
        title: t("auth.code.invalidTitle"),
        text: tp("auth.code.invalidText", result.remainingAttempts),
      });
    }
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (code.length !== 6) {
      setInvalid(true);
      setAlert({ title: t("auth.code.incompleteTitle"), text: t("auth.code.incompleteText") });
      return;
    }
    setBusy(true);
    try {
      handle(await auth.service.verifyCode(code));
    } catch {
      setAlert({ title: t("auth.unavailableTitle"), text: t("auth.unavailableText") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={t("auth.code.title")} subtitle={t("auth.code.intro")}>
      <form className="auth__form" onSubmit={submit} noValidate>
        {alert && (
          <Message tone="error" title={alert.title}>
            {alert.text}
          </Message>
        )}
        <OtpInput
          label={t("auth.code.label")}
          error={invalid ? t("auth.code.fieldError") : undefined}
          value={code}
          autoFocus
          onChange={(v) => {
            setCode(v);
            setInvalid(false);
          }}
        />
        <Button type="submit" variant="primary" icon="lock" disabled={busy}>
          {t("auth.code.submit")}
        </Button>
        <div className="auth__links">
          <button
            type="button"
            className="link"
            onClick={() => navigate("/anmelden/wiederherstellung")}
          >
            {t("auth.code.useRecovery")}
          </button>
          <button
            type="button"
            className="link"
            onClick={() => {
              auth.setPendingEmail(null);
              navigate("/anmelden");
            }}
          >
            {t("auth.code.back")}
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}
