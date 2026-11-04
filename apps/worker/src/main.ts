import { pino } from "pino";
import { logRedactPaths } from "@stammbuch/shared";
import { runLoop } from "./loop.js";
import { createMailJob } from "./mail-job.js";

const log = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  redact: { paths: [...logRedactPaths], censor: "[REDACTED]" },
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
    if (mailJob) await mailJob(signal);
    else log.debug("Keine Jobs konfiguriert");
  },
  onError: (err) => log.error({ err }, "Fehler im Worker-Durchlauf"),
});
log.info("Worker beendet");
