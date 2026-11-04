import type { ModuleDefinition } from "../types";
import { StartPage } from "./StartPage";

export const startModule: ModuleDefinition = {
  id: "start",
  titleKey: "module.start.title",
  nav: { path: "/", labelKey: "module.start.nav", order: 0 },
  routes: [{ path: "/", component: StartPage }],
  tabTypes: [],
};
