import type { Datenbank } from "@stammbuch/db";
import {
  createMailRuntime,
  createPostgresWorkerRepositories,
  pgRotationSource,
  processDueDeliveries,
  recordRotationState,
  rotateAll,
  totpBoxFromEnv,
} from "@stammbuch/mail";
import type { MailRepositories, ProcessorDeps } from "@stammbuch/mail";
import { createRotationJob, type RotationJobLog } from "./rotation-job.js";

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

/**
 * Schlüsselrotation der Postfach-Zugangsdaten (stündlich, alle Mandanten) oder `null`, wenn Mail nicht konfiguriert ist.
 * Das Protokoll schreibt die Rolle `stammbuch_worker` über eine feste Funktion (Akteur `worker`).
 */
export function createMailRotationJob(env: NodeJS.ProcessEnv, log: RotationJobLog, db: Datenbank) {
  const runtime = createMailRuntime(env);
  if (!runtime) return null;
  const source = pgRotationSource(db, "mail", null);
  return createRotationJob({
    rotate: (signal) => rotateAll(runtime.box, source, signal),
    record: (now, unreadable) => recordRotationState(db, "mail", now, unreadable),
    audit: (now, target) => db.protokolliereSchluesselrotation(now, target, "mail.rotate-secrets"),
    log,
    label: "Schlüsselrotation Mail",
    intervalMs: 3_600_000,
  });
}

/**
 * Schlüsselrotation der TOTP-Geheimnisse (stündlich, alle Mandanten) oder `null`, wenn `AUTH_TOTP_KEY` fehlt.
 * Schlüsselring: `AUTH_TOTP_KEY` (Altdaten), optional `AUTH_TOTP_KEYS` und `AUTH_TOTP_KEY_ID`, wie in der API.
 */
export function createTotpRotationJob(env: NodeJS.ProcessEnv, log: RotationJobLog, db: Datenbank) {
  if (!env["AUTH_TOTP_KEY"]) return null;
  const box = totpBoxFromEnv(env);
  const source = pgRotationSource(db, "totp", null);
  return createRotationJob({
    rotate: (signal) => rotateAll(box, source, signal),
    record: (now, unreadable) => recordRotationState(db, "totp", now, unreadable),
    audit: (now, target) => db.protokolliereSchluesselrotation(now, target, "auth.rotate-totp"),
    log,
    label: "Schlüsselrotation TOTP",
    intervalMs: 3_600_000,
  });
}
