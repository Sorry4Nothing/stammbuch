import { createMailRuntime, processDueDeliveries } from "@stammbuch/mail";
import type { ProcessorDeps } from "@stammbuch/mail";

interface JobLog {
  info(obj: object, msg: string): void;
}

/** Ein Durchlauf der Mail-Versandqueue; meldet nur, wenn etwas passiert ist (keine Empfängerdaten im Log). */
export function mailTick(deps: ProcessorDeps, log: JobLog) {
  return async (signal: AbortSignal) => {
    const r = await processDueDeliveries(deps, signal);
    if (r.sent + r.retried + r.failed + r.deferred > 0) log.info(r, "Mailversand-Durchlauf");
  };
}

/** Liefert den Mail-Durchlauf, oder `null`, wenn Mail nicht konfiguriert ist (MAIL_ENCRYPTION_KEYS fehlt). */
export function createMailJob(env: NodeJS.ProcessEnv, log: JobLog) {
  const runtime = createMailRuntime(env);
  if (!runtime) return null;
  return mailTick(
    {
      repos: runtime.repos,
      box: runtime.box,
      connections: runtime.connections,
      config: runtime.processor,
    },
    log,
  );
}
