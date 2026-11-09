import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "../../auth/auth";
import de from "../../i18n/de.json";
import { t, type TextKey } from "../../i18n";
import { Badge, Button, Icon, Message, type IconName, type Tone } from "../../ui";
import { displayStatus, type DisplayStatus } from "./format";
import type { Customer } from "./model";

const STATUS: Record<DisplayStatus, { tone: Tone; icon: IconName; key: TextKey }> = {
  active: { tone: "ok", icon: "check", key: "chef.status.active" },
  expired: { tone: "error", icon: "clock", key: "chef.status.expired" },
  suspended: { tone: "error", icon: "ban", key: "chef.status.suspended" },
  ended: { tone: "neutral", icon: "clock", key: "chef.status.ended" },
};

/** Status als Text mit Symbol, nie nur über Farbe. */
export function StatusBadge({ customer }: { customer: Pick<Customer, "status" | "licenceUntil"> }) {
  const { now } = useAuth();
  const s = STATUS[displayStatus(customer, now)];
  return (
    <Badge tone={s.tone}>
      <Icon name={s.icon} size={12} />
      {t(s.key)}
    </Badge>
  );
}

/** Pflichtfeld: Stern hinter der Beschriftung (für Screenreader verborgen), `aria-required` am Feld sagt es ihnen. */
export const req = (label: string): ReactNode => (
  <>
    {label} <span aria-hidden="true">*</span>
  </>
);

/** Wert oder «–», wenn die API ihn nicht liefert. */
export const orDash = (value: ReactNode | null | undefined) =>
  value === null || value === undefined || value === "" ? t("chef.dash") : value;

export interface Loaded<T> {
  data: T | undefined;
  failed: boolean;
  reload: () => void;
}

/** Lädt Daten beim Einblenden und bei jedem `reload`. Eine ältere Anfrage überschreibt nie eine neuere. */
export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]): Loaded<T> {
  const [data, setData] = useState<T | undefined>();
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);

  // `load` ändert sich nur mit `deps`
  const run = useCallback(load, deps);
  useEffect(() => {
    const abort = new AbortController();
    setFailed(false);
    run(abort.signal).then(
      (value) => !abort.signal.aborted && setData(value),
      () => !abort.signal.aborted && setFailed(true),
    );
    return () => abort.abort();
  }, [run, tick]);

  return { data, failed, reload: () => setTick((n) => n + 1) };
}

/** Ladefehler mit Wiederholen. */
export function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="ca-state">
      <Message tone="error">{t("chef.loadFailed")}</Message>
      <Button icon="refresh" onClick={onRetry}>
        {t("error.retry")}
      </Button>
    </div>
  );
}

/** Beschriftung einer Protokoll-Aktion; unbekannte Codes erscheinen unverändert. */
export function auditLabel(action: string): string {
  const key = `chef.audit.${action}`;
  return key in de ? t(key as TextKey) : action;
}
