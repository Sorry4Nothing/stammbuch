import { reportsModule } from "./auswertungen";
import { accountingModule } from "./buchhaltung";
import { personenModule } from "./personen";
import { rechnungenModule } from "./rechnungen";
import { startModule } from "./start";
import type { ModuleDefinition } from "./types";

/** Neue Module hier eintragen (eine Zeile pro Modul, hält Merge-Konflikte klein). */
export const modules: ModuleDefinition[] = [
  startModule,
  reportsModule,
  personenModule,
  rechnungenModule,
  accountingModule,
];
