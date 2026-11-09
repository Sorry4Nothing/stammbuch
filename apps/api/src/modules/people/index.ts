import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { customerAudit, systemAudit as systemAuditOf } from "../../platform/index.js";
import type { ApiModule } from "../types.js";
import type { Ctx } from "./domain.js";
import { createPostgresPersonFinance } from "./finance.js";
import { createMemoryStore } from "./memory.js";
import { createPostgresStore, createTenantResolver } from "./postgres.js";
import { createPeopleModule } from "./routes.js";

export { createPeopleModule } from "./routes.js";
export type { PeopleDeps } from "./routes.js";
export { createMemoryStore } from "./memory.js";
export { createPostgresStore, createTenantResolver } from "./postgres.js";
export type { PeopleStore } from "./repository.js";
export type { PersonFinance } from "./finance.js";
export type { RegistrationMailer } from "./registration.js";
export type { Ctx } from "./domain.js";

export const name = "people";

/**
 * Standardmodul für `modules/index.ts`. Mit DATABASE_URL und FORM_SECRET läuft es auf PostgreSQL.
 * Ohne Datenbank (Tests) gilt fail secure: alle geschützten Routen antworten 401, öffentliche 404.
 * Anmeldung über `app.authenticateRequest` (#4); ohne Auth-Dienste ist niemand angemeldet (fail closed).
 */
export function register(app: FastifyInstance) {
  const { db, config, registrationMailer: mailer } = app;
  const resolveContext = async (req: FastifyRequest) => {
    const auth = await app.authenticateRequest(req);
    return auth?.rolle === "user" ? { kundeId: auth.tenantId, benutzerId: auth.userId } : undefined;
  };
  const audit = (ctx: Ctx, action: string, target?: string) =>
    customerAudit(app.platform)({ tenantId: ctx.kundeId, userId: ctx.benutzerId }, action, target);
  const systemAudit = (kundeId: string, action: string, target?: string) =>
    systemAuditOf(app.platform)(kundeId, action, target);
  const mod: ApiModule =
    db && config.FORM_SECRET
      ? createPeopleModule({
          store: createPostgresStore(db),
          finance: createPostgresPersonFinance(db),
          audit,
          systemAudit,
          resolveContext,
          resolveTenant: createTenantResolver(db),
          mailer,
          formSecret: config.FORM_SECRET,
        })
      : createPeopleModule({
          store: createMemoryStore(),
          audit,
          systemAudit,
          resolveContext,
          resolveTenant: async () => undefined,
          mailer,
          formSecret: randomBytes(32),
        });
  return mod.register(app);
}
