import { SlugTakenError } from "./helpers.js";
import type {
  AuditEntry,
  AuditFilter,
  AuditRepository,
  ChefAccount,
  ChefAccountRepository,
  ChefOversight,
  ChefSecurity,
  CustomerUserSummary,
  Invitation,
  InvitationMessage,
  InvitationRepository,
  InvitationSender,
  LogoInfo,
  LogoStore,
  NewTenant,
  Organisation,
  OrganisationRepository,
  Page,
  PageRequest,
  RotationControl,
  Tenant,
  TenantPatch,
  TenantRepository,
  TenantUser,
  UserRepository,
} from "./types.js";

// In-Memory-Implementierungen der Repository-Schnittstellen (Entwicklung und Tests).
// Sie geben Kopien zurück, damit Aufrufer den Speicher nicht versehentlich verändern.
// Daten gehen beim Neustart verloren. Produktiv gelten die Postgres-Repositories (postgres.ts).

const copy = <T>(v: T): T => structuredClone(v);
const slice = <T>(all: T[], { limit, offset }: PageRequest): Page<T> => ({
  items: all.slice(offset, offset + limit).map(copy),
  total: all.length,
});

export class MemoryTenants implements TenantRepository {
  private rows = new Map<string, Omit<Tenant, "userCount">>();
  private nextLicence = 1;
  /** Benutzerzahl aus dem Benutzerspeicher der Platform; ohne ihn 0. */
  constructor(private readonly users?: Pick<UserRepository, "list">) {}
  private slugTaken(slug: string | null | undefined, exceptId?: string) {
    return !!slug && [...this.rows.values()].some((t) => t.slug === slug && t.id !== exceptId);
  }
  private async view(t: Omit<Tenant, "userCount">): Promise<Tenant> {
    const active = (await this.users?.list(t.id))?.filter((u) => u.status === "active") ?? [];
    return copy({ ...t, userCount: active.length });
  }
  async create(_actorId: string, tenant: NewTenant) {
    if (this.slugTaken(tenant.slug)) throw new SlugTakenError();
    this.rows.set(
      tenant.id,
      copy({
        ...tenant,
        licenceNumber: `L-${String(this.nextLicence++).padStart(4, "0")}`,
        licenceStart: tenant.licenceStart ?? null,
        modules: tenant.modules ?? null,
      }),
    );
  }
  async get(id: string) {
    const t = this.rows.get(id);
    return t && this.view(t);
  }
  async list(
    _actorId: string,
    filter: { status?: Tenant["status"] | undefined; q?: string | undefined },
    page: PageRequest,
  ) {
    const q = filter.q?.toLowerCase();
    const all = [...this.rows.values()]
      .filter(
        (t) =>
          (!filter.status || t.status === filter.status) &&
          (!q || t.name.toLowerCase().includes(q)),
      )
      .sort((a, b) => a.name.localeCompare(b.name, "de"));
    const { items, total } = slice(all, page);
    return { items: await Promise.all(items.map((t) => this.view(t))), total };
  }
  async update(_actorId: string, id: string, patch: TenantPatch) {
    const t = this.rows.get(id);
    if (!t) return undefined;
    if (this.slugTaken(patch.slug, id)) throw new SlugTakenError();
    Object.assign(t, patch);
    return this.view(t);
  }
}

export class MemoryInvitations implements InvitationRepository {
  private rows: Invitation[] = [];
  async create(invitation: Invitation) {
    this.rows.push(copy(invitation));
  }
  /** Nur lesen (für die Passwortregeln beim Einlösen); nicht Teil des Repository-Vertrags. */
  async peek(tokenHash: string, now: Date) {
    const inv = this.rows.find((i) => i.tokenHash === tokenHash);
    return inv && !inv.consumedAt && new Date(inv.expiresAt) > now ? copy(inv) : undefined;
  }
  async consume(tokenHash: string, now: Date) {
    const inv = this.rows.find((i) => i.tokenHash === tokenHash);
    if (!inv || inv.consumedAt || new Date(inv.expiresAt) <= now) return undefined;
    inv.consumedAt = now.toISOString();
    return copy(inv);
  }
  async latestForTenant(tenantId: string) {
    const inv = this.rows.filter((i) => i.tenantId === tenantId).at(-1);
    return inv && copy(inv);
  }
}

/** Sammelt Einladungen im Speicher. Der echte Versand folgt mit dem Mail-Modul. */
export class MemoryInvitationOutbox implements InvitationSender {
  readonly sent: InvitationMessage[] = [];
  async send(message: InvitationMessage) {
    this.sent.push({ ...message });
  }
}

export class MemoryUsers implements UserRepository {
  private rows = new Map<string, TenantUser>();
  async list(tenantId: string) {
    return [...this.rows.values()]
      .filter((u) => u.tenantId === tenantId)
      .sort((a, b) => a.name.localeCompare(b.name, "de"))
      .map(copy);
  }
  async get(tenantId: string, id: string) {
    const u = this.rows.get(id);
    return u && u.tenantId === tenantId ? copy(u) : undefined;
  }
  async emailExists(email: string) {
    return [...this.rows.values()].some((u) => u.email === email);
  }
  async add(user: TenantUser) {
    this.rows.set(user.id, copy(user));
  }
  async setRole(tenantId: string, id: string, role: TenantUser["role"]) {
    const u = this.rows.get(id);
    if (!u || u.tenantId !== tenantId) return undefined;
    u.role = role;
    return copy(u);
  }
  async remove(tenantId: string, id: string) {
    return this.rows.get(id)?.tenantId === tenantId && this.rows.delete(id);
  }
  async countAdmins(tenantId: string) {
    return [...this.rows.values()].filter(
      (u) => u.tenantId === tenantId && u.role === "admin" && u.status === "active",
    ).length;
  }
}

