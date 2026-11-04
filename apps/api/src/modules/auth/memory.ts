import { randomUUID } from "node:crypto";
import type {
  AuditEvent,
  AuditRepo,
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

const copyUser = (u: User): User => ({ ...u, recoveryCodeHashes: [...u.recoveryCodeHashes] });

export class MemoryUserRepo implements UserRepo {
  private readonly users = new Map<string, User>();

  /** Nur Testhilfe, kein Teil des Interfaces. */
  add(partial: Partial<User> & Pick<User, "email" | "passwordHash">): User {
    const user: User = {
      id: randomUUID(),
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

  findByEmail(email: string) {
    for (const u of this.users.values()) if (u.email === email) return Promise.resolve(copyUser(u));
    return Promise.resolve(null);
  }
  findById(id: string) {
    const u = this.users.get(id);
    return Promise.resolve(u ? copyUser(u) : null);
  }
  setPasswordHash(id: string, hash: string) {
    const u = this.users.get(id);
    if (u) u.passwordHash = hash;
    return Promise.resolve();
  }
  enrollTotp(id: string, secretEnc: string, counter: number, recoveryHashes: string[]) {
    const u = this.users.get(id);
    if (!u || u.totpSecretEnc) return Promise.resolve(false);
    u.totpSecretEnc = secretEnc;
    u.totpLastCounter = counter;
    u.recoveryCodeHashes = [...recoveryHashes];
    return Promise.resolve(true);
  }
  clearTotp(id: string) {
    const u = this.users.get(id);
    if (u) {
      u.totpSecretEnc = null;
      u.totpLastCounter = null;
      u.recoveryCodeHashes = [];
    }
    return Promise.resolve();
  }
  advanceTotpCounter(id: string, counter: number) {
    const u = this.users.get(id);
    if (!u || (u.totpLastCounter !== null && counter <= u.totpLastCounter)) {
      return Promise.resolve(false);
    }
    u.totpLastCounter = counter;
    return Promise.resolve(true);
  }
  consumeRecoveryCode(id: string, hash: string) {
    const u = this.users.get(id);
    const i = u ? u.recoveryCodeHashes.indexOf(hash) : -1;
    if (!u || i < 0) return Promise.resolve(false);
    u.recoveryCodeHashes.splice(i, 1);
    return Promise.resolve(true);
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
  touch(id: string, lastSeenAt: Date) {
    const s = this.sessions.get(id);
    if (s) s.lastSeenAt = lastSeenAt;
    return Promise.resolve();
  }
  setPendingTotp(id: string, secretEnc: string) {
    const s = this.sessions.get(id);
    if (s) s.pendingTotpSecretEnc = secretEnc;
    return Promise.resolve();
  }
  recordMfaFailure(id: string) {
    const s = this.sessions.get(id);
    if (!s) return Promise.resolve(Number.MAX_SAFE_INTEGER);
    return Promise.resolve(++s.failedMfaAttempts);
  }
  revoke(id: string) {
    this.sessions.delete(id);
    return Promise.resolve();
  }
  revokeAllForUser(userId: string, exceptId?: string) {
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
  list(filter: { userId?: string; limit?: number } = {}) {
    const { userId, limit = 100 } = filter;
    const hits = this.events.filter(
      (e) => !userId || e.actorUserId === userId || e.targetUserId === userId,
    );
    return Promise.resolve(hits.slice(-limit).reverse());
  }
}
