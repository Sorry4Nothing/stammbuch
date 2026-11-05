import { randomUUID } from "node:crypto";
import { MAX_INVITATION_FAILURES } from "./types.js";
import type {
  AuditEvent,
  AuditRepo,
  InvitationRepo,
  PasswordResetRepo,
  Session,
  SessionRepo,
  ThrottleRepo,
  ThrottleState,
  User,
  UserRepo,
} from "./types.js";

/**
 * In-Memory-Implementierungen für Tests und lokale Entwicklung. Sie dokumentieren das
 * erwartete Verhalten (Atomarität der CAS-Operationen), das die Postgres-Variante einhalten muss.
 * Alle Methoden geben Kopien zurück, damit Aufrufer den Speicher nicht an den Repos vorbei ändern.
 */

/** Mandant der Testbenutzer, wenn nichts anderes angegeben ist. */
export const MEMORY_TENANT = "00000000-0000-4000-8000-0000000000aa";

// Der Speicher kennt nur einen Namensraum; die Mandantenparameter der Ports sind hier ohne Wirkung.
const copyUser = (u: User): User => ({ ...u, recoveryCodeHashes: [...u.recoveryCodeHashes] });

export class MemoryUserRepo implements UserRepo {
  private readonly users = new Map<string, User>();

  /** Nur Testhilfe, kein Teil des Interfaces. */
  add(partial: Partial<User> & Pick<User, "email" | "passwordHash">): User {
    const user: User = {
      id: randomUUID(),
      tenantId: MEMORY_TENANT,
      name: partial.email.split("@")[0] ?? partial.email,
      role: "user",
      totpSecretEnc: null,
      totpLastCounter: null,
      recoveryCodeHashes: [],
      disabled: false,
      createdAt: new Date(),
      ...partial,
    };
    this.users.set(user.id, user);
    return copyUser(user);
  }

  /** Nur Testhilfe: Konto sperren. */
  disable(id: string) {
    const u = this.users.get(id);
    if (u) u.disabled = true;
  }

  /** Einladung eingelöst: Passwort setzen und das Konto freigeben. Nur Testhilfe und Speicher-Variante. */
  activate(id: string, passwordHash: string): User | null {
    const u = this.users.get(id);
    if (!u || !u.disabled) return null;
    u.passwordHash = passwordHash;
    u.disabled = false;
    return copyUser(u);
  }

  findByEmail(email: string) {
    for (const u of this.users.values()) if (u.email === email) return Promise.resolve(copyUser(u));
    return Promise.resolve(null);
  }
  findById(_tenantId: string, id: string) {
    const u = this.users.get(id);
    return Promise.resolve(u ? copyUser(u) : null);
  }
  findForMfaReset(actorId: string, targetId: string) {
    const actor = this.users.get(actorId);
    const u = this.users.get(targetId);
    return Promise.resolve(
      u && actor?.role === "chief_admin" && !actor.disabled ? copyUser(u) : null,
    );
  }
  setPasswordHash(_tenantId: string, id: string, hash: string) {
    const u = this.users.get(id);
    if (u) u.passwordHash = hash;
    return Promise.resolve();
  }
  setName(_tenantId: string, id: string, name: string) {
    const u = this.users.get(id);
    if (u) u.name = name;
    return Promise.resolve();
  }
  enrollTotp(
    _tenantId: string,
    id: string,
    secretEnc: string,
    counter: number,
    recoveryHashes: string[],
  ) {
    const u = this.users.get(id);
    if (!u || u.totpSecretEnc) return Promise.resolve(false);
    u.totpSecretEnc = secretEnc;
    u.totpLastCounter = counter;
    u.recoveryCodeHashes = [...recoveryHashes];
    return Promise.resolve(true);
  }
  clearTotp(_tenantId: string, id: string) {
    const u = this.users.get(id);
    if (u) {
      u.totpSecretEnc = null;
      u.totpLastCounter = null;
      u.recoveryCodeHashes = [];
    }
    return Promise.resolve();
  }
  advanceTotpCounter(_tenantId: string, id: string, counter: number) {
    const u = this.users.get(id);
    if (!u || (u.totpLastCounter !== null && counter <= u.totpLastCounter)) {
      return Promise.resolve(false);
    }
    u.totpLastCounter = counter;
    return Promise.resolve(true);
  }
  consumeRecoveryCode(_tenantId: string, id: string, hash: string) {
    const u = this.users.get(id);
    const i = u ? u.recoveryCodeHashes.indexOf(hash) : -1;
    if (!u || i < 0) return Promise.resolve(false);
    u.recoveryCodeHashes.splice(i, 1);
    return Promise.resolve(true);
  }
  replaceRecoveryCodes(_tenantId: string, id: string, hashes: string[]) {
    const u = this.users.get(id);
    if (u) u.recoveryCodeHashes = [...hashes];
    return Promise.resolve();
  }
}

