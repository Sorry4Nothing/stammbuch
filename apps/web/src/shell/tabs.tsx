import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ModuleDefinition, ModuleTabType } from "../modules/types";

export interface TabState {
  id: string;
  type: string;
  moduleId: string;
  /** Gleicher Schlüssel = gleicher Tab: wird aktiviert statt neu geöffnet. */
  key?: string;
  params: Record<string, string>;
  title?: string;
  dirty: boolean;
  page: { current: number; total: number };
}

export interface OpenOptions {
  key?: string;
  params?: Record<string, string>;
  title?: string;
}

type SaveHandler = () => boolean | void | Promise<boolean | void>;

interface TabsApi {
  modules: readonly ModuleDefinition[];
  tabs: readonly TabState[];
  activeId: string;
  active: TabState | undefined;
  tabType: (tab: TabState) => ModuleTabType | undefined;
  openTab: (type: string, options?: OpenOptions) => void;
  activateTab: (id: string) => void;
  activateIndex: (index: number) => void;
  cycle: (direction: 1 | -1) => void;
  /** Schliesst den Tab; bei ungespeicherten Eingaben erst nach Rückfrage (`pendingClose`). */
  requestClose: (id: string) => void;
  pendingClose: TabState | undefined;
  confirmClose: (action: "discard" | "save") => Promise<void>;
  cancelClose: () => void;
  canSave: (id: string) => boolean;
  saveActive: () => Promise<void>;
  update: (id: string, patch: Partial<Omit<TabState, "id">>) => void;
  registerSave: (id: string, handler: SaveHandler) => () => void;
}

const TabsContext = createContext<TabsApi | null>(null);

export function useTabs(): TabsApi {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("useTabs braucht einen TabsProvider");
  return ctx;
}

/** Zugriff eines Tab-Inhalts auf seinen eigenen Tab. */
export interface CurrentTab {
  id: string;
  params: Record<string, string>;
  /** Ungespeicherte Eingaben: Punkt im Tab und Warnung beim Schliessen. */
  setDirty: (dirty: boolean) => void;
  setTitle: (title: string) => void;
  setPage: (current: number, total: number) => void;
  /** Handler für Strg+S und «Speichern und schliessen». Rückgabe `false` = nicht gespeichert. */
  registerSave: (handler: SaveHandler) => () => void;
  close: () => void;
}

export const CurrentTabContext = createContext<CurrentTab | null>(null);

export function useCurrentTab(): CurrentTab {
  const ctx = useContext(CurrentTabContext);
  if (!ctx) throw new Error("useCurrentTab nur innerhalb eines Tabs verwenden");
  return ctx;
}

interface TabsProviderProps {
  modules: readonly ModuleDefinition[];
  /** Tab-Typ, der beim Start (und nach dem Schliessen des letzten Tabs) geöffnet wird. */
  initialType?: string;
  children: ReactNode;
}

