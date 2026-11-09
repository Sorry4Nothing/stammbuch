import { createContext } from "react";

/** Module, die der Anbieter pro Lizenz freischaltet (Design 10.2). Personen, Rechnungen, Buchhaltung und Auswertungen gehören immer dazu. */
export const LICENCE_MODULES = ["sammelrechnung", "mail", "kalender"] as const;
export type LicenceModule = (typeof LICENCE_MODULES)[number];

export type CustomerStatus = "active" | "suspended" | "ended";

/**
 * Vertragsdaten eines Kunden, nie Daten aus dem Betrieb des Kunden (Projektplan Abschnitt 8).
 * `null` heisst: der Vertrag kennt das Feld nicht (Altkunden); die Oberfläche zeigt «–».
 */
export interface Customer {
  /** Technische ID (UUID) für Anfragen. */
  id: string;
  /** Kunden-ID zur Anzeige und zur Bestätigung beim Sperren (heute die Kennung des Kunden). */
  ref: string;
  name: string;
  status: CustomerStatus;
  /** Letzter Tag der Lizenz, JJJJ-MM-TT. */
  licenceUntil: string;
  licenceNumber: string | null;
  /** JJJJ-MM-TT */
  licenceStart: string | null;
  /** E-Mail der ersten Person (Empfänger der Einladung). */
  contact: string | null;
  /** Anzahl aktiver Benutzer (nur die Zahl). */
  userCount: number;
  modules: LicenceModule[] | null;
}

export interface CustomerFilter {
  q?: string;
  status?: CustomerStatus;
}

export interface CustomerInput {
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  /** JJJJ-MM-TT */
  licenceStart: string;
  /** JJJJ-MM-TT */
  licenceUntil: string;
  modules: LicenceModule[];
}

/** Benutzer eines Kunden mit Stand des zweiten Faktors, für den Support (2FA-Reset). */
export interface CustomerUser {
  id: string;
  name: string;
  email: string;
  totp: "set" | "missing";
  /** ISO-Zeitstempel oder `null` (noch nie angemeldet). */
  lastLogin: string | null;
}

export interface AuditRow {
  id: string;
  /** ISO-Zeitstempel */
  at: string;
  actor: string;
  /** Code der API, z. B. `customer.suspend`. */
  action: string;
  target: string;
}

export interface SessionRow {
  id: string;
  /** Das Gerät wird nicht erfasst; die Oberfläche beschriftet die Sitzung dann mit ihrem Beginn. */
  device: string | null;
  /** ISO-Zeitstempel */
  since: string;
  current: boolean;
}

/** Art der Anmeldung bzw. des Fehlversuchs, wie die API sie meldet. */
export type LoginMethod = "totp" | "recovery" | "setup" | "password_failed" | "code_failed";

export interface LoginRow {
  id: string;
  /** ISO-Zeitstempel */
  at: string;
  method: LoginMethod;
  success: boolean;
}

/** Eigenes Konto des Chef-Admins (Design 10.6). `null` bei einem Zeitpunkt: er ist nicht bekannt. */
export interface AccountOverview {
  email: string;
  displayName: string;
  passwordChangedAt: string | null;
  totpSetUpAt: string | null;
  recoveryCodes: { unused: number; total: number };
  sessions: SessionRow[];
  logins: LoginRow[];
}

export type CustomerAction = "suspend" | "reactivate" | "end-contract";

/** Fehler einer Anfrage. `status` ist der HTTP-Status; nie Text oder Inhalt der Antwort. */
export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`Anfrage fehlgeschlagen (${status})`);
  }
}

/** Der Einmalcode des Chef-Admins war falsch (Step-up beim 2FA-Reset). Die Sitzung bleibt bestehen. */
export class CodeRejectedError extends Error {
  constructor() {
    super("Einmalcode abgelehnt");
  }
}

/**
 * Datenquelle des Chef-Admin-Moduls. Die Umsetzung gegen die API steht in `httpChefAdminService.ts`,
 * für Tests und Entwicklung gibt es `memoryChefAdminService.ts`.
 */
export interface ChefAdminService {
  /** Kunden, neueste zuerst. */
  listCustomers(
    filter: CustomerFilter,
    signal?: AbortSignal,
  ): Promise<{ items: Customer[]; total: number }>;
  getCustomer(id: string, signal?: AbortSignal): Promise<Customer>;
  /** Legt den Kunden an und verschickt die Einladung. Das Token der Einladung sieht der Chef-Admin nie. */
  createCustomer(input: CustomerInput): Promise<Customer>;
  extendLicence(id: string, licenceUntil: string): Promise<Customer>;
  changeStatus(id: string, action: CustomerAction): Promise<Customer>;
  /** Aktive Benutzer des Kunden. */
  customerUsers(id: string, signal?: AbortSignal): Promise<CustomerUser[]>;
  /**
   * Setzt den zweiten Faktor eines Benutzers zurück. `code` ist ein frischer Einmalcode des Chef-Admins (Step-up),
   * `reason` und `calledBack` kommen ins Anbieter-Protokoll. Ein falscher Code ist `ApiError` mit Status 401.
   */
  resetTwoFactor(
    customerId: string,
    userId: string,
    input: { reason: string; calledBack: boolean; code: string },
  ): Promise<void>;
  /** Anbieter-Protokoll, neueste zuerst. `q` filtert nach Kunde. */
  audit(filter: { q?: string; limit: number }, signal?: AbortSignal): Promise<AuditRow[]>;
  account(signal?: AbortSignal): Promise<AccountOverview>;
  /** Beendet eine andere Sitzung des eigenen Kontos. */
  endSession(id: string): Promise<void>;
}

export const ChefAdminServiceContext = createContext<ChefAdminService | null>(null);
