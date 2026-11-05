import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createServices } from "./services.js";

const config = loadConfig();
// Der Logger der App existiert erst nach buildApp; die Dienste loggen darüber (lazy).
let log: (obj: object, msg: string) => void = () => undefined;
// Ohne gültige Auth-Konfiguration und Datenbank startet die API nicht (fail closed).
const { services, close } = await createServices((obj, msg) => log(obj, msg)).catch(
  (err: unknown) => {
    console.error("Start fehlgeschlagen:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
const app = await buildApp(config, undefined, services);
log = (obj, msg) => app.log.info(obj, msg);
app.addHook("onClose", close);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "Beende API");
    app.close().then(
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