export function TabsProvider({ modules, initialType, children }: TabsProviderProps) {
  const startType = useMemo(
    () => initialType ?? [...modules].sort((a, b) => a.nav.order - b.nav.order)[0]?.nav.tabType,
    [initialType, modules],
  );
  const counter = useRef(0);
  const saves = useRef(new Map<string, SaveHandler>());

  const create = useCallback(
    (type: string, options?: OpenOptions): TabState | undefined => {
      const mod = modules.find((m) => m.tabTypes.some((x) => x.id === type));
      if (!mod) return undefined;
      return {
        id: `tab-${++counter.current}`,
        type,
        moduleId: mod.id,
        key: options?.key,
        params: options?.params ?? {},
        title: options?.title,
        dirty: false,
        page: { current: 1, total: 1 },
      };
    },
    [modules],
  );

  const [state, setState] = useState<{ tabs: TabState[]; activeId: string }>(() => {
    const first = startType ? create(startType, { key: startType }) : undefined;
    return { tabs: first ? [first] : [], activeId: first?.id ?? "" };
  });
  const [pendingId, setPendingId] = useState<string | undefined>();

  const stateRef = useRef(state);
  stateRef.current = state;

  const openTab = useCallback(
    (type: string, options?: OpenOptions) => {
      const { tabs } = stateRef.current;
      const existing =
        options?.key !== undefined
          ? tabs.find((x) => x.type === type && x.key === options.key)
          : undefined;
      if (existing) {
        setState((s) => ({ ...s, activeId: existing.id }));
        return;
      }
      const tab = create(type, options);
      if (tab) setState((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
    },
    [create],
  );

  const activateTab = useCallback(
    (id: string) => setState((s) => (s.tabs.some((x) => x.id === id) ? { ...s, activeId: id } : s)),
    [],
  );

  const activateIndex = useCallback(
    (index: number) =>
      setState((s) => {
        const tab = s.tabs[index];
        return tab ? { ...s, activeId: tab.id } : s;
      }),
    [],
  );

  const cycle = useCallback(
    (direction: 1 | -1) =>
      setState((s) => {
        if (s.tabs.length === 0) return s;
        const i = s.tabs.findIndex((x) => x.id === s.activeId);
        const next = s.tabs[(i + direction + s.tabs.length) % s.tabs.length]!;
        return { ...s, activeId: next.id };
      }),
    [],
  );

  const closeNow = useCallback(
    (id: string) => {
      saves.current.delete(id);
      setPendingId((p) => (p === id ? undefined : p));
      setState((s) => {
        const i = s.tabs.findIndex((x) => x.id === id);
        if (i < 0) return s;
        const tabs = s.tabs.filter((x) => x.id !== id);
        if (tabs.length === 0) {
          const first = startType ? create(startType, { key: startType }) : undefined;
          return { tabs: first ? [first] : [], activeId: first?.id ?? "" };
        }
        const activeId = s.activeId === id ? tabs[Math.min(i, tabs.length - 1)]!.id : s.activeId;
        return { tabs, activeId };
      });
    },
    [create, startType],
  );

  const requestClose = useCallback(
    (id: string) => {
      const tab = stateRef.current.tabs.find((x) => x.id === id);
      if (!tab) return;
      if (tab.dirty) setPendingId(id);
      else closeNow(id);
    },
    [closeNow],
  );

  const update = useCallback((id: string, patch: Partial<Omit<TabState, "id">>) => {
    setState((s) => {
      const tab = s.tabs.find((x) => x.id === id);
      if (!tab || Object.entries(patch).every(([k, v]) => tab[k as keyof TabState] === v)) return s;
      return { ...s, tabs: s.tabs.map((x) => (x.id === id ? { ...x, ...patch } : x)) };
    });
  }, []);

  const registerSave = useCallback((id: string, handler: SaveHandler) => {
    saves.current.set(id, handler);
    return () => {
      if (saves.current.get(id) === handler) saves.current.delete(id);
    };
  }, []);

  const runSave = useCallback(async (id: string): Promise<boolean> => {
    const handler = saves.current.get(id);
    if (!handler) return false;
    try {
      return (await handler()) !== false;
    } catch {
      return false;
    }
  }, []);

  const confirmClose = useCallback(
    async (action: "discard" | "save") => {
      const id = pendingId;
      if (!id) return;
      if (action === "discard" || (await runSave(id))) closeNow(id);
      else setPendingId(undefined); // Speichern misslungen: Tab bleibt offen, er zeigt den Fehler selbst
    },
    [pendingId, closeNow, runSave],
  );

  const saveActive = useCallback(async () => {
    await runSave(stateRef.current.activeId);
  }, [runSave]);

  // Ungespeicherte Eingaben: Browser warnt beim Neuladen oder Schliessen des Fensters.
  const anyDirty = state.tabs.some((x) => x.dirty);
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  const api = useMemo<TabsApi>(
    () => ({
      modules,
      tabs: state.tabs,
      activeId: state.activeId,
      active: state.tabs.find((x) => x.id === state.activeId),
      tabType: (tab) => modules.flatMap((m) => m.tabTypes).find((x) => x.id === tab.type),
      openTab,
      activateTab,
      activateIndex,
      cycle,
      requestClose,
      pendingClose: state.tabs.find((x) => x.id === pendingId),
      confirmClose,
      cancelClose: () => setPendingId(undefined),
      canSave: (id) => saves.current.has(id),
      saveActive,
      update,
      registerSave,
    }),
    [
      modules,
      state,
      pendingId,
      openTab,
      activateTab,
      activateIndex,
      cycle,
      requestClose,
      confirmClose,
      saveActive,
      update,
      registerSave,
    ],
  );

  return <TabsContext.Provider value={api}>{children}</TabsContext.Provider>;
}
