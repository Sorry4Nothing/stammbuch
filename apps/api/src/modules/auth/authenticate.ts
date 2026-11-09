import type { FastifyRequest } from "fastify";
import { SESSION_COOKIE } from "./routes.js";
import type { AuthService } from "./service.js";
import type { Role } from "./types.js";

/** Angemeldeter Aufrufer. Alle Werte stammen aus der serverseitigen Sitzung und der Datenbank (SR-13). */
export interface Authenticated {
  /** Kunde (kunde_id) für `Datenbank.withKunde(tenantId, …)`. */
  tenantId: string;
  userId: string;
  rolle: Role;
}

/** Liest das Sitzungs-Cookie, ohne dass das Cookie-Plugin im Aufrufer-Scope registriert sein muss. */
export function sessionToken(req: FastifyRequest): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim();
  }
  return undefined;
}

/**
 * Authentifizierung für fremde Module (Kalender, Buchhaltung, CAMT, ...). Verlangt eine volle Sitzung
 * (nach dem zweiten Faktor). Bei schreibenden Methoden zusätzlich: fremde `Origin` und fehlendes oder
 * falsches `x-csrf-token` lehnen ab und werden protokolliert (SR-70). `null` heisst: mit 401 antworten.
 */
export function createAuthenticator(service: AuthService) {
  return async function authenticateRequest(req: FastifyRequest): Promise<Authenticated | null> {
    const ctx = await service.resolve(sessionToken(req), req.ip);
    if (!ctx || ctx.session.stage !== "full") return null;
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
      const origin = req.headers.origin;
      const csrf = req.headers["x-csrf-token"];
      if (
        (origin !== undefined && origin !== service.config.appOrigin) ||
        !service.verifyCsrf(ctx, typeof csrf === "string" ? csrf : undefined)
      ) {
        await service.audit("csrf_rejected", req.ip, ctx.user);
        return null;
      }
    }
    return { tenantId: ctx.user.tenantId, userId: ctx.user.id, rolle: ctx.user.role };
  };
}
