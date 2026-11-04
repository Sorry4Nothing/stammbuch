import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ApiModule } from "../types.js";
import { createMemoryStore } from "./memory.js";
import { createPostgresStore, createTenantResolver } from "./postgres.js";
import { createPeopleModule } from "./routes.js";

export { createPeopleModule } from "./routes.js";
export type { PeopleDeps } from "./routes.js";
export { createMemoryStore } from "./memory.js";
export { createPostgresStore, createTenantResolver } from "./postgres.js";
export type { PeopleStore } from "./repository.js";
export type { RegistrationMailer } from "./registration.js";
export type { Ctx } from "./domain.js";

export const name = "people";

/** Verwirft Nachrichten, bis das Mail-Modul angebunden ist. */
const mailer = { send: async () => undefined };

/**
 * Standardmodul für `modules/index.ts`. Mit DATABASE_URL und FORM_SECRET läuft es auf PostgreSQL.
 * Ohne Datenbank (Tests) gilt fail secure: alle geschützten Routen antworten 401, öffentliche 404.
 * `resolveContext` ist der Port zur Anmeldung: Bis Auth (#4) ihn liefert, ist niemand angemeldet.
 */
export function register(app: FastifyInstance) {
  const { db, config } = app;
  const mod: ApiModule =
    db && config.FORM_SECRET
      ? createPeopleModule({
          store: createPostgresStore(db),
          resolveContext: async () => undefined,
          resolveTenant: createTenantResolver(db),
          mailer,
          formSecret: config.FORM_SECRET,
        })
      : createPeopleModule({
          store: createMemoryStore(),
          resolveContext: async () => undefined,
          resolveTenant: async () => undefined,
          mailer,
          formSecret: randomBytes(32),
        });
  return mod.register(app);
}
