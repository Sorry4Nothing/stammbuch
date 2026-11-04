import type { FastifyInstance } from "fastify";
import { InMemoryCalendarRepository } from "./memory.js";
import type { Authenticator, CalendarRepository, MailPort } from "./ports.js";
import { registerCalendarRoutes } from "./routes.js";
import { CalendarService } from "./service.js";

export const name = "calendar";

export interface CalendarModuleOptions {
  repo?: CalendarRepository;
  mail?: MailPort;
  authenticate?: Authenticator;
  now?: () => Date;
  publicBaseUrl?: string;
  publicRateLimitMax?: number;
}

/**
 * Standardverdrahtung, bis Auth, DB (#3) und Mail-Modul (Phase 4) existieren:
 * Anmeldung und Mailversand sind fail secure (immer abgelehnt), der Speicher flüchtig.
 * Die Wurzel der Anwendung ersetzt diese Teile über `createCalendarModule`.
 */
export function createCalendarModule(options: CalendarModuleOptions = {}) {
  const now = options.now ?? (() => new Date());
  const service = new CalendarService({
    repo: options.repo ?? new InMemoryCalendarRepository(),
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
      });
    },
  };
}

const defaultModule = createCalendarModule();
export const register = defaultModule.register;
