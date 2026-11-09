import type { FastifyInstance } from "fastify";
import { customerAudit, type CustomerAudit } from "../../platform/index.js";
import { createMailService, mailContextFor } from "../mail/index.js";
import { InMemoryCalendarRepository, InMemoryLookup } from "./memory.js";
import { mailServicePort } from "./mail-port.js";
import { PostgresCalendarRepository, PostgresLookup } from "./postgres.js";
import type { Authenticator, CalendarRepository, Lookup, MailPort } from "./ports.js";
import { registerCalendarRoutes } from "./routes.js";
import { CalendarService } from "./service.js";

export const name = "calendar";

export interface CalendarModuleOptions {
  repo?: CalendarRepository;
  lookup?: Lookup;
  mail?: MailPort;
  authenticate?: Authenticator;
  now?: () => Date;
  publicBaseUrl?: string;
  publicRateLimitMax?: number;
  /** Kundenprotokoll (SR-52): Event angelegt, geändert, Einladungen versendet; nur Event-ID. */
  audit?: CustomerAudit;
}

/**
 * Standardverdrahtung: Anmeldung und Mailversand sind fail secure (immer abgelehnt), solange nichts anderes
 * übergeben wird. Ohne `repo` (Tests) ist der Speicher flüchtig; die Anwendung (`register`) nutzt PostgreSQL
 * und das Mail-Modul. Die Wurzel ersetzt Teile über `createCalendarModule`.
 */
export function createCalendarModule(options: CalendarModuleOptions = {}) {
  const now = options.now ?? (() => new Date());
  const service = new CalendarService({
    repo: options.repo ?? new InMemoryCalendarRepository(),
    lookup: options.lookup ?? new InMemoryLookup(),
    mail: options.mail ?? {
      send: () => Promise.reject(new Error("Mail-Modul nicht angebunden")),
    },
    now,
    publicBaseUrl: (options.publicBaseUrl ?? process.env["PUBLIC_BASE_URL"] ?? "").replace(
      /\/$/,
      "",
    ),
  });
  return {
    name,
    register(app: FastifyInstance) {
      registerCalendarRoutes(app, {
        service,
        authenticate: options.authenticate ?? (() => Promise.resolve(null)),
        now,
        publicRateLimitMax: options.publicRateLimitMax ?? 10,
        ...(options.audit ? { audit: options.audit } : {}),
      });
    },
  };
}

/**
 * Anmeldung über `app.authenticateRequest` (#4, nur Rolle user: der Chef-Admin sieht keine Kundendaten),
 * Speicher auf `app.db`; ohne Datenbank (nur Entwicklung und Tests) flüchtig. Einladungen gehen über das
 * Mail-Modul (#10): in die Queue des Mailkontos der einladenden Person, der Worker versendet. Ohne
 * Schlüssel (`MAIL_ENCRYPTION_KEYS`) oder ohne Mailkonto schlägt der Versand fehl und die Einladung wird zurückgenommen.
 */
export const register = (app: FastifyInstance) => {
  const db = app.db;
  const mail = createMailService(db);
  return createCalendarModule({
    ...(db ? { repo: new PostgresCalendarRepository(db), lookup: new PostgresLookup(db) } : {}),
    ...(mail
      ? {
          mail: mailServicePort(mail, async (who) =>
            db ? mailContextFor(db, who.tenantId, who.userId) : null,
          ),
        }
      : {}),
    authenticate: async (request) => {
      const auth = await app.authenticateRequest(request);
      return auth?.rolle === "user" ? { userId: auth.userId, tenantId: auth.tenantId } : null;
    },
    audit: (who, action, target) => customerAudit(app.platform)(who, action, target),
  }).register(app);
};
