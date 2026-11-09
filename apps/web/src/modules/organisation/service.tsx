import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { useAuth, type TotpSetup } from "../../auth/auth";
import { createHttpSettingsService } from "./httpSettingsService";
import type {
  AuditExport,
  AuditPage,
  AuditQuery,
  Features,
  Licence,
  MailDraft,
  MailState,
  OrgData,
  OrgState,
  SecurityInfo,
  SettingsUser,
  TestOutcome,
} from "./model";

/**
 * Vertrag zwischen den Seiten der Einstellungen und dem Backend. Die Umsetzung gegen die API steht in
 * `httpSettingsService.ts`, eine Umsetzung im Speicher für Tests und Entwicklung in
 * `memorySettingsService.ts`. Fehler als Exception werfen (`ApiError` bei Antworten der API).
 */
export interface SettingsService {
  features: Features;

  loadOrganisation(signal?: AbortSignal): Promise<OrgState>;
  /** Speichert die geänderten Bereiche. */
  saveOrganisation(data: OrgData): Promise<void>;
  /** Link auf das Logo (gleiche Origin), `v` ändert sich mit jedem Hochladen. */
  logoUrl(version: string): string;
  uploadLogo(file: File): Promise<void>;
  removeLogo(): Promise<void>;

  loadMail(signal?: AbortSignal): Promise<MailState>;
  /** Speichert das Konto. Das Passwort ist Pflicht, die API kennt kein Ändern ohne Passwort. */
  saveMail(draft: MailDraft): Promise<void>;
  /**
   * Prüft Verbindung und Anmeldung. `onStage` meldet die Stufe (0 bis 5), die gerade läuft.
   * Bricht `signal` ab, endet der Aufruf mit einer `AbortError`.
   */
  testMail(
    draft: MailDraft,
    options: { signal: AbortSignal; onStage: (running: number) => void },
  ): Promise<TestOutcome>;

  listUsers(signal?: AbortSignal): Promise<SettingsUser[]>;
  addUser(name: string, email: string): Promise<void>;
  removeUser(id: string): Promise<void>;
  loadSecurity(signal?: AbortSignal): Promise<SecurityInfo>;
  changePassword(current: string, next: string): Promise<"ok" | "wrong" | "weak">;
  /** Neue Wiederherstellungscodes; verlangt einen frischen Einmalcode. `null`: Code ungültig. */
  renewRecoveryCodes(code: string): Promise<string[] | null>;
  /**
   * Nur mit `features.totpRenewal`. Verlangt den frischen Code des bisherigen Einmalcodes und liefert den neuen
   * Schlüssel; `null`: Code ungültig. Der neue Schlüssel gilt erst nach `confirmTotpRenewal`.
   */
  beginTotpRenewal(currentCode: string): Promise<TotpSetup | null>;
  confirmTotpRenewal(code: string): Promise<boolean>;

  queryAudit(query: AuditQuery, signal?: AbortSignal): Promise<AuditPage>;
  exportAudit(query: Omit<AuditQuery, "offset" | "limit">): Promise<AuditExport>;

  loadLicence(signal?: AbortSignal): Promise<Licence>;
}

const SettingsContext = createContext<SettingsService | null>(null);

/** Setzt einen Dienst für den Teilbaum (Tests, Entwicklung). Ohne Provider gilt die API. */
export function SettingsProvider({
  service,
  children,
}: {
  service: SettingsService;
  children: ReactNode;
}) {
  return <SettingsContext.Provider value={service}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsService {
  const injected = useContext(SettingsContext);
  const auth = useAuth();
  const expired = useRef(auth.markExpired);
  expired.current = auth.markExpired;
  const authService = auth.service;
  const http = useMemo(
    () =>
      createHttpSettingsService({
        csrfToken: () => authService.csrfToken?.() ?? null,
        onUnauthorized: () => expired.current(),
        refreshSession: async () => authService.restoreSession?.(),
      }),
    [authService],
  );
  return injected ?? http;
}
