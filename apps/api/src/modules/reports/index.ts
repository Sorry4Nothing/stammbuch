import type { FastifyInstance } from "fastify";
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

/** Verdrahtung mit echter Buchhaltung (#8) und Auth: `createReportsModule({ ledger, periods, authenticate })`. */
export function createReportsModule(deps: ReportsDeps): ApiModule {
  return { name, register: (app: FastifyInstance) => registerReportRoutes(app, deps) };
}

// Standard-Eintrag bis #8 angebunden ist: leeres Hauptbuch. Anmeldung kommt von `app.authenticateRequest` (#4, fail closed).
const ledger = new InMemoryLedger();
const periods = new PeriodService({ ledger, store: new InMemoryPeriodStore() });
export const register = (app: FastifyInstance) =>
  createReportsModule({
    ledger,
    periods,
    authenticate: async (req) => (await app.authenticateRequest(req)) ?? undefined,
  }).register(app);
