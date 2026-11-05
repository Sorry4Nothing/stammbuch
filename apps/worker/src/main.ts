import { pino } from "pino";
import { Datenbank } from "@stammbuch/db";
import { logRedactPaths } from "@stammbuch/shared";
import { createAuthCleanupJob } from "./auth-cleanup.js";
import { runLoop } from "./loop.js";
import { createMailJob } from "./mail-job.js";

const log = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  redact: { paths: [...logRedactPaths], censor: "[REDACTED]" },
});

// Verbindung als Rolle stammbuch_app (wie die API). Ohne sie startet der Worker nicht (fail closed).
const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  log.fatal("DATABASE_URL fehlt");
  process.exit(1);
}
const db = new Datenbank(databaseUrl, { max: 2 });
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

const mailJob = createMailJob(process.env, log);
if (!mailJob) log.warn("Mailversand aus: MAIL_ENCRYPTION_KEYS ist nicht gesetzt");

log.info("Worker gestartet");
await runLoop(controller.signal, {
  intervalMs: 10_000,
  tick: async (signal) => {
    await authCleanup();
    if (mailJob) await mailJob(signal);
  },
  onError: (err) => log.error({ err }, "Fehler im Worker-Durchlauf"),
});
await db.close();
log.info("Worker beendet");
