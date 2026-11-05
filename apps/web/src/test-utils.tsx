import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { AuthProvider, type AuthService, type Session } from "./auth/auth";
import { ThemeProvider } from "./theme/ThemeProvider";
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

/** Rendert mit allen Providern wie in main.tsx (Router im Speicher). */
export function renderWithProviders(ui: ReactElement, options: Options = {}) {
  const { path = "/", service, session = testSession } = options;
  return render(
    <ThemeProvider>
      <AuthProvider service={service} initialSession={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
        </ToastProvider>
      </AuthProvider>
    </ThemeProvider>,
  );
}
