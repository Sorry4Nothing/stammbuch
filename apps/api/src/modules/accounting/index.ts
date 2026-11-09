import type { FastifyInstance } from "fastify";
import { customerAudit } from "../../platform/index.js";
import { registerAccountingRoutes } from "./routes.js";
import { AccountingService } from "./service.js";
import { createPostgresStore } from "./postgres-store.js";
import { createMemoryStore } from "./repository.js";

export const name = "accounting";

export { AccountingService } from "./service.js";
export { createMemoryStore } from "./repository.js";
export { createPostgresStore } from "./postgres-store.js";
export type { AccountingStore, AccountingTx } from "./repository.js";
export type { Authenticate } from "./routes.js";
export { registerAccountingRoutes } from "./routes.js";

/**
 * Standard-Verdrahtung: PostgreSQL-Speicher auf `app.db`, Anmeldung über `app.authenticateRequest` (#4, fail closed).
 * Der Chef-Admin sieht keine Kundendaten (Projektplan Abschnitt 8) und hat hier keinen Zugriff.
 * Ohne Datenbank (nur Entwicklung und Tests; in Produktion verlangt die Konfiguration sie) der In-Memory-Speicher.
 */
export function register(app: FastifyInstance) {
  return registerAccountingRoutes(app, {
    service: new AccountingService(app.db ? createPostgresStore(app.db) : createMemoryStore()),
    authenticate: async (request) => {
      const auth = await app.authenticateRequest(request);
      return auth?.rolle === "user" ? { tenantId: auth.tenantId, userId: auth.userId } : null;
    },
    audit: (who, action, target) => customerAudit(app.platform)(who, action, target),
  });
}
