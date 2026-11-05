import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  auditEntryResponseSchema,
  auditQuerySchema,
  chefAccountResponseSchema,
  chefAccountUpdateSchema,
  customerCreateSchema,
  customerListQuerySchema,
  customerResponseSchema,
  customerUpdateSchema,
  idParamSchema,
  resendInvitationSchema,
} from "@stammbuch/shared";
import { conflict, notFound } from "../../lib/http-error.js";
import { respond, validate } from "../../lib/validate.js";
import {
  SlugTakenError,
  chefOf,
  createTenant,
  enforceAccess,
  invite,
  record,
} from "../../platform/index.js";
import type { Invitation, Tenant } from "../../platform/index.js";

export const name = "admin";

/**
 * Chef-Admin (Anbieter): Kunden anlegen, sperren, beenden. Er sieht nur Vertragsdaten.
 *
 * Kundendaten sind technisch ausgeschlossen: Dieses Modul benutzt von `app.platform` nur
 * `tenants`, `invitations`, `invitationSender`, `chefs`, `platformAudit` und `clock`. Es greift nie
 * auf `users`, `organisations`, `logos` oder `audit` (Kundenprotokoll) zu und importiert nichts aus
 * dem Kunden-Modul. Ein Test prüft das am Quelltext (admin.test.ts), dazu sind alle Routen nur für den
 * Chef-Admin freigegeben und Kundenbenutzer bekommen 403.
 */
export function register(app: FastifyInstance) {
  enforceAccess(app);

  const { tenants, invitations, invitationSender, chefs, platformAudit, clock } = app.platform;
  const inviteDeps = { invitations, invitationSender, clock };
  const audit = (actor: Parameters<typeof record>[3], action: string, target: string) =>
    record(platformAudit, clock, "platform", actor, action, target);
  const massLimit = { rateLimit: { max: 20, timeWindow: "1 minute" } } as const;

  const invitationState = (inv: Invitation | undefined) => {
    if (!inv) return null;
    const status = inv.consumedAt
      ? "accepted"
      : new Date(inv.expiresAt) <= clock()
        ? "expired"
        : "pending";
    return { email: inv.email, status };
  };
  const toDto = async (t: Tenant) =>
    respond(customerResponseSchema, {
      id: t.id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      licenceValidUntil: t.licenceValidUntil,
      createdAt: t.createdAt,
      endedAt: t.endedAt,
      invitation: invitationState(await invitations.latestForTenant(t.id)),
    });
  /** Doppelter Slug ist ein Konflikt (409), alles andere bleibt ein Serverfehler. */
  const slugConflict = <T>(run: () => Promise<T>) =>
    run().catch((err: unknown) => {
      throw err instanceof SlugTakenError ? conflict("Dieser Slug ist schon vergeben.") : err;
    });
  const load = async (params: unknown) => {
    const tenant = await tenants.get(validate(idParamSchema, params).id);
    if (!tenant) throw notFound();
    return tenant;
  };

  // --- Kunden ---------------------------------------------------------------------------

  app.get("/admin/customers", { config: { access: "chef" } }, async (request) => {
    const chef = await chefOf(request);
    const { status, q, limit, offset } = validate(customerListQuerySchema, request.query);
    const page = await tenants.list(chef.accountId, { status, q }, { limit, offset });
    return { items: await Promise.all(page.items.map(toDto)), total: page.total };
  });

  app.post(
    "/admin/customers",
    { config: { access: "chef", ...massLimit } },
    async (request, reply) => {
      const chef = await chefOf(request);
      const input = validate(customerCreateSchema, request.body);
      const tenant = await slugConflict(() =>
        createTenant(
          tenants,
          chef.accountId,
          {
            id: randomUUID(),
            name: input.name,
            status: "active",
            licenceValidUntil: input.licenceValidUntil,
            createdAt: clock().toISOString(),
            endedAt: null,
          },
          input.slug,
        ),
      );
      // Die erste Person wird Admin des Kunden. Das Token geht nur an den Versand, nie zurück an den Chef-Admin.
      await invite(inviteDeps, tenant, {
        email: input.contactEmail,
        role: "admin",
        userId: null,
        name: input.contactName,
      });
      await audit(chef, "customer.create", tenant.name);
      return reply.status(201).send(await toDto(tenant));
    },
  );

  app.get("/admin/customers/:id", { config: { access: "chef" } }, async (request) => {
    await chefOf(request);
    return toDto(await load(request.params));
  });

  app.patch("/admin/customers/:id", { config: { access: "chef" } }, async (request) => {
    const chef = await chefOf(request);
    const tenant = await load(request.params);
    const patch = validate(customerUpdateSchema, request.body);
    const updated = await slugConflict(() => tenants.update(chef.accountId, tenant.id, patch));
    if (!updated) throw notFound();
    await audit(chef, "customer.update", tenant.name);
    return toDto(updated);
  });

  /** Statuswechsel mit erlaubten Ausgangszuständen. Alles andere ist ein 409. */
  const transitions = {
    suspend: { from: ["active"], patch: { status: "suspended" } },
    reactivate: { from: ["suspended"], patch: { status: "active" } },
    "end-contract": { from: ["active", "suspended"], patch: { status: "ended" } },
  } as const;
  for (const [action, rule] of Object.entries(transitions)) {
    app.post(
      `/admin/customers/:id/${action}`,
      { config: { access: "chef", ...massLimit } },
      async (request) => {
        const chef = await chefOf(request);
        const tenant = await load(request.params);
        if (!(rule.from as readonly string[]).includes(tenant.status)) throw conflict();
        const patch =
          action === "end-contract"
            ? { ...rule.patch, endedAt: clock().toISOString() }
            : rule.patch;
        const updated = await tenants.update(chef.accountId, tenant.id, patch);
        if (!updated) throw notFound();
        await audit(chef, `customer.${action}`, tenant.name);
        return toDto(updated);
      },
    );
  }

  app.post(
    "/admin/customers/:id/invitation",
    { config: { access: "chef", ...massLimit } },
    async (request, reply) => {
      const chef = await chefOf(request);
      const tenant = await load(request.params);
      const { contactEmail, contactName } = validate(resendInvitationSchema, request.body);
      if (tenant.status !== "active") throw conflict();
      await invite(inviteDeps, tenant, {
        email: contactEmail,
        role: "admin",
        userId: null,
        name: contactName,
      });
      await audit(chef, "customer.invite", tenant.name);
      return reply.status(204).send();
    },
  );

  // --- Protokoll und eigenes Konto ------------------------------------------------------

  app.get("/admin/audit", { config: { access: "chef" } }, async (request) => {
    await chefOf(request);
    const { limit, offset, ...filter } = validate(auditQuerySchema, request.query);
    const page = await platformAudit.query("platform", filter, { limit, offset });
    return {
      items: page.items.map((e) => respond(auditEntryResponseSchema, e)),
      total: page.total,
    };
  });

  app.get("/admin/account", { config: { access: "chef" } }, async (request) => {
    const chef = await chefOf(request);
    const account = await chefs.get(chef.accountId);
    if (!account) throw notFound();
    return respond(chefAccountResponseSchema, account);
  });

  app.patch("/admin/account", { config: { access: "chef" } }, async (request) => {
    const chef = await chefOf(request);
    const patch = validate(chefAccountUpdateSchema, request.body);
    const account = await chefs.update(chef.accountId, patch);
    if (!account) throw notFound();
    await audit(chef, "account.update", "");
    return respond(chefAccountResponseSchema, account);
  });
}
