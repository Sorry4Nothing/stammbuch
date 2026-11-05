import type { Datenbank } from "@stammbuch/db";
import {
  createMailRuntime,
  createPostgresWorkerRepositories,
  processDueDeliveries,
} from "@stammbuch/mail";
import type { MailRepositories, ProcessorDeps } from "@stammbuch/mail";

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

/**
 * Liefert den Mail-Durchlauf, oder `null`, wenn Mail nicht konfiguriert ist (MAIL_ENCRYPTION_KEYS fehlt).
 * `db` ist die Verbindung der Rolle `stammbuch_worker`: dieselbe Queue in PostgreSQL wie in der API.
 * `repos` ersetzt sie nur in Tests.
 */
export function createMailJob(
  env: NodeJS.ProcessEnv,
  log: JobLog,
  db: Datenbank,
  repos: MailRepositories = createPostgresWorkerRepositories(db),
) {
  const runtime = createMailRuntime(env, repos);
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
