import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { t } from "../i18n";
import { Icon } from "../ui";
import { useTabs, type TabState } from "./tabs";

export const tabDomId = (id: string) => `tabbtn-${id}`;
export const panelDomId = (id: string) => `tabpanel-${id}`;

/** Stelle, an der ein gezogener Tab landen würde: vor oder nach dem Tab `id`. */
interface DropTarget {
  id: string;
  after: boolean;
}

/**
 * Tab-Leiste (Design 2.1, 2.8, 11.8): Landmark `header`, darin die tablist. Tab mit ungespeicherten
 * Eingaben trägt einen Punkt und im Text «Ungespeichert:». Schliessen-Schaltfläche je Tab.
 * Umsortieren: Tab mit der Maus ziehen (Einfügemarke zeigt das Ziel) oder per Tastatur mit
 * Strg+Umschalt+Pfeil links/rechts (Ersatz für das Ziehen, WCAG 2.5.7).
 */
export function TabBar() {
  const { tabs, activeId, tabType, activateTab, requestClose, moveTab } = useTabs();
  const list = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | undefined>();
  const [drop, setDrop] = useState<DropTarget | undefined>();
  const [announcement, setAnnouncement] = useState("");
  /** Tab, der nach dem Verschieben wieder den Fokus bekommt (das Umhängen im DOM nimmt ihn weg). */
  const refocus = useRef<string | undefined>(undefined);

  useEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = undefined;
    list.current?.querySelector<HTMLElement>(`#${tabDomId(id)}`)?.focus();
  }, [tabs]);

  const endDrag = () => {
    setDragId(undefined);
    setDrop(undefined);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>, id: string) => {
    if (!dragId) return; // fremde Ziehvorgänge (Dateien, Text) nicht annehmen
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const box = e.currentTarget.getBoundingClientRect();
    const after = e.clientX > box.left + box.width / 2;
    setDrop((d) => (d && d.id === id && d.after === after ? d : { id, after }));
  };

  const onDrop = (e: DragEvent<HTMLDivElement>, id: string) => {
    if (!dragId) return;
    e.preventDefault();
    const from = tabs.findIndex((x) => x.id === dragId);
    const over = tabs.findIndex((x) => x.id === id);
    if (from >= 0 && over >= 0) {
      const slot = over + (drop?.id === id && drop.after ? 1 : 0);
      moveTab(dragId, from < slot ? slot - 1 : slot);
    }
    endDrag();
  };

  const moveByKey = (id: string, step: -1 | 1) => {
    const from = tabs.findIndex((x) => x.id === id);
    const to = from + step;
    const tab = tabs[from];
    if (!tab || to < 0 || to >= tabs.length) return;
    refocus.current = id;
    moveTab(id, to);
    setAnnouncement(t("shell.tabs.moved", { title: title(tab), n: to + 1, total: tabs.length }));
  };

  const title = (tab: TabState): string => {
    const type = tabType(tab);
    return tab.title ?? (type ? t(type.titleKey) : tab.type);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((x) => x.id === activeId);
    const go = (to: number) => {
      const target = tabs[(to + tabs.length) % tabs.length];
      if (!target) return;
      e.preventDefault();
      activateTab(target.id);
      list.current?.querySelector<HTMLElement>(`#${tabDomId(target.id)}`)?.focus();
    };
    if (e.target instanceof HTMLElement && e.target.getAttribute("role") !== "tab") return;
    if (e.ctrlKey && e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      const id = (e.target as HTMLElement).dataset.tabId;
      if (id) moveByKey(id, e.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if (e.key === "Delete") {
      e.preventDefault();
      const id = (e.target as HTMLElement).dataset.tabId;
      if (id) requestClose(id);
    } else if (e.key === "ArrowRight") go(index + 1);
    else if (e.key === "ArrowLeft") go(index - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(tabs.length - 1);
  };

  return (
    <header className="tabs">
      <div
        ref={list}
        className="tabs__list"
        role="tablist"
        aria-label={t("shell.tabs.label")}
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab) => {
          const on = tab.id === activeId;
          const name = title(tab);
          return (
            <div
              key={tab.id}
              className={[
                "tab",
                on && "is-active",
                dragId === tab.id && "is-dragging",
                drop?.id === tab.id &&
                  dragId !== tab.id &&
                  (drop.after ? "drop-after" : "drop-before"),
              ]
                .filter(Boolean)
                .join(" ")}
              role="presentation"
              draggable={tabs.length > 1}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", tab.id);
                setDragId(tab.id);
              }}
              onDragOver={(e) => onDragOver(e, tab.id)}
              onDrop={(e) => onDrop(e, tab.id)}
              onDragEnd={endDrag}
            >
              <button
                type="button"
                role="tab"
                id={tabDomId(tab.id)}
                data-tab-id={tab.id}
                aria-keyshortcuts="Delete Control+Shift+ArrowLeft Control+Shift+ArrowRight"
                className="tab__label"
                aria-selected={on}
                aria-controls={panelDomId(tab.id)}
                tabIndex={on ? 0 : -1}
                onClick={() => activateTab(tab.id)}
              >
                {tab.dirty && (
                  <>
                    <span className="dot" aria-hidden="true" />
                    <span className="visually-hidden">{t("shell.tabs.dirty")}</span>{" "}
                  </>
                )}
                <span className="tab__title">{name}</span>
              </button>
              {/* Nur für die Maus: Eine Schaltfläche im tablist verletzt das ARIA-Muster. Per Tastatur schliesst Entf auf dem Tab (oder Alt+W). */}
              <button
                type="button"
                className="tab__close"
                aria-hidden="true"
                tabIndex={-1}
                title={t("shell.tabs.close", { title: name })}
                onClick={() => requestClose(tab.id)}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="visually-hidden" aria-live="polite">
        {announcement}
      </div>
    </header>
  );
}
