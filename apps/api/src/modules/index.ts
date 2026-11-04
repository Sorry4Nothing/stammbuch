import type { Datenbank } from "@stammbuch/db";
import type { ApiModule } from "./types.js";
import * as camt from "./camt/index.js";
import { createPgCamtModule } from "./camt/pg.js";
import * as health from "./health/index.js";
import * as reports from "./reports/index.js";

export interface ModuleDeps {
  /** Verbindung als Rolle stammbuch_app. Ohne sie bleiben datenabhängige Module gesperrt. */
  db?: Datenbank;
}

/** Neue Module hier eintragen (eine Zeile pro Modul, hält Merge-Konflikte klein). */
export function createModules(deps: ModuleDeps = {}): ApiModule[] {
  return [health, deps.db ? camtWithDb(deps.db) : camt];
}

/**
 * Bis Auth (#4) und Rechnungsmodul (#7) existieren, bleibt der Zugriff gesperrt (fail secure, SR-10):
 * `authorize` lehnt jede Anfrage ab, die Ports sind Platzhalter. Die Stellen hier ersetzen die Module.
 */
function camtWithDb(db: Datenbank): ApiModule {
  return createPgCamtModule({
    db,
    authorize: (_req, reply) => {
      void reply
        .status(401)
        .send({ error: { code: "UNAUTHENTICATED", message: "Anmeldung erforderlich." } });
      return Promise.resolve();
    },
    context: () => {
      throw new Error("Kein Sitzungskontext: Auth-Modul (#4) fehlt");
    },
    openItems: () => ({ findByReferences: () => Promise.resolve([]) }),
    assigner: () => ({ assign: () => Promise.resolve("NOT_FOUND") }),
  });
}
