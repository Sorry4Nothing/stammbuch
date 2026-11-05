import { Navigate, useNavigate } from "react-router";
import { t } from "../i18n";
import { Message } from "../ui";
import { useAuth } from "./auth";
import { AuthLayout, formatClock, formatStamp } from "./AuthLayout";

/** Konto gesperrt nach zu vielen Fehlversuchen (Design 1.6). */
export function LockedPage() {
  const { lock, now, setLock } = useAuth();
  const navigate = useNavigate();
  if (!lock) return <Navigate to="/anmelden" replace />;

  return (
    <AuthLayout title={t("auth.locked.title")} focusTitle>
      <Message tone="error" title={t("auth.locked.alertTitle")}>
        {t("auth.locked.alertText", {
          email: lock.email,
          until: formatClock(lock.until),
          now: formatClock(now),
        })}
      </Message>
      <dl className="kv">
        <dt>{t("auth.locked.since")}</dt>
        <dd>{formatStamp(lock.since)}</dd>
        <dt>{t("auth.locked.until")}</dt>
        <dd>{formatStamp(lock.until)}</dd>
        <dt>{t("auth.locked.reason")}</dt>
        <dd>
          {t(lock.cause === "password" ? "auth.locked.reasonPassword" : "auth.locked.reasonCode", {
            n: lock.failedAttempts,
          })}
        </dd>
      </dl>
      <span className="muted">{t("auth.locked.help")}</span>
      <button
        type="button"
        className="link"
        onClick={() => {
          setLock(null);
          navigate("/anmelden");
        }}
      >
        {t("auth.locked.toLogin")}
      </button>
    </AuthLayout>
  );
}
