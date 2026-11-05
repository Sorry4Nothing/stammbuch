import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { t, tp } from "../i18n";
import { Button, Checkbox, Message, OtpInput } from "../ui";
import { useAuth, type TotpSetup } from "./auth";
import { AuthLayout } from "./AuthLayout";

/** Schlüssel in Vierergruppen, so lässt er sich abtippen. */
const grouped = (secret: string) => secret.replace(/(.{4})(?=.)/g, "$1 ");

/**
 * Zweiten Faktor einrichten, wie beim ersten Login (nach `/einladung`): Schlüssel in die Authenticator-App
 * übernehmen, ersten Code bestätigen, danach die Wiederherstellungscodes einmalig anzeigen.
 * Ohne QR-Code: Schlüssel und `otpauth`-Link reichen, und es braucht keine zusätzliche Bibliothek.
 */
export function TotpSetupPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState("");
  const [alert, setAlert] = useState<{ title: string; text: string } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  // Jeder Aufruf erzeugt einen neuen Schlüssel; nur der zuletzt erzeugte gilt. Darum genau einmal.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    auth.service
      .beginTotpSetup()
      .then(setSetup, () =>
        setAlert({ title: t("auth.unavailableTitle"), text: t("auth.unavailableText") }),
      );
  }, [auth.service]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (code.length !== 6) {
      setInvalid(true);
      setAlert({ title: t("auth.code.incompleteTitle"), text: t("auth.setup.incompleteText") });
      return;
    }
    setBusy(true);
    try {
      const result = await auth.service.confirmTotpSetup(code);
      if (result.status === "ok") {
        auth.setSession(result.session);
        setCodes(result.recoveryCodes);
      } else if (result.status === "locked") {
        auth.setLock(result.lock);
        navigate("/anmelden/gesperrt");
      } else {
        setInvalid(true);
        setAlert({
          title: t("auth.setup.invalidTitle"),
          text: tp("auth.setup.invalidText", result.remainingAttempts),
        });
      }
    } catch {
      setAlert({ title: t("auth.unavailableTitle"), text: t("auth.unavailableText") });
    } finally {
      setBusy(false);
    }
  };

  if (codes) {
    return (
      <AuthLayout title={t("auth.setup.codesTitle")} focusTitle>
        <Message tone="warning" title={t("auth.setup.codesWarnTitle")}>
          {t("auth.setup.codesWarnText")}
        </Message>
        <ul className="auth__codes" aria-label={t("auth.setup.codesList")}>
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <Checkbox
          label={t("auth.setup.codesSaved")}
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
        />
        <Button variant="primary" icon="arrowRight" disabled={!saved} onClick={() => navigate("/")}>
          {t("auth.setup.codesContinue")}
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t("auth.setup.title")}>
      <form className="auth__form" onSubmit={submit} noValidate>
        {alert ? (
          <Message tone="error" title={alert.title}>
            {alert.text}
          </Message>
        ) : (
          <Message tone="neutral" title={t("auth.setup.infoTitle")}>
            {t("auth.setup.infoText")}
          </Message>
        )}
        {setup ? (
          <>
            <ol className="auth__steps">
              <li>{t("auth.setup.step1")}</li>
              <li>
                {t("auth.setup.step2")}
                <span className="muted">{t("auth.setup.secret")}</span>
                <code className="auth__secret">{grouped(setup.secret)}</code>
                <a className="link" href={setup.otpauthUri}>
                  {t("auth.setup.open")}
                </a>
              </li>
              <li>{t("auth.setup.step3")}</li>
            </ol>
            <OtpInput
              label={t("auth.code.label")}
              value={code}
              invalid={invalid}
              autoFocus
              onChange={(v) => {
                setCode(v);
                setInvalid(false);
              }}
            />
            <Button type="submit" variant="primary" icon="lock" disabled={busy}>
              {t("auth.setup.submit")}
            </Button>
          </>
        ) : (
          !alert && <span className="muted">{t("auth.setup.loading")}</span>
        )}
      </form>
    </AuthLayout>
  );
}
