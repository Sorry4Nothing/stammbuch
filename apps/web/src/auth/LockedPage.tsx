import { Navigate, useNavigate } from "react-router";
import { t, tp } from "../i18n";
import { Button, Message } from "../ui";
import { useAuth } from "./auth";
import { AuthLayout, formatClock, formatStamp } from "./AuthLayout";

/** Konto gesperrt nach zu vielen Fehlversuchen (Design 1.6). */
export function LockedPage() {
  const { lock, setLock } = useAuth();
  const navigate = useNavigate();
  if (!lock) return <Navigate to="/anmelden" replace />;

  return (
    <AuthLayout title={t("auth.locked.title")} focusTitle>
      <Message tone="error" title={t("auth.locked.alertTitle")}>
        {t("auth.locked.alertText", { until: formatClock(lock.until) })}
      </Message>
      <dl className="kv">
        <dt>{t("auth.locked.account")}</dt>
        <dd>{lock.email}</dd>
        {lock.since !== undefined && (
          <>
            <dt>{t("auth.locked.since")}</dt>
            <dd>{formatStamp(lock.since)}</dd>
          </>
        )}
        <dt>{t("auth.locked.reason")}</dt>
        <dd>
          {tp(
            lock.cause === "password" ? "auth.locked.reasonPassword" : "auth.locked.reasonCode",
            lock.failedAttempts,
          )}
        </dd>
      </dl>
      <span className="muted">{t("auth.locked.help")}</span>
      <div className="auth__actions">
        <Button
          icon="chevronLeft"
          onClick={() => {
            setLock(null);
            navigate("/anmelden");
          }}
        >
          {t("auth.locked.toLogin")}
        </Button>
      </div>
    </AuthLayout>
  );
}
