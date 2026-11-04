import { randomBytes } from "node:crypto";
import { createMemoryStore } from "./memory.js";
import { createPeopleModule } from "./routes.js";

export { createPeopleModule } from "./routes.js";
export type { PeopleDeps } from "./routes.js";
export { createMemoryStore } from "./memory.js";
export type { PeopleStore } from "./repository.js";
export type { RegistrationMailer } from "./registration.js";
export type { Ctx } from "./domain.js";

/**
 * Standardmodul für `modules/index.ts`: In-Memory-Speicher, kein Mandant auflösbar. Alle
 * geschützten Routen antworten 401, öffentliche 404, bis Auth (resolveContext) und Datenbank
 * angebunden sind (fail secure). Der Mailer verwirft Nachrichten.
 */
const defaults = createPeopleModule({
  store: createMemoryStore(),
  resolveContext: async () => undefined,
  resolveTenant: async () => undefined,
  mailer: { send: async () => undefined },
  formSecret: randomBytes(32),
});
export const name = defaults.name;
export const register = defaults.register;
