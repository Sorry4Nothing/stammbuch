import type { Datenbank } from "@stammbuch/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ApiModule } from "../types.js";
import { createOpenItemLookup } from "../invoices/open-items.js";
import { createCamtModule, name, register as registerUnwired } from "./index.js";
import type { Authorize } from "./index.js";
import { PgCamtRepository } from "./repository.pg.js";
import type { CamtContext } from "./repository.pg.js";
import { CamtRestService } from "./rest.js";
import type { ManualAssignPort } from "./rest.js";
import { CamtImportService } from "./service.js";
import type { OpenItemLookup } from "./service.js";

export interface PgCamtDeps {
  db: Datenbank;
  authorize: Authorize;
  /** Mandant und Benutzer der bereits autorisierten Anfrage (aus der Sitzung, #4). */
  context: (request: FastifyRequest) => CamtContext;
  /** Offene Posten des Kunden (Rechnungsmodul, #7). */
  openItems: (ctx: CamtContext) => OpenItemLookup;
  assigner: (ctx: CamtContext) => ManualAssignPort;
}

/** CAMT-Modul mit PostgreSQL-Persistenz: pro Anfrage ein Repository für genau einen Kunden. */
export function createPgCamtModule(deps: PgCamtDeps): ApiModule {
  return createCamtModule({
    authorize: deps.authorize,
    scope: (request) => {
      const ctx = deps.context(request);
      const repo = new PgCamtRepository(deps.db, ctx);
      return {
        service: new CamtImportService(repo, deps.openItems(ctx)),
        rest: new CamtRestService(repo, deps.assigner(ctx)),
      };
    },
  });
}

export { name };

/**
 * Verdrahtung in der App: `app.db`, Anmeldung über `app.authenticateRequest` (#4; nur Rolle user, der Chef-Admin
 * sieht keine Kundendaten), offene Posten aus dem Rechnungsmodul (#7). Ohne Datenbank bleibt der Zugriff gesperrt.
 * Offen: `assigner` (manuelle Zuordnung) verbucht noch keine Zahlung, sie liefert NOT_FOUND, bis das Rechnungsmodul
 * einen Port dafür anbietet (Teil-/Überzahlung ist dort zu entscheiden).
 */
export function register(app: FastifyInstance) {
  const { db } = app;
  if (!db) return registerUnwired(app);
  const sessions = new WeakMap<FastifyRequest, CamtContext>();
  return createPgCamtModule({
    db,
    authorize: async (request, reply) => {
      const auth = await app.authenticateRequest(request);
      if (auth?.rolle !== "user") {
        void reply
          .status(401)
          .send({ error: { code: "UNAUTHENTICATED", message: "Nicht angemeldet." } });
        return;
      }
      sessions.set(request, { kundeId: auth.tenantId, benutzerId: auth.userId });
    },
    context: (request) => {
      const ctx = sessions.get(request);
      if (!ctx) throw new Error("Anmeldung fehlt trotz authorize"); // fail closed
      return ctx;
    },
    openItems: (ctx) => createOpenItemLookup(db, ctx.kundeId),
    assigner: () => ({ assign: () => Promise.resolve("NOT_FOUND") }),
  }).register(app);
}