/** Die Einladungen der Platform (Speicher-Variante), wie sie `invite()` anlegt. */
export interface InvitationSource {
  peek(tokenHash: string, now: Date): Promise<InvitationRecord | undefined>;
  consume(tokenHash: string, now: Date): Promise<InvitationRecord | undefined>;
}
export interface InvitationRecord {
  tenantId: string;
  email: string;
  role: "admin" | "user";
  userId: string | null;
  /** Name des ersten Admins; ohne Angabe der Teil der Adresse vor dem @. */
  name?: string | null | undefined;
}

/**
 * Einladungen einlösen im Speicher: wie die Datenbankfunktion (gültig, unverbraucht, Adresse frei bzw. Konto noch
 * gesperrt), aber ohne Kundenstatus. Ein Benutzer-Eintrag wird mit dem Passwort freigegeben, sonst neu angelegt.
 */
export class MemoryInvitationRepo implements InvitationRepo {
  private readonly failures = new Map<string, number>();

  constructor(
    private readonly source: InvitationSource,
    private readonly users: MemoryUserRepo,
  ) {}

  private locked(tokenHash: string) {
    return (this.failures.get(tokenHash) ?? 0) >= MAX_INVITATION_FAILURES;
  }

  recordFailure(tokenHash: string) {
    this.failures.set(tokenHash, (this.failures.get(tokenHash) ?? 0) + 1);
    return Promise.resolve();
  }

  private async usable(inv: InvitationRecord) {
    if (inv.userId) return (await this.users.findById(inv.tenantId, inv.userId))?.disabled === true;
    return (await this.users.findByEmail(inv.email)) === null;
  }

  async peek(tokenHash: string, now: Date) {
    const inv = this.locked(tokenHash) ? undefined : await this.source.peek(tokenHash, now);
    return inv && (await this.usable(inv)) ? { email: inv.email, tenantId: inv.tenantId } : null;
  }

  async redeem(tokenHash: string, passwordHash: string, now: Date) {
    const inv = this.locked(tokenHash) ? undefined : await this.source.peek(tokenHash, now);
    if (!inv || !(await this.usable(inv))) return null;
    if (!(await this.source.consume(tokenHash, now))) return null;
    const user = inv.userId
      ? this.users.activate(inv.userId, passwordHash)
      : this.users.add({
          email: inv.email,
          passwordHash,
          tenantId: inv.tenantId,
          ...(inv.name ? { name: inv.name } : {}),
        });
    return user ? { userId: user.id, tenantId: inv.tenantId, role: inv.role } : null;
  }
}

/** «Passwort vergessen» im Speicher: wie die Datenbankfunktionen (3 Tokens pro Stunde, nur das jüngste gilt, einmalig). */
export class MemoryPasswordResetRepo implements PasswordResetRepo {
  private readonly rows: {
    userId: string;
    tenantId: string;
    tokenHash: string;
    createdAt: Date;
    expiresAt: Date;
    used: boolean;
  }[] = [];

  constructor(private readonly users: MemoryUserRepo) {}

