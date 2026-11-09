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
  /** Worum es bei den ungespeicherten Eingaben geht, z. B. «Daniel Probe» (Warnung beim Schliessen). */
  dirtySubject?: string;
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
  /**
   * Handler, der Tab «Liste» (`nav`) oder «Neu» (`new`) des Moduls `moduleId` öffnet.
   * `undefined`, wenn es das Modul oder den Tab-Typ nicht gibt: Schaltflächen erscheinen dann nicht.
   */
  moduleOpener: (moduleId: string, kind: "nav" | "new") => (() => void) | undefined;
  activateTab: (id: string) => void;
  activateIndex: (index: number) => void;
  cycle: (direction: 1 | -1) => void;
  /** Verschiebt den Tab an die Stelle `toIndex` (Zählung nach dem Herausnehmen); die Auswahl bleibt. */
  moveTab: (id: string, toIndex: number) => void;
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
  /** Ungespeicherte Eingaben: Punkt im Tab und Warnung beim Schliessen. `subject` nennt die Angaben in der Warnung. */
  setDirty: (dirty: boolean, subject?: string) => void;
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

/** Ablage der offenen Tabs für das Neuladen (sessionStorage: nur dieses Browserfenster, endet mit dem Schliessen). */
export const TABS_STORAGE_KEY = "stammbuch.tabs";
const MAX_STORED_TABS = 40;
const MAX_STORED_TEXT = 200;

interface StoredTabs {
  tabs: Array<Pick<TabState, "type" | "key" | "params" | "title">>;
  active: number;
}

/** Vergisst die gemerkten Tabs (beim Abmelden). */
export function clearStoredTabs() {
  try {
    sessionStorage.removeItem(TABS_STORAGE_KEY);
  } catch {
    // Speicher gesperrt: nichts zu löschen
  }
}

const isText = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_STORED_TEXT;

/**
 * Liest die gemerkten Tabs. Nur Typ, Schlüssel, Parameter und Titel; nur bekannte Tab-Typen und kurze Texte.
 * Tabs, deren Parameter Freitext oder Adressen tragen (mehr als 200 Zeichen oder «@»), kommen nicht zurück.
 */
function readStoredTabs(isKnown: (type: string) => boolean): StoredTabs | undefined {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(TABS_STORAGE_KEY) ?? "null");
    if (typeof raw !== "object" || raw === null || !Array.isArray((raw as StoredTabs).tabs)) return;
    const tabs: StoredTabs["tabs"] = [];
    let active = -1;
    (raw as StoredTabs).tabs.slice(0, MAX_STORED_TABS).forEach((x: unknown, i) => {
      const o = x as Record<string, unknown> | null;
      if (typeof o !== "object" || o === null || !isText(o["type"]) || !isKnown(o["type"])) return;
      const params = o["params"];
      if (typeof params !== "object" || params === null || Array.isArray(params)) return;
      const entries = Object.entries(params);
      if (
        entries.length > 10 ||
        !entries.every(([k, v]) => isText(k) && isText(v) && !v.includes("@"))
      )
        return;
      if (o["key"] !== undefined && !isText(o["key"])) return;
      if (o["title"] !== undefined && !isText(o["title"])) return;
      if (i === (raw as StoredTabs).active) active = tabs.length;
      tabs.push({
        type: o["type"],
        params: Object.fromEntries(entries) as Record<string, string>,
        ...(o["key"] !== undefined ? { key: o["key"] } : {}),
        ...(o["title"] !== undefined ? { title: o["title"] } : {}),
      });
    });
    return tabs.length > 0 ? { tabs, active: Math.max(active, 0) } : undefined;
  } catch {
    return undefined;
  }
}

interface TabsProviderProps {
  modules: readonly ModuleDefinition[];
  /** Tab-Typ, der beim Start (und nach dem Schliessen des letzten Tabs) geöffnet wird. */
  initialType?: string;
  /** Offene Tabs im sessionStorage merken und beim Neuladen wiederherstellen (ungespeicherte Eingaben nicht). */
  persist?: boolean;
  children: ReactNode;
}

export function TabsProvider({ modules, initialType, persist, children }: TabsProviderProps) {
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
    const stored = persist
      ? readStoredTabs((type) => modules.some((m) => m.tabTypes.some((x) => x.id === type)))
      : undefined;
    if (stored) {
      const tabs = stored.tabs.flatMap((x) => create(x.type, x) ?? []);
      if (tabs.length > 0) return { tabs, activeId: (tabs[stored.active] ?? tabs[0]!).id };
    }
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

  const moveTab = useCallback(
    (id: string, toIndex: number) =>
      setState((s) => {
        const from = s.tabs.findIndex((x) => x.id === id);
        if (from < 0) return s;
        const to = Math.max(0, Math.min(toIndex, s.tabs.length - 1));
        if (to === from) return s;
        const tabs = [...s.tabs];
        const [tab] = tabs.splice(from, 1);
        tabs.splice(to, 0, tab!);
        return { ...s, tabs };
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

  useEffect(() => {
    if (!persist) return;
    const data: StoredTabs = {
      tabs: state.tabs.map(({ type, key, params, title }) => ({
        type,
        params,
        ...(key !== undefined ? { key } : {}),
        ...(title !== undefined ? { title } : {}),
      })),
      active: state.tabs.findIndex((x) => x.id === state.activeId),
    };
    try {
      sessionStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Speicher gesperrt oder voll: die Tabs gehen beim Neuladen verloren, mehr nicht
    }
  }, [persist, state]);

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
      moduleOpener: (moduleId, kind) => {
        const mod = modules.find((m) => m.id === moduleId);
        const type = kind === "new" ? mod?.newTabType : mod?.nav.tabType;
        return type ? () => openTab(type, kind === "nav" ? { key: type } : undefined) : undefined;
      },
      activateTab,
      activateIndex,
      cycle,
      moveTab,
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
      moveTab,
      requestClose,
      confirmClose,
      saveActive,
      update,
      registerSave,
    ],
  );

  return <TabsContext.Provider value={api}>{children}</TabsContext.Provider>;
}
