import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { useAuth } from "../../auth/auth";
import { createHttpBuchhaltungService } from "./httpService";
import type { BuchhaltungService } from "./types";

const Context = createContext<BuchhaltungService | null>(null);

/** Setzt einen Dienst für den Teilbaum (Tests, Entwicklung). Ohne Provider gilt die API. */
export function BuchhaltungProvider({
  service,
  children,
}: {
  service: BuchhaltungService;
  children: ReactNode;
}) {
  return <Context.Provider value={service}>{children}</Context.Provider>;
}

export function useBuchhaltung(): BuchhaltungService {
  const injected = useContext(Context);
  const auth = useAuth();
  const expired = useRef(auth.markExpired);
  expired.current = auth.markExpired;
  const authService = auth.service;
  const userName = auth.session?.name ?? "";
  const http = useMemo(
    () =>
      createHttpBuchhaltungService({
        csrfToken: () => authService.csrfToken?.() ?? null,
        onUnauthorized: () => expired.current(),
        userName,
      }),
    [authService, userName],
  );
  return injected ?? http;
}
