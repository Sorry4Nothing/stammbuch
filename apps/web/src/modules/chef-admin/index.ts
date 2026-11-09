import type { ModuleDefinition } from "../types";
import { MODULE_IDS } from "../types";
import { ChefAdminFrame } from "./ChefAdminFrame";

/**
 * Anbieter-Verwaltung des Chef-Admins (Design Gruppe 10): Kunden, Lizenzen, eigenes Konto.
 * Nur für die Rolle Chef-Admin; sie sieht keine Kundendaten und bekommt einen eigenen Rahmen statt der Tab-Shell.
 */
export const chefAdminModule: ModuleDefinition = {
  id: MODULE_IDS.chefAdmin,
  audience: "chef",
  frame: ChefAdminFrame,
  titleKey: "module.chefAdmin.title",
  nav: { labelKey: "module.chefAdmin.nav", icon: "building", order: 0, tabType: "chef-customers" },
  tabTypes: [],
};

export { ChefAdminServiceContext, type ChefAdminService } from "./model";
