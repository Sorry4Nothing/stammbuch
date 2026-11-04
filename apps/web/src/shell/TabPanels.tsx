import { useMemo } from "react";
import { CurrentTabContext, useTabs, type CurrentTab, type TabState } from "./tabs";
import { panelDomId, tabDomId } from "./TabBar";
import { TabErrorBoundary } from "./TabErrorBoundary";

function TabPanel({ tab, active }: { tab: TabState; active: boolean }) {
  const { tabType, update, registerSave, requestClose } = useTabs();
  const Content = tabType(tab)?.component;

  const current = useMemo<CurrentTab>(
    () => ({
      id: tab.id,
      params: tab.params,
      setDirty: (dirty) => update(tab.id, { dirty }),
      setTitle: (title) => update(tab.id, { title }),
      setPage: (page, total) => update(tab.id, { page: { current: page, total } }),
      registerSave: (handler) => registerSave(tab.id, handler),
      close: () => requestClose(tab.id),
    }),
    [tab.id, tab.params, update, registerSave, requestClose],
  );

  return (
    <div
      role="tabpanel"
      id={panelDomId(tab.id)}
      aria-labelledby={tabDomId(tab.id)}
      className="tabpanel"
      hidden={!active}
    >
      <CurrentTabContext.Provider value={current}>
        <TabErrorBoundary>{Content ? <Content tabId={tab.id} /> : null}</TabErrorBoundary>
      </CurrentTabContext.Provider>
    </div>
  );
}

/**
 * Alle offenen Tabs bleiben gemountet; nur der aktive ist sichtbar. So bleiben Eingaben,
 * Scrollposition und Auswahl beim Wechsel erhalten.
 */
export function TabPanels() {
  const { tabs, activeId } = useTabs();
  return (
    <>
      {tabs.map((tab) => (
        <TabPanel key={tab.id} tab={tab} active={tab.id === activeId} />
      ))}
    </>
  );
}
