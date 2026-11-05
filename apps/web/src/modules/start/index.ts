import type { ModuleDefinition } from "../types";
import { StartPage } from "./StartPage";

export const startModule: ModuleDefinition = {
  id: "start",
  titleKey: "module.start.title",
  nav: { labelKey: "module.start.nav", icon: "home", order: 0, tabType: "start" },
  tabTypes: [{ id: "start", titleKey: "module.start.title", component: StartPage }],
};