  async create(email: string, tokenHash: string, now: Date, expiresAt: Date) {
    const user = await this.users.findByEmail(email);
    if (!user || user.disabled) return null;
    const mine = this.rows.filter((r) => r.userId === user.id);
    if (mine.filter((r) => r.createdAt.getTime() > now.getTime() - 3_600_000).length >= 3) {
      return null;
    }
    for (const r of mine) r.used = true;
    this.rows.push({
      userId: user.id,
      tenantId: user.tenantId,
      tokenHash,
      createdAt: now,
      expiresAt,
      used: false,
    });
    return { userId: user.id, tenantId: user.tenantId };
  }

  /** Prüfen und (bei `take`) verbrauchen ohne `await` dazwischen: gleichzeitige Aufrufe gewinnen nicht beide. */
  private async live(tokenHash: string, now: Date, take: boolean) {
    const r = this.rows.find((x) => x.tokenHash === tokenHash);
    const user = r ? await this.users.findById(r.tenantId, r.userId) : null;
    if (!r || !user || user.disabled || r.used || r.expiresAt <= now) return null;
    if (take) r.used = true;
    return user;
  }

  async peek(tokenHash: string, now: Date) {
    const user = await this.live(tokenHash, now, false);
    return user ? { userId: user.id, tenantId: user.tenantId, email: user.email } : null;
  }

  async consume(tokenHash: string, now: Date) {
    const user = await this.live(tokenHash, now, true);
    return user ? { userId: user.id, tenantId: user.tenantId } : null;
  }
}

export class MemorySessionRepo implements SessionRepo {
  readonly sessions = new Map<string, Session>();

  create(session: Session) {
    this.sessions.set(session.id, { ...session });
    return Promise.resolve();
  }
  findById(id: string) {
    const s = this.sessions.get(id);
    return Promise.resolve(s ? { ...s } : null);
  }
  touch(_tenantId: string, id: string, lastSeenAt: Date) {
    const s = this.sessions.get(id);
    if (s) s.lastSeenAt = lastSeenAt;
    return Promise.resolve();
  }
  setPendingTotp(_tenantId: string, id: string, secretEnc: string) {
    const s = this.sessions.get(id);
    if (s) s.pendingTotpSecretEnc = secretEnc;
    return Promise.resolve();
  }
  recordMfaFailure(_tenantId: string, id: string) {
    const s = this.sessions.get(id);
    if (!s) return Promise.resolve(Number.MAX_SAFE_INTEGER);
    return Promise.resolve(++s.failedMfaAttempts);
  }
  revoke(_tenantId: string, id: string) {
    this.sessions.delete(id);
    return Promise.resolve();
  }
  revokeAllForUser(_tenantId: string, userId: string, exceptId?: string) {
    for (const [id, s] of this.sessions)
      if (s.userId === userId && id !== exceptId) this.sessions.delete(id);
    return Promise.resolve();
  }
  deleteExpired(now: Date) {
    let n = 0;
    for (const [id, s] of this.sessions) {
      if (s.expiresAt <= now) {
        this.sessions.delete(id);
        n++;
      }
    }
    return Promise.resolve(n);
  }
}

export class MemoryThrottleRepo implements ThrottleRepo {
  private readonly map = new Map<string, ThrottleState>();

  get(key: string) {
    const s = this.map.get(key);
    return Promise.resolve(s ? { ...s } : null);
  }
  update(key: string, fn: (prev: ThrottleState | null) => ThrottleState) {
    const next = fn(this.map.get(key) ?? null);
    this.map.set(key, next);
    return Promise.resolve({ ...next });
  }
  clear(key: string) {
    this.map.delete(key);
    return Promise.resolve();
  }
}

export class MemoryAuditRepo implements AuditRepo {
  readonly events: AuditEvent[] = [];

  append(event: AuditEvent) {
    this.events.push({ ...event });
    return Promise.resolve();
  }
  list(filter: { tenantId?: string; userId?: string; limit?: number } = {}) {
    const { tenantId, userId, limit = 100 } = filter;
    const hits = this.events.filter(
      (e) =>
        (!tenantId || e.tenantId === tenantId) &&
        (!userId || e.actorUserId === userId || e.targetUserId === userId),
    );
    return Promise.resolve(hits.slice(-limit).reverse());
  }
}
