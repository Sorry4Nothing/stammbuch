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
  InvitationRepo,
  MailPort,
  PasswordBlocklist,
  PasswordResetRepo,
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
  /** Ohne Angabe lässt sich keine Einladung einlösen (fail closed). */
  invitations?: InvitationRepo;
  /** Ohne Angabe lässt sich weder ein Link anfordern noch ein Passwort zurücksetzen (fail closed). */
  passwordReset?: PasswordResetRepo;
  /**
   * Mindestdauer der Anfrage «Passwort vergessen» in Millisekunden (Standard 400). Bekannte und unbekannte
   * Adressen brauchen so gleich lang, auch wenn Datenbank und Mailversand verschieden schnell sind (SR-05).
   */
  resetMinMs?: number;
  blocklist?: PasswordBlocklist;
  hasher?: PasswordHasher;
  clock?: () => Date;
  /**
   * Führt `fn` als eine Einheit aus: alle Repo-Aufrufe darin (Aktion + Audit-Eintrag) gelten
   * gemeinsam oder gar nicht. Postgres: eine Transaktion im Mandanten. Ohne Angabe (Tests im
   * Speicher) läuft `fn` direkt.
   */
  atomic?: <T>(tenantId: string, fn: () => Promise<T>) => Promise<T>;
}

export interface SessionContext {
  session: Session;
  user: User;
}

/** Nach 5 falschen zweiten Faktoren in einer Sitzung ist sie verbraucht; neu anmelden. */
export const MAX_MFA_ATTEMPTS_PER_SESSION = 5;

