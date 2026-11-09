import { useRef, type KeyboardEvent } from "react";
import { t } from "../i18n";
import { Icon } from "../ui";
import { useTabs, type TabState } from "./tabs";

export const tabDomId = (id: string) => `tabbtn-${id}`;
export const panelDomId = (id: string) => `tabpanel-${id}`;

/**
 * Tab-Leiste (Design 2.1, 2.8, 11.8): Landmark `header`, darin die tablist. Tab mit ungespeicherten
 * Eingaben trägt einen Punkt und im Text «Ungespeichert:». Schliessen-Schaltfläche je Tab.
 */
export function TabBar() {
  const { tabs, activeId, tabType, activateTab, requestClose } = useTabs();
  const list = useRef<HTMLDivElement>(null);

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
            <div key={tab.id} className={on ? "tab is-active" : "tab"} role="presentation">
              <button
                type="button"
                role="tab"
                id={tabDomId(tab.id)}
                data-tab-id={tab.id}
                aria-keyshortcuts="Delete"
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
              {/* Nur für die Maus: Eine Schaltfläche im tablist verletzt das ARIA-Muster. Per Tastatur schliesst Entf auf dem Tab (oder Strg+W). */}
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
    </header>
  );
}
