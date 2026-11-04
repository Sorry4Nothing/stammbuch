import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthConfig } from "./config.js";
import { base32Encode } from "./base32.js";
import {
  builtinBlocklist,
  checkPasswordPolicy,
  createPasswordHasher,
  type PasswordHasher,
  type PasswordProblem,
} from "./password.js";
import { generateRecoveryCodes, hashRecoveryCode } from "./recovery.js";
import { decryptSecret, deriveKey, encryptSecret, hmacHex } from "./secretbox.js";
import { lockedForSeconds, nextFailureState } from "./throttle.js";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./totp.js";
import type {
  AuditEvent,
  AuditRepo,
  MailPort,
  PasswordBlocklist,
  SecurityNotice,
  Session,
  SessionRepo,
  ThrottleRepo,
  User,
  UserRepo,
} from "./types.js";

export interface AuthDeps {
  config: AuthConfig;
  users: UserRepo;
  sessions: SessionRepo;
  throttle: ThrottleRepo;
  audit: AuditRepo;
  mail: MailPort;
  blocklist?: PasswordBlocklist;
  hasher?: PasswordHasher;
  clock?: () => Date;
}

export interface SessionContext {
  session: Session;
  user: User;
}

/** Nach 5 falschen zweiten Faktoren in einer Sitzung ist sie verbraucht; neu anmelden. */
export const MAX_MFA_ATTEMPTS_PER_SESSION = 5;

