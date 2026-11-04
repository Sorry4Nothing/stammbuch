import type { ComponentType } from "react";
import type { TextKey } from "../i18n";
import type { IconName } from "../ui";

/** Ein Tab-Typ. Die Tab-Verwaltung (`shell/tabs.tsx`) rendert `component` je geöffnetem Tab. */
export interface ModuleTabType {
  id: string;
  /** Standardtitel im Tab. Per `useCurrentTab().setTitle` überschreibbar (z. B. «M-1008 Anna Beispiel»). */
  titleKey: TextKey;
  /**
   * Inhalt des Tabs. Bleibt gemountet, solange der Tab offen ist: lokale Eingaben gehen beim
   * Wechsel zwischen Tabs nicht verloren. Ungespeicherte Eingaben meldet die Komponente mit
   * `useCurrentTab().setDirty(true)`.
   */
  component: ComponentType<{ tabId: string }>;
}

/** Eintrag der Seitenleiste. Ein Klick öffnet (oder aktiviert) einen Tab dieses Typs. */
export interface ModuleNav {
  labelKey: TextKey;
  icon: IconName;
  order: number;
  /** `main`: oberer Block, `footer`: unterhalb der Trennlinie (z. B. Einstellungen). */
  section?: "main" | "footer";
  /** Tab-Typ, der beim Klick geöffnet wird. */
  tabType: string;
}

/** Ein Treffer der globalen Suche (Strg+K). */
export interface SearchHit {
  id: string;
  title: string;
  subtitle?: string;
  /** Art des Treffers rechts, z. B. «Person». */
  kind: string;
  icon: IconName;
  /** Wird per Enter in einem neuen Tab geöffnet. */
  open: { tabType: string; params?: Record<string, string>; key?: string; title?: string };
}

/** Suchquelle eines Moduls. Die Suche findet nur Daten der eigenen Organisation (serverseitig). */
export interface SearchProvider {
  id: string;
  /** Titel der Gruppe in den Ergebnissen, z. B. «Personen». */
  groupKey: TextKey;
  search: (query: string, signal: AbortSignal) => Promise<SearchHit[]>;
}

/**
 * Beschreibung eines Web-Moduls. Jedes Modul liegt in `modules/<id>/index.ts`,
 * exportiert eine `ModuleDefinition` und wird in `modules/index.ts` eingetragen.
 */
export interface ModuleDefinition {
  id: string;
  titleKey: TextKey;
  nav: ModuleNav;
  tabTypes: ModuleTabType[];
  /** Tab-Typ für «Neu anlegen» (Strg+N im aktiven Modul). */
  newTabType?: string;
  search?: SearchProvider[];
}
