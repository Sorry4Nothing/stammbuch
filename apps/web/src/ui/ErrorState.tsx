import { t } from "../i18n";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { useToast } from "./Toast";

interface ErrorStateProps {
  title: string;
  text: string;
  /** Technische Meldung, z. B. «Zeitüberschreitung (504)». */
  message?: string;
  at?: Date;
  /** Nummer für den Support. */
  errorId?: string;
  onRetry?: () => void;
}

const dateFmt = new Intl.DateTimeFormat("de-CH", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Formatiert «02.11.2026 · 14:30:12». */
export function formatDateTime(d: Date): string {
  const parts = Object.fromEntries(dateFmt.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.day}.${parts.month}.${parts.year} · ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Fehlernummer im Format ERR-JJJJMMTT-XXXX. */
export function newErrorId(now = new Date()): string {
  const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const rnd = Array.from(crypto.getRandomValues(new Uint8Array(2)), (b) =>
    b.toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase();
  return `ERR-${day}-${rnd}`;
}

/** Fehlerzustand einer Ansicht (Design 2.6): Ursache, Zeitpunkt, Fehlernummer, Erneut laden. */
export function ErrorState({ title, text, message, at, errorId, onRetry }: ErrorStateProps) {
  const toast = useToast();
  const copy = async () => {
    if (!errorId) return;
    try {
      await navigator.clipboard.writeText(errorId);
      toast.show({ tone: "ok", title: t("error.copied") });
    } catch {
      toast.show({ tone: "error", title: t("error.copyFailed"), text: errorId });
    }
  };
  return (
    <div className="empty empty--error">
      <Icon name="warning" size={32} />
      <b className="empty__title">{title}</b>
      <span className="muted empty__text">{text}</span>
      {(message || at || errorId) && (
        <dl className="kv">
          {message && (
            <>
              <dt>{t("error.detail.message")}</dt>
              <dd>{message}</dd>
            </>
          )}
          {at && (
            <>
              <dt>{t("error.detail.time")}</dt>
              <dd>{formatDateTime(at)}</dd>
            </>
          )}
          {errorId && (
            <>
              <dt>{t("error.detail.id")}</dt>
              <dd className="mono">{errorId}</dd>
            </>
          )}
        </dl>
      )}
      <div className="empty__actions">
        {onRetry && (
          <Button variant="primary" icon="refresh" onClick={onRetry}>
            {t("error.retry")}
          </Button>
        )}
        {errorId && (
          <Button icon="copy" onClick={copy}>
            {t("error.copyId")}
          </Button>
        )}
      </div>
    </div>
  );
}
