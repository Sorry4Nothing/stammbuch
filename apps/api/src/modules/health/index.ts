import type { FastifyInstance } from "fastify";
import { healthResponseSchema } from "@stammbuch/shared";

export const name = "health";

export function register(app: FastifyInstance) {
  // Öffentlich und ohne Nutzerdaten: bewusst ohne Authentifizierung (Liveness).
  app.get("/health", () => healthResponseSchema.parse({ status: "ok" }));
}
