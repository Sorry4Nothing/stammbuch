import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import type {
  LicenceModule,
  OrganisationSection,
  Role,
  organisationSectionSchemas,
} from "@stammbuch/shared";

/**
 * Wer die Anfrage stellt. Kommt immer aus der serverseitig aufgelösten Session (SR-13),
 * nie aus dem Request-Body. Die Anmeldung (Auth-Modul) liefert den `PrincipalResolver`.
 */
export type CustomerPrincipal = {
  kind: "customer";
  userId: string;
  tenantId: string;
  email: string;
  role: Role;
};
export type ChefPrincipal = { kind: "chef"; accountId: string; email: string };
export type Principal = CustomerPrincipal | ChefPrincipal;
export type PrincipalResolver = (request: FastifyRequest) => Promise<Principal | null>;

export type PageRequest = { limit: number; offset: number };
export type Page<T> = { items: T[]; total: number };

// --- Kunden (Mandanten) und Lizenz -------------------------------------------------------

export type TenantStatus = "active" | "suspended" | "ended";
export interface Tenant {
  id: string;
  name: string;
  /** Öffentliche Kennung (`/public/<slug>/…`); `null` bei Altkunden ohne Slug. */
  slug: string | null;
  status: TenantStatus;
  /** Letzter gültiger Tag der Lizenz (YYYY-MM-DD, Zeitzone Europe/Zurich), einschliesslich. */
  licenceValidUntil: string;
  createdAt: string;
  endedAt: string | null;
  /** Fortlaufende Lizenznummer (L-0001), vergibt die Persistenz beim Anlegen; `null` bei Altkunden. */
  licenceNumber: string | null;
  /** Beginn der Lizenz (YYYY-MM-DD); `null`, wenn der Vertrag ihn nicht kennt. */
  licenceStart: string | null;
  /** Freigeschaltete Module; `null`, wenn der Vertrag sie nicht kennt (Altkunden). */
  modules: LicenceModule[] | null;
  /** Anzahl aktiver Benutzer (Chef-Admins zählen nicht). Abgeleitet, nie gespeichert. */
  userCount: number;
}
/** Angaben beim Anlegen. Nummer und Benutzerzahl vergibt bzw. zählt die Persistenz. */
export type NewTenant = Omit<Tenant, "licenceNumber" | "licenceStart" | "modules" | "userCount"> & {
  licenceStart?: string | null;
  modules?: LicenceModule[] | null;
};
/** Vertragsdaten, die der Chef-Admin später ändert. */
export type TenantPatch = Partial<
  Omit<Tenant, "id" | "createdAt" | "licenceNumber" | "licenceStart" | "modules" | "userCount">
>;
export interface TenantRepository {
  /**
   * `actorId`: der Chef-Admin aus der Sitzung. Die Postgres-Variante prüft ihn in der Datenbank (SR-10).
   * `create` und `update` werfen `SlugTakenError`, wenn der Slug schon vergeben ist.
   */
  create(actorId: string, tenant: NewTenant): Promise<void>;
  get(id: string): Promise<Tenant | undefined>;
  list(
    actorId: string,
    filter: { status?: TenantStatus | undefined; q?: string | undefined },
    page: PageRequest,
  ): Promise<Page<Tenant>>;
  update(actorId: string, id: string, patch: TenantPatch): Promise<Tenant | undefined>;
}

// --- Einladungen -------------------------------------------------------------------------

export interface Invitation {
  id: string;
  tenantId: string;
  email: string;
  role: Role;
  /** Gesetzt, wenn der Benutzer-Eintrag schon existiert (Einladung aus den Einstellungen). */
  userId: string | null;
  /** Name des ersten Admins (nur ohne `userId`); fehlt er, nimmt die Einlösung den Teil der Adresse vor dem @. */
  name?: string | null;
  /** Nur der SHA-256-Hash des Tokens wird gespeichert (SR-30). */
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}
export interface InvitationRepository {
  create(invitation: Invitation): Promise<void>;
  /** Löst eine Einladung genau einmal ein. Abgelaufen oder schon benutzt: `undefined`. Für das Auth-Modul. */
  consume(tokenHash: string, now: Date): Promise<Invitation | undefined>;
  latestForTenant(tenantId: string): Promise<Invitation | undefined>;
}
export type InvitationMessage = {
  to: string;
  token: string;
  tenantName: string;
  expiresAt: string;
};
/** Versand der Einladung. Das Token darf nur hier ankommen, nie in einer API-Antwort. */
export interface InvitationSender {
  send(message: InvitationMessage): Promise<void>;
}

// --- Benutzer eines Kunden ---------------------------------------------------------------

export interface TenantUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: Role;
  status: "invited" | "active";
  createdAt: string;
}
export interface UserRepository {
  list(tenantId: string): Promise<TenantUser[]>;
  get(tenantId: string, id: string): Promise<TenantUser | undefined>;
  /** Eindeutigkeit gilt über alle Kunden, weil die Anmeldung per E-Mail läuft. */
  emailExists(email: string): Promise<boolean>;
  add(user: TenantUser): Promise<void>;
  setRole(tenantId: string, id: string, role: Role): Promise<TenantUser | undefined>;
  remove(tenantId: string, id: string): Promise<boolean>;
  /** Aktive Admins (Einladung eingelöst): Der letzte davon darf weder herabgestuft noch entfernt werden. */
  countAdmins(tenantId: string): Promise<number>;
}

// --- Organisation und Logo ---------------------------------------------------------------

