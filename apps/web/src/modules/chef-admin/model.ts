import { createContext } from "react";

/** Module, die der Anbieter pro Lizenz freischaltet (Design 10.2). Personen, Rechnungen, Buchhaltung und Auswertungen gehören immer dazu. */
export const LICENCE_MODULES = ["sammelrechnung", "mail", "kalender"] as const;
export type LicenceModule = (typeof LICENCE_MODULES)[number];

export type CustomerStatus = "active" | "suspended" | "ended";

/**
 * Vertragsdaten eines Kunden, nie Daten aus dem Betrieb des Kunden (Projektplan Abschnitt 8).
 * `null` heisst: die API liefert das Feld nicht; die Oberfläche zeigt «–».
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
  userCount: number | null;
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

/** Benutzer eines Kunden mit Stand des zweiten Faktors. Die API liefert sie dem Anbieter heute nicht. */
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
  device: string;
  /** ISO-Zeitstempel */
  since: string;
  current: boolean;
}

export interface LoginRow {
  id: string;
  /** ISO-Zeitstempel */
  at: string;
  method: string;
  success: boolean;
}

/** Eigenes Konto des Chef-Admins (Design 10.6). `null`: die API liefert das nicht. */
export interface AccountOverview {
  email: string;
  displayName: string;
  passwordChangedAt: string | null;
  totpSetUpAt: string | null;
  recoveryCodes: { unused: number; total: number } | null;
  sessions: SessionRow[] | null;
  logins: LoginRow[] | null;
}

export type CustomerAction = "suspend" | "reactivate" | "end-contract";

/** Fehler einer Anfrage. `status` ist der HTTP-Status; nie Text oder Inhalt der Antwort. */
export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`Anfrage fehlgeschlagen (${status})`);
  }
}

/** Meldet, dass die API eine Funktion nicht anbietet (siehe PR, «Fehlende API»). */
export class UnsupportedError extends Error {
  constructor() {
    super("Von der API nicht unterstützt");
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
  /** `null`: die Benutzerliste steht dem Anbieter nicht zur Verfügung. */
  customerUsers(id: string, signal?: AbortSignal): Promise<CustomerUser[] | null>;
  resetTwoFactor(
    customerId: string,
    userId: string,
    input: { reason: string; calledBack: boolean },
  ): Promise<void>;
  /** Anbieter-Protokoll, neueste zuerst. `q` filtert nach Kunde. */
  audit(filter: { q?: string; limit: number }, signal?: AbortSignal): Promise<AuditRow[]>;
  account(signal?: AbortSignal): Promise<AccountOverview>;
  /** Beendet eine andere Sitzung des eigenen Kontos. */
  endSession(id: string): Promise<void>;
}

export const ChefAdminServiceContext = createContext<ChefAdminService | null>(null);
