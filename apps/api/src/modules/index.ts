import type { ApiModule } from "./types.js";
import * as accounting from "./accounting/index.js";
import * as calendar from "./calendar/index.js";
import * as health from "./health/index.js";
import * as invoices from "./invoices/index.js";
import * as people from "./people/index.js";
import * as reports from "./reports/index.js";

/** Neue Module hier eintragen (eine Zeile pro Modul, hält Merge-Konflikte klein). */
export const modules: ApiModule[] = [health, accounting, calendar, invoices, people, reports];
