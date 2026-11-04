import type { FastifyInstance } from "fastify";
import { registerAccountingRoutes } from "./routes.js";
import { AccountingService } from "./service.js";
import { createMemoryStore } from "./repository.js";

export const name = "accounting";

export { AccountingService } from "./service.js";
export { createMemoryStore } from "./repository.js";
export type { AccountingStore, AccountingTx } from "./repository.js";
export type { Authenticate } from "./routes.js";
export { registerAccountingRoutes } from "./routes.js";

/**
 * Standard-Verdrahtung: In-Memory-Speicher und eine Authentifizierung, die alles ablehnt
 * (fail secure, SR-54). Die Auth-Schicht und der DB-Speicher ersetzen beides, sobald sie
 * existieren; bis dahin ist der Zugriff geschlossen.
 */
export function register(app: FastifyInstance) {
  return registerAccountingRoutes(app, {
    service: new AccountingService(createMemoryStore()),
    authenticate: async () => null,
  });
}
