import { sql } from "kysely";
import { Datenbank } from "@stammbuch/db";
import type { Services } from "./app.js";
import { loadAuthConfig } from "./modules/auth/config.js";
import { createPgAuth } from "./modules/auth/pg.js";
import { loadSystemMailer, mailerInvitationSender, systemAuthMail } from "./modules/mail/system.js";
import { createPostgresPlatform } from "./platform/postgres.js";
import type { InvitationSender } from "./platform/index.js";

type LogFn = (obj: object, msg: string) => void;

/**
 * Einladungen ohne Systemmailer (`MAIL_SYSTEM_HOST` fehlt): nur dass eine Einladung entstand, nie Empfänger oder
 * Token (SR-30, SR-50). shortcut: Das Token geht verloren, die Einladung lässt sich neu auslösen; nur für Entwicklung und Tests.
 */
export function logOnlyInvitations(log: LogFn): InvitationSender {
  return {
    send(message) {
      log(
        { expiresAt: message.expiresAt },
        "Einladung erstellt, Mailversand noch nicht angebunden",
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
  // Ohne Systemmailer geht weder die Einladung noch der Link zum Zurücksetzen hinaus (siehe docs/betriebsanleitung.md).
  const mailer = loadSystemMailer(env);
  if (!mailer) {
    log(
      {},
      "MAIL_SYSTEM_HOST nicht gesetzt: Einladungen und Passwort-Links werden nicht versendet",
    );
  }
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
      db,
      platform: createPostgresPlatform(db, {
        invitationSender: mailer
          ? mailerInvitationSender(mailer, config.appOrigin, log)
          : logOnlyInvitations(log),
      }),
      auth: {
        config,
        users: pg.users,
        sessions: pg.sessions,
        throttle: pg.throttle,
        audit: pg.audit,
        invitations: pg.invitations,
        passwordReset: pg.passwordReset,
        mail: systemAuthMail(mailer, log),
        atomic: pg.atomic,
      },
    },
    close: () => db.close(),
  };
}
