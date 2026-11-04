import type { ApiModule } from "./types.js";
import * as health from "./health/index.js";
import * as mail from "./mail/index.js";

/** Neue Module hier eintragen (eine Zeile pro Modul, hält Merge-Konflikte klein). */
export const modules: ApiModule[] = [health, mail];
