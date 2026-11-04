import { sql } from "kysely";
import { Datenbank } from "@stammbuch/db";
import type { Services } from "./app.js";
import { loadAuthConfig } from "./modules/auth/config.js";
import { createPgAuth } from "./modules/auth/pg.js";
import type { MailPort } from "./modules/auth/types.js";

type LogFn = (obj: object, msg: string) => void;

/**
 * Sicherheitsmeldungen, bis das Mail-Modul (SMTP) existiert: nur Art und Zeit ins Log, nie Empfänger
 * oder Inhalte (SR-50). shortcut: Meldungen erreichen die Nutzer nicht, ersetzen sobald das Mail-Modul steht.
 */
export function logOnlyMail(log: LogFn): MailPort {
  return {
    sendSecurityNotice(notice) {
      log(
        { kind: notice.kind, at: notice.at },
        "Sicherheitsmeldung, Mailversand noch nicht angebunden",
      );
      return Promise.resolve();
    },
  };
}

/**
 * Baut die Dienste der API aus der Umgebung. Fail closed (SR-54): fehlende oder schwache Auth-Secrets,
 * fehlende `DATABASE_URL`, nicht erreichbare Datenbank oder eine Verbindung mit Sonderrechten
 * (Superuser oder BYPASSRLS würden die Mandantentrennung aushebeln) brechen den Start ab.
 */
export async function createServices(
  log: LogFn,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ services: Services; close: () => Promise<void> }> {
  const config = loadAuthConfig(env);
  const url = env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL fehlt (Verbindung als Rolle stammbuch_app).");

  const db = new Datenbank(url);
  try {
    const { rows } = await sql<{ privilegiert: boolean }>`
      SELECT (rolsuper OR rolbypassrls) AS privilegiert FROM pg_roles WHERE rolname = current_user`.execute(
      db.kysely,
    );
    if (rows[0]?.privilegiert !== false) {
      throw new Error("DATABASE_URL: die Rolle darf weder Superuser noch BYPASSRLS haben.");
    }
  } catch (err) {
    await db.close();
    throw err;
  }

  const pg = createPgAuth(db);
  return {
    services: {
      auth: {
        config,
        users: pg.users,
        sessions: pg.sessions,
        throttle: pg.throttle,
        audit: pg.audit,
        mail: logOnlyMail(log),
        atomic: pg.atomic,
      },
    },
    close: () => db.close(),
  };
}
