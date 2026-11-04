import type { Datenbank } from "@stammbuch/db";
import type { FastifyInstance } from "fastify";

/** Gemeinsame Abhängigkeiten, die die Wurzel den Modulen gibt. */
export interface ModuleContext {
  db: Datenbank;
}

/**
 * Vertrag eines API-Moduls. Jedes Modul liegt in `modules/<name>/index.ts`,
 * exportiert `name` und `register` und wird in `modules/index.ts` eingetragen.
 * Jede Route eines Moduls braucht Authentifizierung und Berechtigung (SR-10, SR-12),
 * ausser sie ist ausdrücklich öffentlich (wie /health).
 */
export interface ApiModule {
  name: string;
  register(app: FastifyInstance, ctx: ModuleContext): void | Promise<void>;
}
