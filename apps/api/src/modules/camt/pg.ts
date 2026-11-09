import type { Database, Datenbank } from "@stammbuch/db";
import type { Transaction } from "kysely";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ApiModule } from "../types.js";
import { customerAudit, type CustomerAudit } from "../../platform/index.js";
import { createOpenItemLookup } from "../invoices/open-items.js";
import { recordBankPayment } from "../invoices/payment-port.js";
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
  /** Bucht Zahlungen auf Rechnungen: manuell (Restposten) und automatisch (Import), je auf der offenen Transaktion. */
  assigner: (ctx: CamtContext) => ManualAssignPort;
  /** Kundenprotokoll (SR-52): Import und Zuordnung von Zahlungen. */
  audit?: CustomerAudit;
}

/** Zahlungs-Port auf das Rechnungsmodul: bucht auf der Transaktion des CAMT-Repositories (`tx`). */
export const invoicePaymentPort = (ctx: CamtContext): ManualAssignPort => ({
  assign: (openItemId, payment, tx, options) =>
    recordBankPayment(
      tx as Transaction<Database>,
      { tenantId: ctx.kundeId, userId: ctx.benutzerId },
      openItemId,
      payment,
      options,
    ),
});

/** CAMT-Modul mit PostgreSQL-Persistenz: pro Anfrage ein Repository für genau einen Kunden. */
export function createPgCamtModule(deps: PgCamtDeps): ApiModule {
  const { audit } = deps;
  return createCamtModule({
    authorize: deps.authorize,
    ...(audit
      ? {
          audit: (request, action, target) => {
            const ctx = deps.context(request);
            return audit({ tenantId: ctx.kundeId, userId: ctx.benutzerId }, action, target);
          },
        }
      : {}),
    scope: (request) => {
      const ctx = deps.context(request);
      const repo = new PgCamtRepository(deps.db, ctx);
      return {
        service: new CamtImportService(repo, deps.openItems(ctx), deps.assigner(ctx)),
        rest: new CamtRestService(repo, deps.assigner(ctx)),
      };
    },
  });
}

export { name };

/**
 * Verdrahtung in der App: `app.db`, Anmeldung über `app.authenticateRequest` (#4; nur Rolle user, der Chef-Admin
 * sieht keine Kundendaten), offene Posten aus dem Rechnungsmodul (#7). Ohne Datenbank bleibt der Zugriff gesperrt.
 * Zahlungen werden über `recordBankPayment` (Rechnungsmodul, Buchung in der Buchhaltung) auf der Transaktion des
 * CAMT-Repositories gebucht: Zuordnung, Rechnung und Buchhaltung gelten zusammen oder gar nicht.
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
    assigner: invoicePaymentPort,
    audit: customerAudit(app.platform),
  }).register(app);
}
