import { useEffect, useRef } from "react";
import { useCurrentTab, useTabs } from "./tabs";

/** Ruft `callback`, wenn der Tab des Aufrufers wieder aktiv wird (nicht beim ersten Anzeigen). Für Listen, die sonst veralten. */
export function useOnTabActivate(callback: () => void) {
  const { id } = useCurrentTab();
  const { activeId } = useTabs();
  const active = activeId === id;
  const was = useRef(active);
  const fn = useRef(callback);
  fn.current = callback;
  useEffect(() => {
    if (active && !was.current) fn.current();
    was.current = active;
  }, [active]);
}