export class MemoryOrganisations implements OrganisationRepository {
  private rows = new Map<string, Organisation>();
  async get(tenantId: string) {
    const o = this.rows.get(tenantId);
    return o && copy(o);
  }
  async save(tenantId: string, organisation: Organisation) {
    this.rows.set(tenantId, copy(organisation));
  }
}

export class MemoryLogos implements LogoStore {
  private rows = new Map<string, LogoInfo & { bytes: Buffer }>();
  async put(tenantId: string, logo: { bytes: Buffer; mime: string }, now: Date) {
    this.rows.set(tenantId, {
      bytes: Buffer.from(logo.bytes),
      mime: logo.mime,
      size: logo.bytes.length,
      updatedAt: now.toISOString(),
    });
  }
  async get(tenantId: string) {
    return this.rows.get(tenantId);
  }
  async remove(tenantId: string) {
    return this.rows.delete(tenantId);
  }
}

export class MemoryAudit implements AuditRepository {
  private rows: { scope: string; entry: AuditEntry }[] = [];
  async append(scope: string, entry: AuditEntry) {
    this.rows.push({ scope, entry: copy(entry) });
  }
  async query(scope: string, f: AuditFilter, page: PageRequest) {
    const q = f.q?.toLowerCase();
    const actor = f.actor?.toLowerCase();
    const all = this.rows
      .filter((r) => r.scope === scope)
      .map((r) => r.entry)
      .filter(
        (e) =>
          (!f.from || e.at >= f.from) &&
          (!f.to || e.at <= f.to) &&
          (!actor || e.actor.toLowerCase().includes(actor)) &&
          (!f.action || e.action === f.action) &&
          (!q || `${e.action} ${e.target} ${e.actor}`.toLowerCase().includes(q)),
      )
      .reverse();
    return slice(all, page);
  }
}

export class MemoryChefs implements ChefAccountRepository {
  private rows = new Map<string, ChefAccount>();
  constructor(accounts: ChefAccount[] = []) {
    for (const a of accounts) this.rows.set(a.id, copy(a));
  }
  async get(id: string) {
    const a = this.rows.get(id);
    return a && copy(a);
  }
  async update(id: string, patch: { displayName: string }) {
    const a = this.rows.get(id);
    if (!a) return undefined;
    a.displayName = patch.displayName;
    return copy(a);
  }
}

/**
 * Einblick des Chef-Admins im Speicher (Entwicklung und Tests): Benutzer, Sitzungen und Anmeldungen kommen aus dem
 * Aufruf von `seed…`; ohne Vorgabe sind sie leer. Die Auth-Dienste im Speicher teilen ihren Stand nicht mit der Platform.
 */
export class MemoryOversight implements ChefOversight {
  private users = new Map<string, CustomerUserSummary[]>();
  private chefSecurity = new Map<string, ChefSecurity & { tokenHashes: Record<string, string> }>();
  seedUsers(tenantId: string, users: CustomerUserSummary[]) {
    this.users.set(tenantId, copy(users));
  }
  /** `tokenHashes`: Sitzungs-ID zu Token-Hash, damit sich «aktuell» bestimmen lässt. */
  seedSecurity(actorId: string, security: ChefSecurity, tokenHashes: Record<string, string> = {}) {
    this.chefSecurity.set(actorId, { ...copy(security), tokenHashes });
  }
  async customerUsers(_actorId: string, tenantId: string) {
    return copy(this.users.get(tenantId) ?? []);
  }
  async security(actorId: string, currentTokenHash: string | null) {
    const s = this.chefSecurity.get(actorId);
    if (!s) return undefined;
    const { tokenHashes, ...rest } = copy(s);
    return {
      ...rest,
      sessions: rest.sessions.map((x) => ({
        ...x,
        current: currentTokenHash !== null && tokenHashes[x.id] === currentTokenHash,
      })),
    };
  }
  async endSession(actorId: string, sessionId: string, currentTokenHash: string | null) {
    const s = this.chefSecurity.get(actorId);
    const hit = s?.sessions.find((x) => x.id === sessionId);
    if (!s || !hit) return false;
    if (currentTokenHash !== null && s.tokenHashes[sessionId] === currentTokenHash) return false;
    s.sessions = s.sessions.filter((x) => x.id !== sessionId);
    return true;
  }
}

/** Ohne Datenbank gibt es keine gespeicherten Geheimnisse: keine Art ist konfiguriert. */
export const noRotation: RotationControl = {
  run: async () => undefined,
  status: async () => ({
    mail: { configured: false, lastRunAt: null, unreadable: [] },
    totp: { configured: false, lastRunAt: null, unreadable: [] },
  }),
};
