import type { FastifyInstance } from "fastify";
import { createPostgresLedger } from "../accounting/ledger-read.js";
import type { ApiModule } from "../types.js";
import { InMemoryPeriodFacts } from "./facts.js";
import { createPostgresPeriodFacts } from "./facts-postgres.js";
import { InMemoryLedger } from "./ledger-port.js";
import { InMemoryPeriodStore, PeriodService } from "./periods.js";
import { createPostgresPeriodStore } from "./periods-postgres.js";
import { registerReportRoutes } from "./routes.js";
import type { ReportsDeps } from "./routes.js";

export * from "./facts.js";
export * from "./ledger-port.js";
export { createPeriodGuard, InMemoryPeriodStore, PeriodError, PeriodService } from "./periods.js";
export type { Period, PeriodGuard, PeriodState, PeriodStore } from "./periods.js";
export type { ReportsAuth, ReportsDeps } from "./routes.js";

export const name = "reports";

/** Verdrahtung mit Hauptbuch und Auth: `createReportsModule({ ledger, periods, authenticate })`. */
export function createReportsModule(deps: ReportsDeps): ApiModule {
  return { name, register: (app: FastifyInstance) => registerReportRoutes(app, deps) };
}

// Standard-Eintrag: Hauptbuch aus den Buchhaltungs-Tabellen (#42) und Perioden in `auswertung_periode` (#111), ohne
// Datenbank (nur Entwicklung und Tests) das leere In-Memory-Hauptbuch und Perioden im Speicher. Anmeldung kommt von
// `app.authenticateRequest` (#4, fail closed).
const memoryPeriodStore = new InMemoryPeriodStore();
export const register = (app: FastifyInstance) => {
  const ledger = app.db ? createPostgresLedger(app.db) : new InMemoryLedger();
  const facts = app.db ? createPostgresPeriodFacts(app.db) : new InMemoryPeriodFacts(ledger);
  const store = app.db ? createPostgresPeriodStore(app.db) : memoryPeriodStore;
  return createReportsModule({
    ledger,
    facts,
    periods: new PeriodService({ ledger, facts, store }),
    // Wie die Buchhaltung: der Chef-Admin sieht keine Kundendaten (Projektplan Abschnitt 8).
    authenticate: async (req) => {
      const auth = await app.authenticateRequest(req);
      return auth?.rolle === "user" ? { tenantId: auth.tenantId, userId: auth.userId } : undefined;
    },
  }).register(app);
};
