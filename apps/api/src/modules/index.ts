import type { ApiModule } from "./types.js";
import * as accounting from "./accounting/index.js";
import * as health from "./health/index.js";
import * as reports from "./reports/index.js";

/** Neue Module hier eintragen (eine Zeile pro Modul, hält Merge-Konflikte klein). */
export const modules: ApiModule[] = [health, accounting, reports];
