import { MODULE_IDS, type ModuleDefinition } from "../types";
import { SettingsPage } from "./SettingsPage";

/** Einstellungen: Organisation, Mailkonto, Benutzer und Sicherheit, Protokoll, Lizenz (Gruppe 9). */
export const settingsModule: ModuleDefinition = {
  id: MODULE_IDS.settings,
  titleKey: "module.settings.title",
  nav: {
    labelKey: "module.settings.nav",
    icon: "gear",
    order: 100,
    section: "footer",
    tabType: "settings",
  },
  tabTypes: [{ id: "settings", titleKey: "module.settings.title", component: SettingsPage }],
};
