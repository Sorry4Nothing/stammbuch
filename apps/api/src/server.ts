import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await buildApp(config);

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
