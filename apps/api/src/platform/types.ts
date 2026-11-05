import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import type { OrganisationSection, Role, organisationSectionSchemas } from "@stammbuch/shared";

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
}
export interface TenantRepository {
  /**
   * `actorId`: der Chef-Admin aus der Sitzung. Die Postgres-Variante prüft ihn in der Datenbank (SR-10).
   * `create` und `update` werfen `SlugTakenError`, wenn der Slug schon vergeben ist.
   */
  create(actorId: string, tenant: Tenant): Promise<void>;
  get(id: string): Promise<Tenant | undefined>;
  list(
    actorId: string,
    filter: { status?: TenantStatus | undefined; q?: string | undefined },
    page: PageRequest,
  ): Promise<Page<Tenant>>;
  update(
    actorId: string,
    id: string,
    patch: Partial<Omit<Tenant, "id" | "createdAt">>,
  ): Promise<Tenant | undefined>;
}

// --- Einladungen -------------------------------------------------------------------------

export interface Invitation {
  id: string;
  tenantId: string;
  email: string;
  role: Role;
  /** Gesetzt, wenn der Benutzer-Eintrag schon existiert (Einladung aus den Einstellungen). */
  userId: string | null;
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
  principal: PrincipalResolver;
  clock: () => Date;
}
