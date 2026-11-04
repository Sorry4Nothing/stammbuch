import { Datenbank } from "@stammbuch/db";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
// Fail closed (SR-54): ohne Datenbank startet die API nicht.
if (!config.DATABASE_URL) {
  console.error("DATABASE_URL fehlt.");
  process.exit(1);
}
const db = new Datenbank(config.DATABASE_URL);
const app = await buildApp(config, undefined, { db });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "Beende API");
    app
      .close()
      .then(() => db.close())
      .then(
        () => process.exit(0),
        (err: unknown) => {
          app.log.error({ err }, "Fehler beim Beenden");
          process.exit(1);
        },
      );
  });
}

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error({ err }, "Start fehlgeschlagen");
  process.exit(1);
}
