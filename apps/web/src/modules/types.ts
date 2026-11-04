import type { ComponentType } from "react";
import type { TextKey } from "../i18n";

/** Eine Seite des Moduls unter einer URL. */
export interface ModuleRoute {
  path: string;
  component: ComponentType;
}

/** Ein Tab-Typ für die Tab-Verwaltung ("kleiner PC"). Die Verwaltung selbst folgt später. */
export interface ModuleTabType {
  id: string;
  titleKey: TextKey;
  component: ComponentType<{ tabId: string }>;
}

/**
 * Beschreibung eines Web-Moduls. Jedes Modul liegt in `modules/<id>/index.ts`,
 * exportiert eine `ModuleDefinition` und wird in `modules/index.ts` eingetragen.
 */
export interface ModuleDefinition {
  id: string;
  titleKey: TextKey;
  nav: { path: string; labelKey: TextKey; order: number };
  routes: ModuleRoute[];
  tabTypes: ModuleTabType[];
}
