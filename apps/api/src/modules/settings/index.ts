import type { FastifyInstance } from "fastify";
import { licenceResponseSchema } from "@stammbuch/shared";
import { notFound } from "../../lib/http-error.js";
import { respond } from "../../lib/validate.js";
import { customerOf, enforceAccess, licenceOf } from "../../platform/index.js";
import { AccountingService } from "../accounting/service.js";
import { createPostgresStore } from "../accounting/postgres-store.js";
import { createMemoryStore } from "../accounting/repository.js";
import { memorySettingsFor } from "../invoices/org-sync.js";
import { createPgRepositories } from "../invoices/pg-repository.js";
import { registerAudit } from "./audit.js";
import { registerOrganisation } from "./organisation.js";
import { registerUsers } from "./users.js";

export const name = "settings";

/**
 * Einstellungen eines Kunden: Organisation, Logo, Benutzer, Protokoll, Lizenzanzeige.
 * Alle Routen gelten nur für Kundenbenutzer und nur für den eigenen Kunden. Die Kunden-ID
 * kommt immer aus der Session, nie aus dem Request (SR-13).
 */
export function register(app: FastifyInstance) {
  enforceAccess(app);
  // Der Kontenplan gehört der Buchhaltung; hier wird er nur gelesen (Konto «Gutschriften auf»).
  const accounting = new AccountingService(
    app.db ? createPostgresStore(app.db) : createMemoryStore(),
  );
  registerOrganisation(
    app,
    async (tenantId, userId) =>
      (await accounting.listAccounts({ tenantId, userId }))
        .filter((a) => a.active && a.type === "asset")
        .map((a) => a.code),
    // Rechnungseinstellungen werden aus Adresse und Bankverbindung der Organisation abgeleitet.
    app.db ? createPgRepositories(app.db).settings : memorySettingsFor(app.platform),
  );
  registerUsers(app);
  registerAudit(app);

  app.get("/settings/licence", { config: { access: "customer" } }, async (request) => {
    const { tenantId } = await customerOf(request);
    const tenant = await app.platform.tenants.get(tenantId);
    if (!tenant) throw notFound();
    return respond(licenceResponseSchema, licenceOf(tenant, app.platform.clock()));
  });
}
