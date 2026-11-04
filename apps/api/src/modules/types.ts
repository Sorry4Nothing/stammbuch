import type { FastifyInstance } from "fastify";

/**
 * Vertrag eines API-Moduls. Jedes Modul liegt in `modules/<name>/index.ts`,
 * exportiert `name` und `register` und wird in `modules/index.ts` eingetragen.
 * Jede Route eines Moduls braucht Authentifizierung und Berechtigung (SR-10, SR-12),
 * ausser sie ist ausdrücklich öffentlich (wie /health).
 */
export interface ApiModule {
  name: string;
  register(app: FastifyInstance): void | Promise<void>;
}
