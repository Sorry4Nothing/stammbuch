import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import type { FastifyRequest, FastifyServerOptions } from "fastify";
import { Datenbank } from "@stammbuch/db";
import type { Config } from "./config.js";
import { errorHandler, notFoundHandler } from "./lib/errors.js";
import { loggerOptions } from "./logger.js";
import { createAuthenticator, sessionToken } from "./modules/auth/authenticate.js";
import type { Authenticated } from "./modules/auth/authenticate.js";
import { createAuthRoutes } from "./modules/auth/routes.js";
import { AuthService } from "./modules/auth/service.js";
import type { AuthDeps } from "./modules/auth/service.js";
import { modules } from "./modules/index.js";
import type { RegistrationMailer } from "./modules/people/registration.js";
import { createPlatform, installPlatform } from "./platform/index.js";
import type { Platform } from "./platform/index.js";

/** Abhängigkeiten, die von aussen (Server, Tests) kommen, z. B. Repositories. */
export interface Services {
  /** Ohne Auth-Dienste registriert die API keine Auth-Routen (fail closed). */
  auth?: AuthDeps;
  /** Gemeinsame Verbindung (Server). Fehlt sie, öffnet `buildApp` bei gesetzter DATABASE_URL eine eigene. */
  db?: Datenbank;
  /** Persistenz, Identität und Lizenzprüfung für Einstellungen und Chef-Admin (#13). Standard: flüchtig, niemand angemeldet. */
  platform?: Platform;
  /** Mails der öffentlichen Registrierung. Standard: verwirft sie (Tests, Entwicklung ohne Systemmailer). */
  registrationMailer?: RegistrationMailer;
  /** Ersetzt den Step-up der Auth-Dienste (nur Tests des Chef-Admins ohne Auth-Modul). */
  stepUp?: StepUpVerifier;
}

/** Prüft den frischen Einmalcode der Sitzung dieser Anfrage; "locked" trägt die Wartezeit in Sekunden. */
export type StepUpVerifier = (
  req: FastifyRequest,
  code: string,
) => Promise<"ok" | "invalid" | { kind: "locked"; retryAfterSeconds: number }>;

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    /** Fehlt nur ohne DATABASE_URL (Tests): Module mit Datenbank antworten dann mit 401/404. */
    db: Datenbank | undefined;
    /**
     * Prüft Sitzung (Stufe full), Origin und bei schreibenden Methoden das CSRF-Token.
     * Gibt `{ tenantId, userId, rolle }` oder `null` zurück (dann mit 401 antworten).
     * Jedes Modul benutzt dies für seine Routen; ohne Auth-Dienste immer `null` (fail closed).
     */
    authenticateRequest(req: FastifyRequest): Promise<Authenticated | null>;
    registrationMailer: RegistrationMailer;
    /** Step-up für heikle Chef-Admin-Aktionen (frischer Einmalcode). Ohne Auth-Dienste immer "invalid" (fail closed). */
    verifyStepUp: StepUpVerifier;
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

  // Einzige Datenbankverbindung der API (Rolle stammbuch_app). Der Pool verbindet erst bei der ersten Abfrage.
  const db = services.db ?? (config.DATABASE_URL ? new Datenbank(config.DATABASE_URL) : undefined);
  app.decorate("config", config);
  app.decorate("db", db);
  // Eine von aussen übergebene Verbindung schliesst deren Besitzer (Server).
  if (db && !services.db) app.addHook("onClose", async () => db.close());

  app.decorate(
    "registrationMailer",
    services.registrationMailer ?? { send: async () => undefined },
  );

  const authService = services.auth ? new AuthService(services.auth) : null;
  // Vor den Modulen dekorieren, damit sie `app.authenticateRequest` schon beim Registrieren sehen.
  app.decorate(
    "authenticateRequest",
    authService ? createAuthenticator(authService) : () => Promise.resolve(null),
  );

  app.decorate(
    "verifyStepUp",
    services.stepUp ??
      (authService
        ? (req: FastifyRequest, code: string) =>
            authService.stepUpForSession(sessionToken(req), code, req.ip)
        : () => Promise.resolve("invalid" as const)),
  );

  // Persistenz, Identität und Lizenzprüfung für Einstellungen und Chef-Admin (vor der Modul-Registrierung).
  installPlatform(app, services.platform ?? createPlatform());

  // CORS ist bewusst nicht aktiviert: Web und API laufen unter derselben Origin (SR-70).
  for (const mod of modules) await app.register(async (scope) => mod.register(scope));

  if (authService) await app.register(createAuthRoutes(authService));

  return app;
}
