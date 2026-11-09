import { personenModule } from "./personen";
import { rechnungenModule } from "./rechnungen";
import { settingsModule } from "./organisation";
import { startModule } from "./start";
import type { ModuleDefinition } from "./types";

/** Neue Module hier eintragen (eine Zeile pro Modul, hält Merge-Konflikte klein). */
export const modules: ModuleDefinition[] = [
  startModule,
  settingsModule,
  personenModule,
  rechnungenModule,
];
