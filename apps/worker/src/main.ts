import { pino } from "pino";
import { logRedactPaths } from "@stammbuch/shared";
import { runLoop } from "./loop.js";

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

log.info("Worker gestartet");
await runLoop(controller.signal, {
  intervalMs: 10_000,
  tick: async () => {
    log.debug("Platzhalter-Durchlauf, keine Jobs registriert");
  },
  onError: (err) => log.error({ err }, "Fehler im Worker-Durchlauf"),
});
log.info("Worker beendet");
