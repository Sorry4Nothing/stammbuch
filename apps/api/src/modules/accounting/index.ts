import type { FastifyInstance } from "fastify";
import { registerAccountingRoutes } from "./routes.js";
import { AccountingService } from "./service.js";
import { createPostgresStore } from "./postgres-store.js";

export const name = "accounting";

export { AccountingService } from "./service.js";
export { createMemoryStore } from "./repository.js";
export { createPostgresStore } from "./postgres-store.js";
export type { AccountingStore, AccountingTx } from "./repository.js";
export type { Authenticate } from "./routes.js";
export { registerAccountingRoutes } from "./routes.js";

/**
 * Standard-Verdrahtung: PostgreSQL-Speicher und eine Authentifizierung, die alles ablehnt
 * (fail secure, SR-54). Die Auth-Schicht (Issue #4) ersetzt `authenticate`; bis dahin ist der
 * Zugriff geschlossen. Der In-Memory-Speicher bleibt nur für Tests.
 */
export function register(app: FastifyInstance) {
  return registerAccountingRoutes(app, {
    service: new AccountingService(createPostgresStore(app.db)),
    authenticate: async () => null,
  });
}
