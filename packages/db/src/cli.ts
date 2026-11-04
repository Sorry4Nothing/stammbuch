import { migrate, setAppRolePassword } from "./migrate.js";

// Aufruf: pnpm --filter @stammbuch/db run migrate
// DATABASE_ADMIN_URL: Eigentümer-Verbindung. APP_DB_PASSWORD (optional): setzt das Passwort der Rolle stammbuch_app.
const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) {
  console.error("DATABASE_ADMIN_URL fehlt.");
  process.exit(1);
}

const applied = await migrate(adminUrl);
console.log(applied.length > 0 ? `Angewendet:\n${applied.join("\n")}` : "Keine neuen Migrationen.");

const appPassword = process.env.APP_DB_PASSWORD;
if (appPassword) {
  await setAppRolePassword(adminUrl, appPassword);
  console.log("Passwort der Rolle stammbuch_app gesetzt.");
}
