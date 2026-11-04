import { Datenbank } from "@stammbuch/db";
import { pino } from "pino";
import { logRedactPaths } from "@stammbuch/shared";
import { postgresRetentionPort, purgeEndedEvents } from "./jobs/calendar-retention.js";
import { runLoop } from "./loop.js";

const log = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  redact: { paths: [...logRedactPaths], censor: "[REDACTED]" },
});

// Fail secure (SR-54): ohne Datenbank kein Start. Verbindung der Rolle stammbuch_worker, nicht der API-Rolle.
const databaseUrl = process.env["WORKER_DATABASE_URL"];
if (!databaseUrl) {
  log.fatal("WORKER_DATABASE_URL fehlt");
  process.exit(1);
}
const db = new Datenbank(databaseUrl, { max: 2 });
const calendarRetention = postgresRetentionPort(db);

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info({ signal }, "Beende Worker");
    controller.abort();
  });
}

log.info("Worker gestartet");
await runLoop(controller.signal, {
  intervalMs: 60_000,
  tick: async () => {
    const deleted = await purgeEndedEvents(calendarRetention, new Date(), (eventId, err) =>
      log.error({ err, eventId }, "Event konnte nicht gelöscht werden"),
    );
    if (deleted > 0) log.info({ deleted }, "Abgelaufene Events gelöscht");
  },
  onError: (err) => log.error({ err }, "Fehler im Worker-Durchlauf"),
});
await db.close();
log.info("Worker beendet");
