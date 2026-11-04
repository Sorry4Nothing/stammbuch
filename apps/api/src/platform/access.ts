import type { FastifyInstance, FastifyRequest } from "fastify";
import { HttpError, forbidden, unauthenticated } from "../lib/http-error.js";
import { licenceOf } from "./licence.js";
import type { ChefPrincipal, CustomerPrincipal, Platform, Principal } from "./types.js";

/** Wer eine Route aufrufen darf. Jede Route der Module `settings` und `admin` muss eine Stufe nennen. */
export type Access = "customer" | "customer-admin" | "chef";

declare module "fastify" {
  interface FastifyInstance {
    platform: Platform;
  }
  interface FastifyRequest {
    /** `undefined`: noch nicht aufgelöst, `null`: nicht angemeldet. */
    principal: Principal | null | undefined;
  }
  interface FastifyContextConfig {
    access?: Access;
  }
}

/** Routenmuster (nicht die rohe URL, damit `..`-Tricks nichts bringen), die auch bei gesperrter oder abgelaufener Lizenz erreichbar bleiben (Abmelden, Lizenzanzeige). */
const LICENCE_EXEMPT = (path: string) => path.startsWith("/auth/") || path === "/settings/licence";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Löst die Identität genau einmal pro Anfrage auf. Ein Fehler des Resolvers wird zum 500 (SR-54). */
export async function principalOf(request: FastifyRequest): Promise<Principal | null> {
  request.principal ??= await request.server.platform.principal(request);
  return request.principal;
}

export async function customerOf(request: FastifyRequest): Promise<CustomerPrincipal> {
  const p = await principalOf(request);
  if (p?.kind !== "customer") throw forbidden();
  return p;
}

export async function chefOf(request: FastifyRequest): Promise<ChefPrincipal> {
  const p = await principalOf(request);
  if (p?.kind !== "chef") throw forbidden();
  return p;
}

function authorize(access: Access) {
  return async (request: FastifyRequest) => {
    const p = await principalOf(request);
    if (!p) throw unauthenticated();
    const allowed =
      access === "chef"
        ? p.kind === "chef"
        : p.kind === "customer" && (access === "customer" || p.role === "admin");
    if (!allowed) {
      request.log.warn({ access, kind: p.kind, url: request.url }, "Zugriff verweigert");
      throw forbidden();
    }
  };
}

/**
 * Deny by default (SR-12): im Scope registrierte Routen ohne `config.access` verhindern den Start.
 * Sonst bekommt die Route die passende Prüfung als erste preHandler-Stufe (SR-10).
 */
export function enforceAccess(app: FastifyInstance) {
  app.addHook("onRoute", (route) => {
    const access = route.config?.access;
    if (!access)
      throw new Error(`Route ${String(route.method)} ${route.url} ohne config.access (SR-12)`);
    route.preHandler = [authorize(access), ...(route.preHandler ? [route.preHandler].flat() : [])];
  });
}

/**
 * Gemeinsame Grundlage für alle Module: stellt `app.platform` bereit und erzwingt die Lizenz
 * für alle Kundenbenutzer. Abgelaufen oder Vertragsende: jede schreibende Route ist gesperrt.
 * Gesperrt: jede Anfrage. Der Chef-Admin ist ausgenommen (er arbeitet nicht in Kundendaten).
 */
export function installPlatform(app: FastifyInstance, platform: Platform) {
  app.decorate("platform", platform);
  app.decorateRequest("principal", undefined);

  app.addHook("onRequest", async (request) => {
    const p = await principalOf(request);
    if (p?.kind !== "customer") return;
    // Unbekannter Kunde: verweigern, nie durchlassen (SR-54).
    const tenant = await platform.tenants.get(p.tenantId);
    if (!tenant) throw forbidden();
    const licence = licenceOf(tenant, platform.clock());
    if (!licence.readOnly || LICENCE_EXEMPT(request.routeOptions.url ?? "")) return;
    if (licence.blocked) throw forbidden();
    if (!SAFE_METHODS.has(request.method)) {
      request.log.warn(
        { tenantId: p.tenantId, state: licence.state },
        "Schreibzugriff bei Nur-Lesen-Lizenz",
      );
      throw new HttpError(403, "LICENCE_READ_ONLY", "Die Lizenz erlaubt nur Lesezugriff.");
    }
  });
}