/** Der Link zum Zurücksetzen gilt kurz und genau einmal. */
export const PASSWORD_RESET_TTL_MS = 30 * 60_000;

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
  /** Mails, die nach der Antwort noch laufen (siehe `requestPasswordReset`). */
  private readonly background = new Set<Promise<void>>();

  get config() {
    return this.d.config;
  }

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

  private atomic<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return this.d.atomic ? this.d.atomic(tenantId, fn) : fn();
  }

  private async log(
    type: AuditEvent["type"],
    outcome: AuditEvent["outcome"],
    ip: string,
    tenantId: string | null,
    actor: string | null,
    target: string | null,
    detail?: AuditEvent["detail"],
  ) {
    // Schlägt das Protokollieren fehl, schlägt die Aktion fehl (SR-54, SR-52).
    await this.d.audit.append({
      at: this.now(),
      tenantId,
      type,
      outcome,
      actorUserId: actor,
      targetUserId: target,
      ip,
      ...(detail ? { detail } : {}),
    });
  }

  /** Wartet, bis alle Mails im Hintergrund fertig sind (Tests, geordnetes Beenden). */
  async idle() {
    while (this.background.size > 0) await Promise.all([...this.background]);
  }

  private async notify(notice: SecurityNotice, ip: string, tenantId: string, userId: string) {
    try {
      await this.d.mail.sendSecurityNotice(notice);
    } catch {
      // Die Aktion ist bereits erfolgt; der Ausfall wird protokolliert, nicht verschluckt.
      await this.log("notice_failed", "failure", ip, tenantId, null, userId, { kind: notice.kind });
    }
  }

  private async issue(
    user: Pick<User, "id" | "tenantId">,
    stage: Session["stage"],
    extra: Partial<Session> = {},
  ): Promise<Issued> {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const ttl = stage === "pending" ? this.d.config.pendingMs : this.d.config.sessionAbsoluteMs;
    const session: Session = {
      id: sha256(token),
      tenantId: user.tenantId,
      userId: user.id,
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
      session.expiresAt <= now || idle
        ? null
        : await this.d.users.findById(session.tenantId, session.userId);
    if (!user || user.disabled) {
      await this.atomic(session.tenantId, async () => {
        await this.d.sessions.revoke(session.tenantId, session.id);
        await this.log("session_rejected", "failure", ip, session.tenantId, null, session.userId);
      });
      return null;
    }
    // Nicht bei jeder Anfrage schreiben: höchstens einmal pro Minute.
    if (now.getTime() - session.lastSeenAt.getTime() > 60_000) {
      await this.d.sessions.touch(session.tenantId, session.id, now);
    }
    return { session, user };
  }

  verifyCsrf(ctx: SessionContext, header: string | undefined): boolean {
    return !!header && safeEqual(header, ctx.session.csrfToken);
  }

  async revokeToken(token: string | undefined) {
    if (!token || token.length > 128) return;
    const session = await this.d.sessions.findById(sha256(token));
    if (session) await this.d.sessions.revoke(session.tenantId, session.id);
  }

  async logout(ctx: SessionContext, ip: string) {
    const { tenantId, id } = ctx.user;
    await this.atomic(tenantId, async () => {
      await this.d.sessions.revoke(tenantId, ctx.session.id);
      await this.log("logout", "success", ip, tenantId, id, id);
    });
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
      await this.log("login_locked", "failure", ip, null, null, null, {
        account: key.slice(0, 16),
      });
      return locked;
    }

    const user = await this.d.users.findByEmail(email);
    // Gleicher Hash-Aufwand für existierende und nicht existierende Konten (SR-05).
    let ok = false;
    if (user) ok = await this.hasher.verify(user.passwordHash, input.password);
    else await this.hasher.verifyAbsent(input.password);

    if (!user || !ok || user.disabled) {
      await this.recordFailure(key);
      await this.log(
        "login_failure",
        "failure",
        ip,
        user?.tenantId ?? null,
        null,
        user?.id ?? null,
        {
          account: key.slice(0, 16),
        },
      );
      return { kind: "invalid" };
    }

    // Passwort stimmt: ggf. mit neuem Pepper/neuen Parametern neu hashen (best effort).
    if (this.hasher.needsRehash(user.passwordHash)) {
      await this.d.users.setPasswordHash(
        user.tenantId,
        user.id,
        await this.hasher.hash(input.password),
      );
    }

    // Rotation: eine mitgeschickte alte Sitzung wird ungültig, die neue hat eine frische ID.
    await this.revokeToken(input.previousToken);
    const issued = await this.atomic(user.tenantId, async () => {
      const i = await this.issue(user, "pending");
      await this.log("login_success", "success", ip, user.tenantId, user.id, user.id, {
        stage: "password",
      });
      return i;
    });
    return {
      kind: "ok",
      issued,
      next: user.totpSecretEnc ? "mfa_required" : "mfa_setup_required",
    };
  }

  // ---------------------------------------------------------------- Einladung einlösen

  /**
   * Öffentlich: Einladung einlösen, Passwort setzen, Benutzer aktivieren. Danach wie nach dem Passwort-Schritt
   * der Anmeldung: Zwischen-Sitzung, der zweite Faktor wird eingerichtet (`/auth/2fa/setup`, `/auth/2fa`).
   * Unbekannt, abgelaufen und benutzt sind nicht zu unterscheiden (SR-05). Der Hash-Aufwand fällt in jedem
   * Fall an, auch wenn die Einladung ungültig ist.
   */
  async redeemInvitation(
    input: { token: string; password: string; previousToken?: string | undefined },
    ip: string,
  ): Promise<
    Invalid | { kind: "weak"; problem: PasswordProblem } | { kind: "ok"; issued: Issued }
  > {
    const repo = this.d.invitations;
    const tokenHash = sha256(input.token);
    const now = this.now();
    const invitation = repo ? await repo.peek(tokenHash, now) : null;
    // Ohne gültige Einladung gibt es keine Adresse; die übrigen Regeln gelten für jedes Token gleich.
    const problem = await checkPasswordPolicy(
      input.password,
      invitation?.email ?? "",
      this.d.blocklist ?? builtinBlocklist,
    );
    if (problem) {
      // Mit gültigem Token zählt das als Fehlversuch an dieser Einladung; ab der Schwelle ist sie gesperrt.
      if (repo && invitation) {
        await repo.recordFailure(tokenHash);
        await this.log("invitation_failure", "failure", ip, invitation.tenantId, null, null, {
          reason: "weak",
        });
      }
      return { kind: "weak", problem };
    }

    const passwordHash = await this.hasher.hash(input.password);
    if (!repo || !invitation) return this.rejectInvitation(ip);

    // Einlösen, Sitzung und Protokoll gelten zusammen oder gar nicht: fällt das Protokoll aus, bleibt die Einladung gültig.
    const issued = await this.atomic(invitation.tenantId, async () => {
      const r = await repo.redeem(tokenHash, passwordHash, now);
      if (!r || r.tenantId !== invitation.tenantId) return null;
      const i = await this.issue({ id: r.userId, tenantId: r.tenantId }, "pending");
      await this.log("invitation_redeemed", "success", ip, r.tenantId, r.userId, r.userId, {
        role: r.role,
      });
      return i;
    });
    if (!issued) {
      await repo.recordFailure(tokenHash);
      return this.rejectInvitation(ip);
    }
    await this.revokeToken(input.previousToken);
    return { kind: "ok", issued };
  }

  private async rejectInvitation(ip: string): Promise<Invalid> {
    await this.log("invitation_rejected", "failure", ip, null, null, null);
    return { kind: "invalid" };
  }

  // ---------------------------------------------------------------- Schritt 2: zweiter Faktor

  /** Startet die TOTP-Einrichtung (erster Login oder nach Reset). */
  async beginTotpSetup(ctx: SessionContext) {
    if (ctx.session.stage !== "pending" || ctx.user.totpSecretEnc) return null;
    const secret = generateTotpSecret();
    await this.d.sessions.setPendingTotp(
      ctx.user.tenantId,
      ctx.session.id,
      encryptSecret(this.d.config.totpKey, ctx.user.id, secret),
    );
    return {
      secret: base32Encode(secret),
      otpauthUri: otpauthUri(secret, ctx.user.email, this.d.config.issuer),
    };
  }

  private async mfaFailure(ctx: SessionContext, ip: string, type: AuditEvent["type"]) {
    const { tenantId, id } = ctx.user;
    await this.recordFailure(this.keyOf(ctx.user.email));
    await this.atomic(tenantId, async () => {
      const n = await this.d.sessions.recordMfaFailure(tenantId, ctx.session.id);
      if (n >= MAX_MFA_ATTEMPTS_PER_SESSION) await this.d.sessions.revoke(tenantId, ctx.session.id);
      await this.log(type, "failure", ip, tenantId, id, id);
    });
    return { kind: "invalid" } as const;
  }

  /** Nur innerhalb von `atomic` aufrufen: Zähler zurücksetzen, Zwischen-Sitzung ersetzen. */
  private async promote(ctx: SessionContext) {
    await this.d.throttle.clear(this.keyOf(ctx.user.email));
    await this.d.sessions.revoke(ctx.user.tenantId, ctx.session.id);
    return this.issue(ctx.user, "full"); // Rotation: neue ID mit vollem Zugriff
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
      const { tenantId, id } = ctx.user;
      const pendingEnc = ctx.session.pendingTotpSecretEnc;
      // Einrichtung, Sitzungswechsel und Protokoll gelten zusammen oder gar nicht.
      const issued = await this.atomic(tenantId, async () => {
        if (!(await this.d.users.enrollTotp(tenantId, id, pendingEnc, counter, hashes)))
          return null;
        const i = await this.promote(ctx);
        await this.log("mfa_enrolled", "success", ip, tenantId, id, id);
        await this.log("mfa_success", "success", ip, tenantId, id, id);
        return i;
      });
      if (!issued) return this.mfaFailure(ctx, ip, "mfa_failure");
      await this.notify(
        { kind: "mfa_enrolled", to: ctx.user.email, at: this.now() },
        ip,
        tenantId,
        id,
      );
      return { kind: "ok", issued, recoveryCodes: codes, remainingRecoveryCodes: codes.length };
    }

    if (!ctx.user.totpSecretEnc) return { kind: "invalid" }; // erst /auth/2fa/setup aufrufen
    const secret = decryptSecret(key, ctx.user.id, ctx.user.totpSecretEnc);
    const counter = verifyTotp(secret, code, nowMs);
    if (counter === null) return this.mfaFailure(ctx, ip, "mfa_failure");
    // Replay-Schutz: derselbe oder ein älterer Zeitschritt wird nie ein zweites Mal akzeptiert.
    const { tenantId, id } = ctx.user;
    const issued = await this.atomic(tenantId, async () => {
      if (!(await this.d.users.advanceTotpCounter(tenantId, id, counter))) return null;
      const i = await this.promote(ctx);
      await this.log("mfa_success", "success", ip, tenantId, id, id);
      return i;
    });
    if (!issued) return this.mfaFailure(ctx, ip, "mfa_replay");
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

    const { tenantId, id } = ctx.user;
    const remaining = Math.max(0, ctx.user.recoveryCodeHashes.length - 1);
    const hash = hashRecoveryCode(this.recoveryKey, code);
    const issued = await this.atomic(tenantId, async () => {
      if (!(await this.d.users.consumeRecoveryCode(tenantId, id, hash))) return null;
      const i = await this.promote(ctx);
      await this.log("recovery_used", "success", ip, tenantId, id, id, { remaining });
      return i;
    });
    if (!issued) return this.mfaFailure(ctx, ip, "recovery_failure");
    await this.notify(
      { kind: "recovery_used", to: ctx.user.email, at: this.now(), remaining },
      ip,
      tenantId,
      id,
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
      await this.log(
        "password_change_failure",
        "failure",
        ip,
        ctx.user.tenantId,
        ctx.user.id,
        ctx.user.id,
      );
      return { kind: "invalid" };
    }
    if (input.newPassword === input.currentPassword) return { kind: "weak", problem: "unchanged" };
    const problem = await checkPasswordPolicy(
      input.newPassword,
      ctx.user.email,
      this.d.blocklist ?? builtinBlocklist,
    );
    if (problem) return { kind: "weak", problem };

    const { tenantId, id } = ctx.user;
    const newHash = await this.hasher.hash(input.newPassword);
    // SR-02: alle Sitzungen (auch die aktuelle) enden, die neue hat eine frische ID.
    const issued = await this.atomic(tenantId, async () => {
      await this.d.users.setPasswordHash(tenantId, id, newHash);
      await this.d.sessions.revokeAllForUser(tenantId, id);
      const i = await this.issue(ctx.user, "full");
      await this.log("password_changed", "success", ip, tenantId, id, id);
      return i;
    });
    await this.notify(
      { kind: "password_changed", to: ctx.user.email, at: this.now() },
      ip,
      tenantId,
      id,
    );
    return { kind: "ok", issued };
  }

  // ---------------------------------------------------------------- Passwort vergessen

  /**
   * Öffentlich: sendet einen Link zum Zurücksetzen, wenn es ein aktives Konto gibt. Der Aufrufer erfährt nie, ob
   * es eines gab (SR-05): gleiche Antwort, gleiche Mindestdauer, der Mailversand läuft erst nach der Antwort.
   * Limit pro Konto (3 pro Stunde) setzt das Repository, pro IP die Route. Das Token (256 Bit) steht nur im Link,
   * gespeichert wird sein Hash.
   */
  async requestPasswordReset(rawEmail: string, ip: string): Promise<void> {
    const started = Date.now();
    const email = normalizeEmail(rawEmail);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_MS);
    const token = randomBytes(32).toString("base64url");
    const hit = this.d.passwordReset
      ? await this.d.passwordReset.create(email, sha256(token), now, expiresAt)
      : null;
    await this.log(
      "password_reset_requested",
      hit ? "success" : "failure",
      ip,
      hit?.tenantId ?? null,
      null,
      hit?.userId ?? null,
      { account: this.keyOf(email).slice(0, 16) },
    );
    if (hit) {
      const link = `${this.d.config.appOrigin}/passwort-zuruecksetzen#${token}`;
      const job: Promise<void> = this.d.mail
        .sendPasswordReset({ to: email, link, expiresAt })
        .catch(() =>
          this.log("notice_failed", "failure", ip, hit.tenantId, null, hit.userId, {
            kind: "password_reset",
          }).catch(() => undefined),
        )
        .finally(() => this.background.delete(job));
      this.background.add(job);
    }
    const wait = (this.d.resetMinMs ?? 400) - (Date.now() - started);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  /**
   * Öffentlich: neues Passwort mit dem Token aus dem Link. Ist der zweite Faktor eingerichtet, verlangt es
   * zusätzlich einen frischen Einmalcode oder einen Wiederherstellungscode; falsche Codes zählen gegen die
   * Kontosperre wie bei der Anmeldung. Beendet alle Sitzungen und meldet nicht an (neu anmelden mit Passwort
   * und zweitem Faktor). Unbekannt, abgelaufen, benutzt oder ersetzt sind nicht zu unterscheiden (SR-05).
   */
  async resetPassword(
    input: { token: string; password: string; code?: string | undefined },
    ip: string,
  ): Promise<Locked | Invalid | { kind: "weak"; problem: PasswordProblem } | { kind: "ok" }> {
    const repo = this.d.passwordReset;
    const tokenHash = sha256(input.token);
    const now = this.now();
    // Der Hash-Aufwand fällt in jedem Fall an, auch bei ungültigem Token.
    const passwordHash = await this.hasher.hash(input.password);
    const hit = repo ? await repo.peek(tokenHash, now) : null;
    const user = hit ? await this.d.users.findById(hit.tenantId, hit.userId) : null;
    if (!repo || !user || user.disabled) {
      await this.log("password_reset_rejected", "failure", ip, null, null, null);
      return { kind: "invalid" };
    }

    const { tenantId, id } = user;
    const key = this.keyOf(user.email);
    // Die Sperre schützt den zweiten Faktor vor Raten; ohne zweiten Faktor gibt es nichts zu schützen.
    const locked = user.totpSecretEnc ? await this.lockState(key) : null;
    if (locked) return locked;
    const problem = await checkPasswordPolicy(
      input.password,
      user.email,
      this.d.blocklist ?? builtinBlocklist,
    );
    if (problem) return { kind: "weak", problem };

    // Zweiter Faktor, falls eingerichtet: Einmalcode (sechs Ziffern) oder Wiederherstellungscode.
    const code = (input.code ?? "").trim();
    const isTotp = /^\d{3}\s?\d{3}$/.test(code);
    const secret = user.totpSecretEnc
      ? decryptSecret(this.d.config.totpKey, id, user.totpSecretEnc)
      : null;
    const counter =
      secret && isTotp ? verifyTotp(secret, code.replace(/\s/g, ""), now.getTime()) : null;
    const recoveryHash =
      secret && code && !isTotp ? hashRecoveryCode(this.recoveryKey, code) : null;

    const outcome = await this.atomic(tenantId, async () => {
      if (secret) {
        const factorOk =
          counter !== null
            ? await this.d.users.advanceTotpCounter(tenantId, id, counter)
            : recoveryHash !== null &&
              (await this.d.users.consumeRecoveryCode(tenantId, id, recoveryHash));
        if (!factorOk) return "factor" as const;
      }
      if (!(await repo.consume(tokenHash, now))) return "token" as const;
      await this.d.users.setPasswordHash(tenantId, id, passwordHash);
      await this.d.sessions.revokeAllForUser(tenantId, id);
      await this.d.throttle.clear(key);
      await this.log("password_reset_done", "success", ip, tenantId, id, id);
      return "ok" as const;
    });
    if (outcome === "factor") {
      await this.recordFailure(key);
      await this.log("password_reset_failure", "failure", ip, tenantId, id, id);
      return { kind: "invalid" };
    }
    if (outcome === "token") {
      await this.log("password_reset_rejected", "failure", ip, tenantId, null, id);
      return { kind: "invalid" };
    }
    await this.notify(
      { kind: "password_changed", to: user.email, at: this.now() },
      ip,
      tenantId,
      id,
    );
    return { kind: "ok" };
  }

  // ---------------------------------------------------------------- Eigener Name

  /** Ändert den eigenen Anzeigenamen (nur volle Sitzung). Das Ziel kommt aus der Sitzung, nie aus dem Request. */
  async changeName(ctx: SessionContext, name: string, ip: string) {
    if (ctx.session.stage !== "full") return null;
    const { tenantId, id } = ctx.user;
    await this.atomic(tenantId, async () => {
      await this.d.users.setName(tenantId, id, name);
      await this.log("name_changed", "success", ip, tenantId, id, id);
    });
    return { ...ctx.user, name };
  }

  // ---------------------------------------------------------------- Step-up und Chef-Admin

  /**
   * Frischer TOTP-Code für heikle Aktionen. "Frisch" erzwingt der Replay-Schutz: der Code
   * muss einen jüngeren Zeitschritt tragen als der zuletzt akzeptierte (also auch als der
   * der Anmeldung). Falsche Codes zählen wie beim Login gegen die Sperre.
   */
  private async stepUp(
    ctx: SessionContext,
    code: string,
    ip: string,
  ): Promise<"ok" | "invalid" | Locked> {
    const key = this.keyOf(ctx.user.email);
    const locked = await this.lockState(key);
    if (locked) return locked;
    const { tenantId, id } = ctx.user;
    const counter = ctx.user.totpSecretEnc
      ? verifyTotp(
          decryptSecret(this.d.config.totpKey, id, ctx.user.totpSecretEnc),
          code,
          this.now().getTime(),
        )
      : null;
    if (counter !== null && (await this.d.users.advanceTotpCounter(tenantId, id, counter))) {
      return "ok";
    }
    await this.recordFailure(key);
    await this.log("stepup_failure", "failure", ip, tenantId, id, id);
    return "invalid";
  }

  /**
   * Setzt nur den zweiten Faktor eines Nutzers zurück (keine Passwortübernahme). Der Nutzer
   * richtet beim nächsten Login neu ein. Verlangt einen frischen TOTP-Code des Chef-Admins (Step-up),
   * wird immer protokolliert, der Nutzer per Mail informiert.
   */
  async resetMfa(
    actor: SessionContext,
    targetId: string,
    code: string,
    ip: string,
  ): Promise<{ kind: "ok" } | { kind: "forbidden" } | { kind: "not_found" } | Invalid | Locked> {
    const actorTenant = actor.user.tenantId;
    if (actor.session.stage !== "full" || actor.user.role !== "chief_admin") {
      await this.log("mfa_reset_denied", "failure", ip, actorTenant, actor.user.id, null, {
        reason: "role",
      });
      return { kind: "forbidden" };
    }
    // Ohne Selbstbedienung: sonst wäre der Reset ein Weg um den zweiten Faktor.
    // Notfallweg für den Chef-Admin: ein zweiter Chef-Admin (Projektplan Abschnitt 7).
    if (targetId === actor.user.id) {
      await this.log("mfa_reset_denied", "failure", ip, actorTenant, actor.user.id, targetId, {
        reason: "self",
      });
      return { kind: "forbidden" };
    }
    const step = await this.stepUp(actor, code, ip);
    if (step !== "ok") return step === "invalid" ? { kind: "invalid" } : step;

    // Das Ziel kann in einem anderen Mandanten liegen; die Datenquelle prüft die Rolle des Akteurs selbst.
    const target = await this.d.users.findForMfaReset(actor.user.id, targetId);
    if (!target) return { kind: "not_found" };

    await this.atomic(target.tenantId, async () => {
      await this.d.users.clearTotp(target.tenantId, target.id);
      await this.d.sessions.revokeAllForUser(target.tenantId, target.id);
      await this.log("mfa_reset", "success", ip, target.tenantId, actor.user.id, target.id);
    });
    await this.notify(
      { kind: "mfa_reset", to: target.email, at: this.now() },
      ip,
      target.tenantId,
      target.id,
    );
    return { kind: "ok" };
  }

  /** Neue Wiederherstellungscodes; die alten sind sofort wertlos. Nur mit frischem TOTP-Code. */
  async renewRecoveryCodes(
    ctx: SessionContext,
    code: string,
    ip: string,
  ): Promise<Invalid | Locked | { kind: "ok"; recoveryCodes: string[] }> {
    if (ctx.session.stage !== "full" || !ctx.user.totpSecretEnc) return { kind: "invalid" };
    const step = await this.stepUp(ctx, code, ip);
    if (step !== "ok") return step === "invalid" ? { kind: "invalid" } : step;

    const { tenantId, id } = ctx.user;
    const codes = generateRecoveryCodes();
    const hashes = codes.map((c) => hashRecoveryCode(this.recoveryKey, c));
    await this.atomic(tenantId, async () => {
      await this.d.users.replaceRecoveryCodes(tenantId, id, hashes);
      await this.log("recovery_codes_renewed", "success", ip, tenantId, id, id);
    });
    await this.notify(
      { kind: "recovery_codes_renewed", to: ctx.user.email, at: this.now() },
      ip,
      tenantId,
      id,
    );
    return { kind: "ok", recoveryCodes: codes };
  }

  /** Protokolliert ein abgelehntes Ereignis ohne Fachlogik (z. B. CSRF). */
  audit(
    type: AuditEvent["type"],
    ip: string,
    actor: { id: string; tenantId: string } | null = null,
  ) {
    return this.log(type, "failure", ip, actor?.tenantId ?? null, actor?.id ?? null, null);
  }

  /** Wartung: abgelaufene Sitzungen entfernen (z. B. per Worker). */
  purgeExpiredSessions() {
    return this.d.sessions.deleteExpired(this.now());
  }
}
