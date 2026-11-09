import { useEffect, useRef } from "react";
import type { TextKey } from "../i18n";

/** Eine Zeile in der Kürzel-Übersicht (Design 2.4). */
export interface ShortcutRow {
  labelKey: TextKey;
  keys: TextKey;
}

export interface ShortcutGroup {
  titleKey: TextKey;
  rows: ShortcutRow[];
}

/** Spalten der Übersicht: links Allgemein und Tabs, rechts Listen und Dialoge. */
export const shortcutColumns: ShortcutGroup[][] = [
  [
    {
      titleKey: "shortcuts.general",
      rows: [
        { labelKey: "shortcuts.search", keys: "shortcuts.search.keys" },
        { labelKey: "shortcuts.new", keys: "shortcuts.new.keys" },
        { labelKey: "shortcuts.save", keys: "shortcuts.save.keys" },
        { labelKey: "shortcuts.overview", keys: "shortcuts.overview.keys" },
      ],
    },
    {
      titleKey: "shortcuts.tabs",
      rows: [
        { labelKey: "shortcuts.tabNext", keys: "shortcuts.tabNext.keys" },
        { labelKey: "shortcuts.tabPrev", keys: "shortcuts.tabPrev.keys" },
        { labelKey: "shortcuts.tabClose", keys: "shortcuts.tabClose.keys" },
      ],
    },
  ],
  [
    {
      titleKey: "shortcuts.lists",
      rows: [
        { labelKey: "shortcuts.rowMove", keys: "shortcuts.rowMove.keys" },
        { labelKey: "shortcuts.rowOpen", keys: "shortcuts.rowOpen.keys" },
        { labelKey: "shortcuts.rowSelect", keys: "shortcuts.rowSelect.keys" },
        { labelKey: "shortcuts.rowAll", keys: "shortcuts.rowAll.keys" },
      ],
    },
    {
      titleKey: "shortcuts.dialogs",
      rows: [
        { labelKey: "shortcuts.confirm", keys: "shortcuts.confirm.keys" },
        { labelKey: "shortcuts.cancel", keys: "shortcuts.cancel.keys" },
        { labelKey: "shortcuts.fieldNext", keys: "shortcuts.fieldNext.keys" },
      ],
    },
  ],
];

export interface ShortcutHandlers {
  search: () => void;
  create: () => void;
  save: () => void;
  overview: () => void;
  nextTab: () => void;
  prevTab: () => void;
  closeTab: () => void;
  tabNumber: (n: number) => void;
}

/**
 * Globale Tastaturkürzel. Gelten nicht, solange ein Dialog offen ist (der Dialog regelt Tab/Esc/Enter selbst).
 * Browser reservieren Strg+N, Strg+T, Strg+W und Strg+Tab; die Seite bekommt diese Ereignisse nie. Darum
 * nutzen «Neu», «Tab schliessen» und der Tabwechsel Alt-Kombinationen (Alt+N, Alt+W, Alt+Bild auf/ab,
 * Alt+1..9). Strg+K, Strg+S und Strg+/ lassen sich abfangen.
 */
export function useGlobalShortcuts(handlers: ShortcutHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (document.querySelector(".dialog-layer")) return;
      const mod = e.ctrlKey || e.metaKey;
      const h = ref.current;
      const key = e.key.toLowerCase();

      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };

      // Alt-Kombinationen: `e.code` statt `e.key`, weil Alt+Buchstabe auf dem Mac Sonderzeichen erzeugt.
      const alt = e.altKey && !mod;

      if (mod && !e.altKey && key === "k") run(h.search);
      else if (mod && !e.altKey && key === "s") run(h.save);
      else if (mod && !e.altKey && key === "/") run(h.overview);
      else if (alt && !e.shiftKey && e.code === "KeyN") run(h.create);
      else if (alt && !e.shiftKey && e.code === "KeyW") run(h.closeTab);
      else if (alt && e.key === "PageDown") run(h.nextTab);
      else if (alt && e.key === "PageUp") run(h.prevTab);
      else if (alt && /^[1-9]$/.test(e.key)) run(() => h.tabNumber(Number(e.key)));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
