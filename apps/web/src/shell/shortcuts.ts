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
        { labelKey: "shortcuts.tabNumber", keys: "shortcuts.tabNumber.keys" },
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
        { labelKey: "shortcuts.pageNext", keys: "shortcuts.pageNext.keys" },
      ],
    },
    {
      titleKey: "shortcuts.dialogs",
      rows: [
        { labelKey: "shortcuts.confirm", keys: "shortcuts.confirm.keys" },
        { labelKey: "shortcuts.cancel", keys: "shortcuts.cancel.keys" },
        { labelKey: "shortcuts.fieldNext", keys: "shortcuts.fieldNext.keys" },
        { labelKey: "shortcuts.fieldPrev", keys: "shortcuts.fieldPrev.keys" },
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
 * Hinweis: Browser reservieren Strg+N, Strg+W und Strg+Tab; dort kommt das Ereignis nicht an
 * (Wirkung nur in installierter App oder Kiosk-Fenstern). Alt+1..9 und die Schaltflächen wirken überall.
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

      if (mod && !e.altKey && key === "k") run(h.search);
      else if (mod && !e.altKey && !e.shiftKey && key === "n") run(h.create);
      else if (mod && !e.altKey && key === "s") run(h.save);
      else if (mod && !e.altKey && key === "/") run(h.overview);
      else if (mod && !e.altKey && key === "w") run(h.closeTab);
      else if (mod && e.key === "Tab") run(e.shiftKey ? h.prevTab : h.nextTab);
      else if (e.altKey && !mod && /^[1-9]$/.test(e.key)) run(() => h.tabNumber(Number(e.key)));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
