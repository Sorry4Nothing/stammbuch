import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  idParamSchema,
  userCreateSchema,
  userResponseSchema,
  userRoleSchema,
} from "@stammbuch/shared";
import { conflict, notFound } from "../../lib/http-error.js";
import { respond, validate } from "../../lib/validate.js";
import { customerOf, invite, record } from "../../platform/index.js";
import type { TenantUser } from "../../platform/index.js";

/** Explizite Auswahl der Felder (SR-74). */
const toDto = (u: TenantUser) =>
  respond(userResponseSchema, {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt ?? null,
    totpEnrolled: u.totpEnrolled ?? false,
  });

const massLimit = { rateLimit: { max: 20, timeWindow: "1 minute" } } as const;

export function registerUsers(app: FastifyInstance) {
  app.get("/settings/users", { config: { access: "customer-admin" } }, async (request) => {
    const { tenantId } = await customerOf(request);
    return { items: (await app.platform.users.list(tenantId)).map(toDto) };
  });

  app.post(
    "/settings/users",
    { config: { access: "customer-admin", ...massLimit } },
    async (request, reply) => {
      const principal = await customerOf(request);
      const { platform } = app;
      const input = validate(userCreateSchema, request.body);
      const tenant = await platform.tenants.get(principal.tenantId);
      if (!tenant) throw notFound();
      // Gleiche Antwort für «gibt es schon» in diesem und in anderen Kunden (keine Kontoprüfung von aussen).
      if (await platform.users.emailExists(input.email))
        throw conflict("Benutzer kann nicht hinzugefügt werden.");

      const user: TenantUser = {
        id: randomUUID(),
        tenantId: principal.tenantId,
        ...input,
        status: "invited",
        createdAt: platform.clock().toISOString(),
      };
      await platform.users.add(user);
      await invite(platform, tenant, { email: user.email, role: user.role, userId: user.id });
      await record(
        platform.audit,
        platform.clock,
        principal.tenantId,
        principal,
        "user.add",
        user.email,
      );
      return reply.status(201).send(toDto(user));
    },
  );

  app.patch("/settings/users/:id", { config: { access: "customer-admin" } }, async (request) => {
    const principal = await customerOf(request);
    const { platform } = app;
    const { id } = validate(idParamSchema, request.params);
    const { role } = validate(userRoleSchema, request.body);
    // Objektprüfung: nur Benutzer des eigenen Kunden (SR-11), sonst 404.
    const user = await platform.users.get(principal.tenantId, id);
    if (!user) throw notFound();
    if (
      user.role === "admin" &&
      user.status === "active" &&
      role !== "admin" &&
      (await platform.users.countAdmins(principal.tenantId)) <= 1
    ) {
      throw conflict("Der letzte Admin kann nicht herabgestuft werden.");
    }
    const updated = await platform.users.setRole(principal.tenantId, id, role);
    if (!updated) throw notFound();
    await record(
      platform.audit,
      platform.clock,
      principal.tenantId,
      principal,
      "user.role",
      `${user.email}:${role}`,
    );
    return toDto(updated);
  });

  app.delete(
    "/settings/users/:id",
    { config: { access: "customer-admin" } },
    async (request, reply) => {
      const principal = await customerOf(request);
      const { platform } = app;
      const { id } = validate(idParamSchema, request.params);
      const user = await platform.users.get(principal.tenantId, id);
      if (!user) throw notFound();
      if (user.id === principal.userId) throw conflict("Du kannst Dich nicht selbst entfernen.");
      if (
        user.role === "admin" &&
        user.status === "active" &&
        (await platform.users.countAdmins(principal.tenantId)) <= 1
      ) {
        throw conflict("Der letzte Admin kann nicht entfernt werden.");
      }
      await platform.users.remove(principal.tenantId, id);
      await record(
        platform.audit,
        platform.clock,
        principal.tenantId,
        principal,
        "user.remove",
        user.email,
      );
      return reply.status(204).send();
    },
  );
}
