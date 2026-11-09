import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { useAuth } from "../../auth/auth";
import { createHttpReportsService } from "./httpService";
import type { ReportsService } from "./types";

const Context = createContext<ReportsService | null>(null);

/** Setzt einen Dienst für den Teilbaum (Tests, Entwicklung). Ohne Provider gilt die API. */
export function ReportsProvider({
  service,
  children,
}: {
  service: ReportsService;
  children: ReactNode;
}) {
  return <Context.Provider value={service}>{children}</Context.Provider>;
}

export function useReports(): ReportsService {
  const injected = useContext(Context);
  const auth = useAuth();
  const expired = useRef(auth.markExpired);
  expired.current = auth.markExpired;
  const authService = auth.service;
  const http = useMemo(
    () =>
      createHttpReportsService({
        csrfToken: () => authService.csrfToken?.() ?? null,
        onUnauthorized: () => expired.current(),
      }),
    [authService],
  );
  return injected ?? http;
}