export type Organisation = {
  [K in OrganisationSection]: z.infer<(typeof organisationSectionSchemas)[K]>;
};
export interface OrganisationRepository {
  get(tenantId: string): Promise<Organisation | undefined>;
  save(tenantId: string, organisation: Organisation): Promise<void>;
}
export interface LogoInfo {
  mime: string;
  size: number;
  updatedAt: string;
}
export interface LogoStore {
  /** Legt unter generiertem Namen ab, nie unter einem Namen aus der Anfrage (SR-23). */
  put(tenantId: string, logo: { bytes: Buffer; mime: string }, now: Date): Promise<void>;
  get(tenantId: string): Promise<(LogoInfo & { bytes: Buffer }) | undefined>;
  remove(tenantId: string): Promise<boolean>;
}

// --- Protokoll ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  at: string;
  actorId: string;
  actor: string;
  action: string;
  target: string;
}
export interface AuditFilter {
  from?: string | undefined;
  to?: string | undefined;
  actor?: string | undefined;
  action?: string | undefined;
  q?: string | undefined;
}
/** Nur anhängen und lesen. Es gibt absichtlich weder Ändern noch Löschen. */
export interface AuditRepository {
  append(scope: string, entry: AuditEntry): Promise<void>;
  /** Neueste zuerst. `scope` ist die Kunden-ID oder `platform`. */
  query(scope: string, filter: AuditFilter, page: PageRequest): Promise<Page<AuditEntry>>;
}

// --- Konto des Chef-Admins ---------------------------------------------------------------

export interface ChefAccount {
  id: string;
  email: string;
  displayName: string;
}
export interface ChefAccountRepository {
  get(id: string): Promise<ChefAccount | undefined>;
  update(id: string, patch: { displayName: string }): Promise<ChefAccount | undefined>;
}

// --- Einblick des Chef-Admins ------------------------------------------------------------

/** Benutzer eines Kunden aus Sicht des Anbieters. Nie Hashes, Geheimnisse oder Codes. */
export interface CustomerUserSummary {
  id: string;
  name: string;
  email: string;
  totp: "set" | "missing";
  /** Letzte Anmeldung mit zweitem Faktor; `null`: noch nie. */
  lastLoginAt: string | null;
}
export type ChefLoginMethod = "totp" | "recovery" | "setup" | "password_failed" | "code_failed";
export interface ChefSecurity {
  passwordChangedAt: string | null;
  totpSetUpAt: string | null;
  unusedRecoveryCodes: number;
  sessions: { id: string; since: string; current: boolean }[];
  logins: { id: string; at: string; method: ChefLoginMethod; success: boolean }[];
}
/**
 * Was der Chef-Admin über Benutzer und Sitzungen sehen und tun darf, ohne in Kundendaten zu schauen. `actorId` kommt
 * aus der Sitzung; die Postgres-Variante prüft ihn in der Datenbank (SR-10). Ohne Chef-Admin ist das Ergebnis leer
 * bzw. `false` (fail closed).
 */
export interface ChefOversight {
  /** Aktive Benutzer des Kunden (Name, E-Mail, Stand des zweiten Faktors, letzte Anmeldung). */
  customerUsers(actorId: string, tenantId: string): Promise<CustomerUserSummary[]>;
  /** `currentTokenHash`: SHA-256 (hex) des Sitzungs-Cookies dieser Anfrage; `null`, wenn keines vorliegt. */
  security(actorId: string, currentTokenHash: string | null): Promise<ChefSecurity | undefined>;
  /** Beendet eine andere Sitzung des eigenen Kontos. `false`: unbekannt, fremd oder die aktuelle. */
  endSession(actorId: string, sessionId: string, currentTokenHash: string | null): Promise<boolean>;
}

// --- Schlüsselrotation -------------------------------------------------------------------

export type RotationKind = "mail" | "totp";
export interface RotationOutcome {
  rotated: number;
  /** IDs, die sich nicht umschlüsseln liessen. Nie Schlüssel oder Klartext. */
  failed: string[];
  aborted: boolean;
}
export interface RotationStatus {
  /** False: für diese Art ist kein Schlüsselring konfiguriert (Mail ohne MAIL_ENCRYPTION_KEYS). */
  configured: boolean;
  lastRunAt: string | null;
  /** Aktuell nicht entschlüsselbare Objekte aus dem letzten Lauf (nur IDs). */
  unreadable: string[];
}
/**
 * Rotation der Geheimnisse aller Kunden (Mail-Zugangsdaten, TOTP) durch den Chef-Admin. `actorId` kommt aus der
 * Sitzung; die Postgres-Variante prüft ihn in der Datenbank (SR-10). Der Chef-Admin sieht dabei nie Klartext oder Kundendaten.
 */
export interface RotationControl {
  /** `undefined`, wenn die Art nicht konfiguriert ist. */
  run(actorId: string, kind: RotationKind): Promise<RotationOutcome | undefined>;
  status(actorId: string): Promise<Record<RotationKind, RotationStatus>>;
}

export interface Platform {
  tenants: TenantRepository;
  invitations: InvitationRepository;
  invitationSender: InvitationSender;
  users: UserRepository;
  organisations: OrganisationRepository;
  logos: LogoStore;
  /** Protokoll der Kunden. Das Protokoll des Chef-Admins liegt getrennt in `platformAudit`. */
  audit: AuditRepository;
  platformAudit: AuditRepository;
  chefs: ChefAccountRepository;
  oversight: ChefOversight;
  rotation: RotationControl;
  principal: PrincipalResolver;
  clock: () => Date;
}
