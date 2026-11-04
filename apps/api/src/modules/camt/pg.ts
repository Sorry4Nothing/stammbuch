import type { Datenbank } from "@stammbuch/db";
import type { FastifyRequest } from "fastify";
import type { ApiModule } from "../types.js";
import { createCamtModule } from "./index.js";
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
