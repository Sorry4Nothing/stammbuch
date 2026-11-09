import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { AuthProvider, type AuthService, type Session } from "./auth/auth";
import { ThemeProvider } from "./theme/ThemeProvider";
import { emptyStartService, StartServiceContext } from "./modules/start/startService";
import { emptyNavCounters, NavCountersContext } from "./shell/navCounters";
import { ToastProvider } from "./ui";

export const testSession: Session = {
  name: "Sabine Muster",
  email: "sabine.muster@example.ch",
  organization: "Verein Beispiel",
  startedAt: Date.now() - (7 * 60 + 42) * 60_000,
};

interface Options {
  path?: string;
  service?: AuthService;
  session?: Session | null;
}

/**
 * Rendert mit allen Providern wie in main.tsx (Router im Speicher). Startseite und Navigationszähler
 * laufen ohne API (leer); Tests setzen eigene Dienste weiter innen ein.
 */
export function renderWithProviders(ui: ReactElement, options: Options = {}) {
  const { path = "/", service, session = testSession } = options;
  return render(
    <ThemeProvider>
      <AuthProvider service={service} initialSession={session}>
        <ToastProvider>
          <StartServiceContext.Provider value={emptyStartService}>
            <NavCountersContext.Provider value={emptyNavCounters}>
              <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
            </NavCountersContext.Provider>
          </StartServiceContext.Provider>
        </ToastProvider>
      </AuthProvider>
    </ThemeProvider>,
  );
}
