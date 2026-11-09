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

export type Theme = "light" | "dark";

/** Schlüssel in localStorage. `public/theme-init.js` liest denselben Schlüssel vor dem ersten Rendern. */
export const THEME_STORAGE_KEY = "stammbuch.theme";

/** Klasse am `<html>` während des Farbwechsels; Dauer = `--dur-slow` (320 ms) plus Reserve. */
export const THEME_ANIM_CLASS = "theme-anim";
export const THEME_ANIM_MS = 360;

interface ThemeApi {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeApi | null>(null);

function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Speicher gesperrt: Systemeinstellung gilt.
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Hell/Dunkel nach Design-Guide: Attribut `data-theme` am `<html>`, Wahl bleibt gespeichert. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(initialTheme);

  const shown = useRef<Theme | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    // Weicher Farbwechsel nur beim Umschalten (motion.css), nie beim Seitenaufbau und nicht bei reduzierter Bewegung.
    const changed = shown.current !== null && shown.current !== theme;
    shown.current = theme;
    if (!changed) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    root.classList.add(THEME_ANIM_CLASS);
    const timer = setTimeout(() => root.classList.remove(THEME_ANIM_CLASS), THEME_ANIM_MS);
    return () => {
      clearTimeout(timer);
      root.classList.remove(THEME_ANIM_CLASS);
    };
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Nicht speicherbar: gilt nur für diese Sitzung.
    }
  }, []);

  const toggle = useCallback(
    () => setTheme(theme === "dark" ? "light" : "dark"),
    [theme, setTheme],
  );
  const api = useMemo(() => ({ theme, setTheme, toggle }), [theme, setTheme, toggle]);
  return <ThemeContext.Provider value={api}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeApi {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme braucht einen ThemeProvider");
  return ctx;
}
