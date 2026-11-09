import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { useAuth } from "../../auth/auth";
import { createHttpChefAdminService } from "./httpChefAdminService";
import { ChefAdminServiceContext, type ChefAdminService } from "./model";

export type View =
  { name: "customers" } | { name: "new" } | { name: "customer"; id: string } | { name: "account" };

export interface ChefNav {
  view: View;
  go: (view: View) => void;
  /** Zählt hoch, wenn die Suche (Strg+K) den Fokus verlangt. */
  searchRequest: number;
  /** Handler für Strg+S der aktuellen Seite; `null` meldet ihn ab. */
  setSave: (handler: (() => void) | null) => void;
}

export const ChefNavContext = createContext<ChefNav | null>(null);

export function useChefNav(): ChefNav {
  const ctx = useContext(ChefNavContext);
  if (!ctx) throw new Error("useChefNav nur im Rahmen der Anbieter-Verwaltung verwenden");
  return ctx;
}

/** Meldet den Speicher-Handler der Seite für Strg+S an, solange sie angezeigt wird. */
export function useRegisterSave(handler: () => void) {
  const { setSave } = useChefNav();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    setSave(() => ref.current());
    return () => setSave(null);
  }, [setSave]);
}

/** Der eingesetzte Dienst (Tests) oder sonst die HTTP-Umsetzung mit der Sitzung des Benutzers. */
export function useChefAdminService(): ChefAdminService {
  const injected = useContext(ChefAdminServiceContext);
  const { service, markExpired } = useAuth();
  return useMemo(
    () =>
      injected ??
      createHttpChefAdminService({
        csrfToken: () => service.csrfToken?.() ?? null,
        onUnauthorized: markExpired,
      }),
    [injected, service, markExpired],
  );
}
