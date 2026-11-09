import { MODULE_IDS, type ModuleDefinition } from "../types";
import { TasksPage } from "./TasksPage";

export const tasksModule: ModuleDefinition = {
  // Kennung `tasks` (MODULE_IDS.tasks): die Startseite schaltet «Alle Aufgaben anzeigen» darüber frei.
  id: MODULE_IDS.tasks,
  titleKey: "module.tasks.title",
  nav: { labelKey: "module.tasks.nav", icon: "check", order: 5, tabType: "tasks" },
  tabTypes: [{ id: "tasks", titleKey: "module.tasks.title", component: TasksPage }],
};
