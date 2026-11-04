import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import type { FastifyRequest, FastifyServerOptions } from "fastify";
import type { Config } from "./config.js";
import { errorHandler, notFoundHandler } from "./lib/errors.js";
import { loggerOptions } from "./logger.js";
import { createAuthenticator } from "./modules/auth/authenticate.js";
import type { Authenticated } from "./modules/auth/authenticate.js";
import { createAuthRoutes } from "./modules/auth/routes.js";
import { AuthService } from "./modules/auth/service.js";
import type { AuthDeps } from "./modules/auth/service.js";
import { modules } from "./modules/index.js";

/** Abhängigkeiten, die von aussen (Server, Tests) kommen, z. B. Repositories. */
export interface Services {
  /** Ohne Auth-Dienste registriert die API keine Auth-Routen (fail closed). */
  auth?: AuthDeps;
}

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Prüft Sitzung (Stufe full), Origin und bei schreibenden Methoden das CSRF-Token.
     * Gibt `{ tenantId, userId, rolle }` oder `null` zurück (dann mit 401 antworten).
     * Jedes Modul benutzt dies für seine Routen; ohne Auth-Dienste immer `null` (fail closed).
     */
    authenticateRequest(req: FastifyRequest): Promise<Authenticated | null>;
  }
}

export async function buildApp(
  config: Config,
  logger?: FastifyServerOptions["logger"],
  services: Services = {},
) {
  const app = Fastify({
    logger: logger ?? loggerOptions(config.LOG_LEVEL),
    trustProxy: config.TRUST_PROXY,
    // Payload-Grösse begrenzen (SR-71). Einzelne Routen dürfen gezielt mehr erlauben.
    bodyLimit: 1024 * 1024,
  });

  // Sicherheits-Header (SR-34). Die API liefert nur JSON, daher die strikteste CSP.
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });
  // Globales Limit pro Client-IP (SR-71). Sensible Routen (Login) bekommen später engere
  // Limits per `config: { rateLimit: { max, timeWindow } }` an der Route (SR-04).
  await app.register(rateLimit, { max: config.RATE_LIMIT_MAX, timeWindow: "1 minute" });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  const authService = services.auth ? new AuthService(services.auth) : null;
  // Vor den Modulen dekorieren, damit sie `app.authenticateRequest` schon beim Registrieren sehen.
  app.decorate(
    "authenticateRequest",
    authService ? createAuthenticator(authService) : () => Promise.resolve(null),
  );

  // CORS ist bewusst nicht aktiviert: Web und API laufen unter derselben Origin (SR-70).
  for (const mod of modules) await app.register(async (scope) => mod.register(scope));

  if (authService) await app.register(createAuthRoutes(authService));

  return app;
}
