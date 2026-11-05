import type { FastifyInstance } from "fastify";
import { createPostgresLedger } from "../accounting/ledger-read.js";
import type { ApiModule } from "../types.js";
import { InMemoryLedger } from "./ledger-port.js";
import { InMemoryPeriodStore, PeriodService } from "./periods.js";
import { registerReportRoutes } from "./routes.js";
import type { ReportsDeps } from "./routes.js";

export * from "./ledger-port.js";
export { createPeriodGuard, InMemoryPeriodStore, PeriodError, PeriodService } from "./periods.js";
export type { Period, PeriodGuard, PeriodState, PeriodStore } from "./periods.js";
export type { ReportsAuth, ReportsDeps } from "./routes.js";

export const name = "reports";

/** Verdrahtung mit Hauptbuch und Auth: `createReportsModule({ ledger, periods, authenticate })`. */
export function createReportsModule(deps: ReportsDeps): ApiModule {
  return { name, register: (app: FastifyInstance) => registerReportRoutes(app, deps) };
}

// Standard-Eintrag: Hauptbuch aus den Buchhaltungs-Tabellen (#42), ohne Datenbank (nur Entwicklung und Tests) das leere
// In-Memory-Hauptbuch. Anmeldung kommt von `app.authenticateRequest` (#4, fail closed).
// shortcut: Perioden liegen noch im Speicher und gehen beim Neustart verloren; Tabelle dafür ist ein eigenes Issue.
const periodStore = new InMemoryPeriodStore();
export const register = (app: FastifyInstance) => {
  const ledger = app.db ? createPostgresLedger(app.db) : new InMemoryLedger();
  return createReportsModule({
    ledger,
    periods: new PeriodService({ ledger, store: periodStore }),
    // Wie die Buchhaltung: der Chef-Admin sieht keine Kundendaten (Projektplan Abschnitt 8).
    authenticate: async (req) => {
      const auth = await app.authenticateRequest(req);
      return auth?.rolle === "user" ? { tenantId: auth.tenantId, userId: auth.userId } : undefined;
    },
  }).register(app);
};