export type Issued = { token: string; session: Session };
type Locked = { kind: "locked"; retryAfterSeconds: number };
type Invalid = { kind: "invalid" };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const normalizeEmail = (e: string) => e.normalize("NFKC").trim().toLowerCase();

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class AuthService {
  readonly hasher: PasswordHasher;
  private readonly now: () => Date;
  private readonly accountKey: Buffer;
  private readonly recoveryKey: Buffer;

  constructor(private readonly d: AuthDeps) {
    this.hasher = d.hasher ?? createPasswordHasher(d.config.peppers, d.config.argon2);
    this.now = d.clock ?? (() => new Date());
    this.accountKey = deriveKey(d.config.totpKey, "account-key");
    this.recoveryKey = deriveKey(d.config.totpKey, "recovery-code");
  }

  // ---------------------------------------------------------------- Hilfen

  /** Konto-Schlüssel für Sperre und Log: kein Klartext, auch für unbekannte E-Mails. */
  private keyOf(email: string) {
    return hmacHex(this.accountKey, email);
  }

  private async log(
    type: AuditEvent["type"],
    outcome: AuditEvent["outcome"],
    ip: string,
    actor: string | null,
    target: string | null,
    detail?: AuditEvent["detail"],
  ) {
    // Schlägt das Protokollieren fehl, schlägt die Aktion fehl (SR-54, SR-52).
    await this.d.audit.append({
      at: this.now(),
      type,
      outcome,
      actorUserId: actor,
      targetUserId: target,
      ip,
      ...(detail ? { detail } : {}),
    });
  }

  private async notify(notice: SecurityNotice, ip: string, userId: string) {
    try {
      await this.d.mail.sendSecurityNotice(notice);
    } catch {
      // Die Aktion ist bereits erfolgt; der Ausfall wird protokolliert, nicht verschluckt.
      await this.log("notice_failed", "failure", ip, null, userId, { kind: notice.kind });
    }
  }

  private async issue(
    userId: string,
    stage: Session["stage"],
    extra: Partial<Session> = {},
  ): Promise<Issued> {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const ttl = stage === "pending" ? this.d.config.pendingMs : this.d.config.sessionAbsoluteMs;
    const session: Session = {
      id: sha256(token),
      userId,
      stage,
      csrfToken: randomBytes(24).toString("base64url"),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + ttl),
      pendingTotpSecretEnc: null,
      failedMfaAttempts: 0,
      ...extra,
    };
    await this.d.sessions.create(session);
    return { token, session };
  }

  private async lockState(key: string): Promise<Locked | null> {
    const secs = lockedForSeconds(await this.d.throttle.get(key), this.now());
    return secs > 0 ? { kind: "locked", retryAfterSeconds: secs } : null;
  }

  private recordFailure(key: string) {
    return this.d.throttle.update(key, (prev) => nextFailureState(prev, this.now()));
  }

  // ---------------------------------------------------------------- Sitzung

  /** Löst das Cookie-Token serverseitig auf; Rollen kommen immer aus der DB (SR-13). */
  async resolve(token: string | undefined, ip: string): Promise<SessionContext | null> {
    if (!token || token.length > 128) return null;
    const session = await this.d.sessions.findById(sha256(token));
    if (!session) return null;
    const now = this.now();
    const idle = now.getTime() - session.lastSeenAt.getTime() > this.d.config.sessionIdleMs;
    const user =
      session.expiresAt <= now || idle ? null : await this.d.users.findById(session.userId);
    if (!user || user.disabled) {
      await this.d.sessions.revoke(session.id);
      await this.log("session_rejected", "failure", ip, null, session.userId);
      return null;
    }
    // Nicht bei jeder Anfrage schreiben: höchstens einmal pro Minute.
    if (now.getTime() - session.lastSeenAt.getTime() > 60_000) {
      await this.d.sessions.touch(session.id, now);
    }
    return { session, user };
  }

  verifyCsrf(ctx: SessionContext, header: string | undefined): boolean {
    return !!header && safeEqual(header, ctx.session.csrfToken);
  }

  async revokeToken(token: string | undefined) {
    if (token) await this.d.sessions.revoke(sha256(token));
  }

  async logout(ctx: SessionContext, ip: string) {
    await this.d.sessions.revoke(ctx.session.id);
    await this.log("logout", "success", ip, ctx.user.id, ctx.user.id);
  }

  // ---------------------------------------------------------------- Schritt 1: Passwort

  async login(
    input: { email: string; password: string; previousToken?: string | undefined },
    ip: string,
  ): Promise<
    Locked | Invalid | { kind: "ok"; issued: Issued; next: "mfa_required" | "mfa_setup_required" }
  > {
    const email = normalizeEmail(input.email);
    const key = this.keyOf(email);

    const locked = await this.lockState(key);
    if (locked) {
      await this.log("login_locked", "failure", ip, null, null, { account: key.slice(0, 16) });
      return locked;
    }

    const user = await this.d.users.findByEmail(email);
    // Gleicher Hash-Aufwand für existierende und nicht existierende Konten (SR-05).
    let ok = false;
    if (user) ok = await this.hasher.verify(user.passwordHash, input.password);
    else await this.hasher.verifyAbsent(input.password);

    if (!user || !ok || user.disabled) {
      await this.recordFailure(key);
      await this.log("login_failure", "failure", ip, null, user?.id ?? null, {
        account: key.slice(0, 16),
      });
      return { kind: "invalid" };
    }

    // Passwort stimmt: ggf. mit neuem Pepper/neuen Parametern neu hashen (best effort).
    if (this.hasher.needsRehash(user.passwordHash)) {
      await this.d.users.setPasswordHash(user.id, await this.hasher.hash(input.password));
    }

    // Rotation: eine mitgeschickte alte Sitzung wird ungültig, die neue hat eine frische ID.
    await this.revokeToken(input.previousToken);
    const issued = await this.issue(user.id, "pending");
    await this.log("login_success", "success", ip, user.id, user.id, { stage: "password" });
    return {
      kind: "ok",
      issued,
      next: user.totpSecretEnc ? "mfa_required" : "mfa_setup_required",
    };
  }

  // ---------------------------------------------------------------- Schritt 2: zweiter Faktor

  /** Startet die TOTP-Einrichtung (erster Login oder nach Reset). */
  async beginTotpSetup(ctx: SessionContext) {
    if (ctx.session.stage !== "pending" || ctx.user.totpSecretEnc) return null;
    const secret = generateTotpSecret();
    await this.d.sessions.setPendingTotp(
      ctx.session.id,
      encryptSecret(this.d.config.totpKey, ctx.user.id, secret),
    );
    return {
      secret: base32Encode(secret),
      otpauthUri: otpauthUri(secret, ctx.user.email, this.d.config.issuer),
    };
  }

  private async mfaFailure(ctx: SessionContext, ip: string, type: AuditEvent["type"]) {
    await this.recordFailure(this.keyOf(ctx.user.email));
    const n = await this.d.sessions.recordMfaFailure(ctx.session.id);
    if (n >= MAX_MFA_ATTEMPTS_PER_SESSION) await this.d.sessions.revoke(ctx.session.id);
    await this.log(type, "failure", ip, ctx.user.id, ctx.user.id);
    return { kind: "invalid" } as const;
  }

  private async promote(ctx: SessionContext) {
    await this.d.throttle.clear(this.keyOf(ctx.user.email));
    await this.d.sessions.revoke(ctx.session.id);
    return this.issue(ctx.user.id, "full"); // Rotation: neue ID mit vollem Zugriff
  }

  /** TOTP-Code prüfen (Anmeldung) oder bestätigen (Einrichtung). */
  async completeMfa(
    ctx: SessionContext,
    code: string,
    ip: string,
  ): Promise<
    | Locked
    | Invalid
    | { kind: "ok"; issued: Issued; recoveryCodes?: string[]; remainingRecoveryCodes: number }
  > {
    if (ctx.session.stage !== "pending") return { kind: "invalid" };
    const locked = await this.lockState(this.keyOf(ctx.user.email));
    if (locked) return locked;

    const key = this.d.config.totpKey;
    const nowMs = this.now().getTime();

    if (ctx.session.pendingTotpSecretEnc && !ctx.user.totpSecretEnc) {
      const secret = decryptSecret(key, ctx.user.id, ctx.session.pendingTotpSecretEnc);
      const counter = verifyTotp(secret, code, nowMs);
      if (counter === null) return this.mfaFailure(ctx, ip, "mfa_failure");
      const codes = generateRecoveryCodes();
      const hashes = codes.map((c) => hashRecoveryCode(this.recoveryKey, c));
      const enrolled = await this.d.users.enrollTotp(
        ctx.user.id,
        ctx.session.pendingTotpSecretEnc,
        counter,
        hashes,
      );
      if (!enrolled) return this.mfaFailure(ctx, ip, "mfa_failure");
      const issued = await this.promote(ctx);
      await this.log("mfa_enrolled", "success", ip, ctx.user.id, ctx.user.id);
      await this.log("mfa_success", "success", ip, ctx.user.id, ctx.user.id);
      await this.notify(
        { kind: "mfa_enrolled", to: ctx.user.email, at: this.now() },
        ip,
        ctx.user.id,
      );
      return { kind: "ok", issued, recoveryCodes: codes, remainingRecoveryCodes: codes.length };
    }

    if (!ctx.user.totpSecretEnc) return { kind: "invalid" }; // erst /auth/2fa/setup aufrufen
    const secret = decryptSecret(key, ctx.user.id, ctx.user.totpSecretEnc);
    const counter = verifyTotp(secret, code, nowMs);
    if (counter === null) return this.mfaFailure(ctx, ip, "mfa_failure");
    // Replay-Schutz: derselbe oder ein älterer Zeitschritt wird nie ein zweites Mal akzeptiert.
    if (!(await this.d.users.advanceTotpCounter(ctx.user.id, counter))) {
      return this.mfaFailure(ctx, ip, "mfa_replay");
    }
    const issued = await this.promote(ctx);
    await this.log("mfa_success", "success", ip, ctx.user.id, ctx.user.id);
    return {
      kind: "ok",
      issued,
      remainingRecoveryCodes: ctx.user.recoveryCodeHashes.length,
    };
  }

  /** Anmeldung mit einem Wiederherstellungscode statt TOTP (Einmalverwendung). */
  async useRecoveryCode(
    ctx: SessionContext,
    code: string,
    ip: string,
  ): Promise<Locked | Invalid | { kind: "ok"; issued: Issued; remainingRecoveryCodes: number }> {
    if (ctx.session.stage !== "pending" || !ctx.user.totpSecretEnc) return { kind: "invalid" };
    const locked = await this.lockState(this.keyOf(ctx.user.email));
    if (locked) return locked;

    const used = await this.d.users.consumeRecoveryCode(
      ctx.user.id,
      hashRecoveryCode(this.recoveryKey, code),
    );
    if (!used) return this.mfaFailure(ctx, ip, "recovery_failure");

    const remaining = Math.max(0, ctx.user.recoveryCodeHashes.length - 1);
    const issued = await this.promote(ctx);
    await this.log("recovery_used", "success", ip, ctx.user.id, ctx.user.id, { remaining });
    await this.notify(
      { kind: "recovery_used", to: ctx.user.email, at: this.now(), remaining },
      ip,
      ctx.user.id,
    );
    return { kind: "ok", issued, remainingRecoveryCodes: remaining };
  }

  // ---------------------------------------------------------------- Passwort ändern

  async changePassword(
    ctx: SessionContext,
    input: { currentPassword: string; newPassword: string },
    ip: string,
  ): Promise<
    | Locked
    | Invalid
    | { kind: "weak"; problem: PasswordProblem | "unchanged" }
    | { kind: "ok"; issued: Issued }
  > {
    if (ctx.session.stage !== "full") return { kind: "invalid" };
    const key = this.keyOf(ctx.user.email);
    const locked = await this.lockState(key);
    if (locked) return locked;

    if (!(await this.hasher.verify(ctx.user.passwordHash, input.currentPassword))) {
      await this.recordFailure(key);
      await this.log("password_change_failure", "failure", ip, ctx.user.id, ctx.user.id);
      return { kind: "invalid" };
    }
    if (input.newPassword === input.currentPassword) return { kind: "weak", problem: "unchanged" };
    const problem = await checkPasswordPolicy(
      input.newPassword,
      ctx.user.email,
      this.d.blocklist ?? builtinBlocklist,
    );
    if (problem) return { kind: "weak", problem };

    await this.d.users.setPasswordHash(ctx.user.id, await this.hasher.hash(input.newPassword));
    // SR-02: alle Sitzungen (auch die aktuelle) enden, die neue hat eine frische ID.
    await this.d.sessions.revokeAllForUser(ctx.user.id);
    const issued = await this.issue(ctx.user.id, "full");
    await this.log("password_changed", "success", ip, ctx.user.id, ctx.user.id);
    await this.notify(
      { kind: "password_changed", to: ctx.user.email, at: this.now() },
      ip,
      ctx.user.id,
    );
    return { kind: "ok", issued };
  }

  // ---------------------------------------------------------------- Chef-Admin

  /**
   * Setzt nur den zweiten Faktor eines Nutzers zurück (keine Passwortübernahme). Der Nutzer
   * richtet beim nächsten Login neu ein. Immer protokolliert, Nutzer wird per Mail informiert.
   */
  async resetMfa(
    actor: SessionContext,
    targetId: string,
    ip: string,
  ): Promise<{ kind: "ok" } | { kind: "forbidden" } | { kind: "not_found" }> {
    if (actor.session.stage !== "full" || actor.user.role !== "chief_admin") {
      await this.log("mfa_reset_denied", "failure", ip, actor.user.id, null, { reason: "role" });
      return { kind: "forbidden" };
    }
    // Ohne Selbstbedienung: sonst wäre der Reset ein Weg um den zweiten Faktor.
    // Notfallweg für den Chef-Admin: ein zweiter Chef-Admin (Projektplan Abschnitt 7).
    if (targetId === actor.user.id) {
      await this.log("mfa_reset_denied", "failure", ip, actor.user.id, targetId, {
        reason: "self",
      });
      return { kind: "forbidden" };
    }
    const target = await this.d.users.findById(targetId);
    if (!target) return { kind: "not_found" };

    await this.d.users.clearTotp(target.id);
    await this.d.sessions.revokeAllForUser(target.id);
    await this.log("mfa_reset", "success", ip, actor.user.id, target.id);
    await this.notify({ kind: "mfa_reset", to: target.email, at: this.now() }, ip, target.id);
    return { kind: "ok" };
  }

  /** Protokolliert ein abgelehntes Ereignis ohne Fachlogik (z. B. CSRF). */
  audit(type: AuditEvent["type"], ip: string, actor: string | null = null) {
    return this.log(type, "failure", ip, actor, null);
  }

  /** Wartung: abgelaufene Sitzungen entfernen (z. B. per Worker). */
  purgeExpiredSessions() {
    return this.d.sessions.deleteExpired(this.now());
  }
}
