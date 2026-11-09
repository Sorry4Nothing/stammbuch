import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { AuthLayout } from "../auth/AuthLayout";
import { orgName } from "../config";
import { t } from "../i18n";
import { Button, Message } from "../ui";
import { createHttpRegistrationService, type RegistrationService } from "./publicService";

const defaultService = createHttpRegistrationService();

type State = "ready" | "busy" | "done" | "invalid" | "unknown" | "tooMany" | "unavailable";

/**
 * Link aus der Bestätigungsmail, `/registrierung/:kunde/bestaetigen#<token>`. Das Token steht im Fragment (weder in
 * Zugriffsprotokollen noch im Referer) und wird nach dem Lesen aus der Adresszeile entfernt. Eingelöst wird erst
 * auf Knopfdruck: Ein Mail-Scanner, der den Link nur abruft, verbraucht das einmalige Token nicht.
 * Unbekannt, abgelaufen und schon benutzt zeigen denselben Text (SR-05).
 */
export function ConfirmPage({ service = defaultService }: { service?: RegistrationService }) {
  const { kunde = "" } = useParams();
  const { hash, pathname } = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => hash.slice(1));
  const [state, setState] = useState<State>(token === "" ? "invalid" : "ready");

  useEffect(() => {
    if (hash) navigate({ pathname, hash: "" }, { replace: true });
  }, [hash, pathname, navigate]);

  const confirm = async () => {
    setState("busy");
    try {
      const result = await service.confirm(kunde, token);
      setState(result === "confirmed" ? "done" : result);
    } catch {
      setState("unavailable");
    }
  };

  const title = t("public.confirm.title");

  if (state === "done") {
    return (
      <AuthLayout title={t("public.confirm.doneTitle")} focusTitle>
        <Message tone="ok" title={t("public.registered.thanks")}>
          {t("public.confirm.doneText")}
        </Message>
      </AuthLayout>
    );
  }

  const problem: Partial<Record<State, [string, string]>> = {
    invalid: [t("public.confirm.invalidTitle"), t("public.confirm.invalidText")],
    unknown: [t("public.register.unknownTitle"), t("public.register.unknownText")],
    tooMany: [t("public.tooManyTitle"), t("public.tooManyText")],
    unavailable: [t("public.unavailableTitle"), t("public.unavailableText")],
  };
  const [alertTitle, alertText] = problem[state] ?? [];

  return (
    <AuthLayout title={title} subtitle={orgName || undefined} focusTitle>
      {alertTitle ? (
        <Message tone="error" title={alertTitle}>
          {alertText}
        </Message>
      ) : null}
      {state === "ready" || state === "busy" || state === "tooMany" || state === "unavailable" ? (
        <div className="auth__form">
          <span className="muted">{t("public.confirm.intro")}</span>
          <div className="auth__actions">
            <Button variant="primary" icon="check" disabled={state === "busy"} onClick={confirm}>
              {t("public.confirm.submit")}
            </Button>
          </div>
        </div>
      ) : null}
    </AuthLayout>
  );
}
