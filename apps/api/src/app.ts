import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import type { FastifyServerOptions } from "fastify";
import type { Config } from "./config.js";
import { errorHandler, notFoundHandler } from "./lib/errors.js";
import { loggerOptions } from "./logger.js";
import { modules } from "./modules/index.js";

export async function buildApp(config: Config, logger?: FastifyServerOptions["logger"]) {
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

  // CORS ist bewusst nicht aktiviert: Web und API laufen unter derselben Origin (SR-70).
  for (const mod of modules) await app.register(async (scope) => mod.register(scope, config));

  return app;
}
