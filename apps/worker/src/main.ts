import { pino } from "pino";
import { Datenbank } from "@stammbuch/db";
import { logRedactPaths } from "@stammbuch/shared";
import { createAuthCleanupJob } from "./auth-cleanup.js";
import { postgresRetentionPort, purgeEndedEvents } from "./jobs/calendar-retention.js";
import { runLoop } from "./loop.js";
import { createMailJob } from "./mail-job.js";

const log = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  redact: { paths: [...logRedactPaths], censor: "[REDACTED]" },
});

// Fail secure (SR-54): ohne Datenbank kein Start. Zwei Rollen mit getrennten Rechten:
// stammbuch_app (wie die API) für die Auth-Wartung, stammbuch_worker nur für den Lösch-Job des Kalenders.
const databaseUrl = process.env["DATABASE_URL"];
const workerDatabaseUrl = process.env["WORKER_DATABASE_URL"];
if (!databaseUrl || !workerDatabaseUrl) {
  log.fatal("DATABASE_URL und WORKER_DATABASE_URL müssen gesetzt sein");
  process.exit(1);
}
const db = new Datenbank(databaseUrl, { max: 2 });
const workerDb = new Datenbank(workerDatabaseUrl, { max: 2 });
const calendarRetention = postgresRetentionPort(workerDb);
const authCleanup = createAuthCleanupJob({
  db,
  intervalMs: 3_600_000,
  onResult: (r) => log.info(r, "Auth-Wartung: Zeilen gelöscht"),
});

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info({ signal }, "Beende Worker");
    controller.abort();
  });
}

const mailJob = createMailJob(process.env, log, workerDb);
if (!mailJob) log.warn("Mailversand aus: MAIL_ENCRYPTION_KEYS ist nicht gesetzt");

let lastPurge = 0;
log.info("Worker gestartet");
await runLoop(controller.signal, {
  intervalMs: 10_000,
  tick: async (signal) => {
    // Der Takt gehört dem Mailjob (10 s); der Lösch-Job des Kalenders läuft höchstens einmal pro Minute.
    if (Date.now() - lastPurge >= 60_000) {
      lastPurge = Date.now();
      const deleted = await purgeEndedEvents(calendarRetention, new Date(), (eventId, err) =>
        log.error({ err, eventId }, "Event konnte nicht gelöscht werden"),
      );
      if (deleted > 0) log.info({ deleted }, "Abgelaufene Events gelöscht");
    }
    await authCleanup();
    if (mailJob) await mailJob(signal);
  },
  onError: (err) => log.error({ err }, "Fehler im Worker-Durchlauf"),
});
await Promise.all([db.close(), workerDb.close()]);
log.info("Worker beendet");
