import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { totpBoxFromEnv } from "@stammbuch/mail";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { createPlatform, invite } from "../../platform/index.js";
import { MemoryInvitationOutbox, MemoryInvitations } from "../../platform/memory.js";
import { base32Decode } from "./base32.js";
import type { AuthConfig } from "./config.js";
import {
  MEMORY_TENANT,
  MemoryAuditRepo,
  MemoryInvitationRepo,
  MemoryPasswordResetRepo,
  MemorySessionRepo,
  MemoryThrottleRepo,
  MemoryUserRepo,
} from "./memory.js";
import { ARGON2_MIN, createPasswordHasher } from "./password.js";
import type { PasswordHasher } from "./password.js";
import { SESSION_COOKIE } from "./routes.js";
import type { AuditRepo, MailPort, PasswordResetMessage, SecurityNotice, User } from "./types.js";
import { hotp, totpCounter } from "./totp.js";

export const ORIGIN = "https://app.test";
export const PASSWORD = "korrekt-pferd-batterie-heftklammer";
export const peppers = [{ id: "p2", secret: "x".repeat(40) }];

export function testConfig(over: Partial<AuthConfig> = {}): AuthConfig {
  const totpKey = randomBytes(32);
  return {
    peppers,
    totpKey,
    totpBox: totpBoxFromEnv({ AUTH_TOTP_KEY: totpKey.toString("base64") }),
    appOrigin: ORIGIN,
    issuer: "Stammbuch",
    rateLimitMax: 1000,
    sessionAbsoluteMs: 12 * 3_600_000,
    sessionIdleMs: 2 * 3_600_000,
    pendingMs: 10 * 60_000,
    argon2: ARGON2_MIN, // schnell, aber genau am SR-01-Minimum
    ...over,
  };
}

export class FakeMail implements MailPort {
  readonly sent: SecurityNotice[] = [];
  readonly resets: PasswordResetMessage[] = [];
  failing = false;
  sendSecurityNotice(notice: SecurityNotice) {
    if (this.failing) return Promise.reject(new Error("SMTP down"));
    this.sent.push(notice);
    return Promise.resolve();
  }
  sendPasswordReset(message: PasswordResetMessage) {
    if (this.failing) return Promise.reject(new Error("SMTP down"));
    this.resets.push(message);
    return Promise.resolve();
  }
  /** Das Token aus dem Link der letzten Mail. */
  lastResetToken() {
    return new URL(this.resets.at(-1)!.link).hash.slice(1);
  }
}

export class Clock {
  constructor(public t = new Date("2026-11-04T10:00:00.000Z")) {}
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export interface Cookies {
  cookie: string | undefined;
  csrf: string | undefined;
}

/** HTTP-Hilfen gegen eine gebaute App; unabhängig davon, ob die Repos im Speicher oder in Postgres liegen. */
export function harness(app: FastifyInstance, clock: Clock) {
  async function req(
    method: "GET" | "POST" | "PATCH",
    url: string,
    c: Cookies = { cookie: undefined, csrf: undefined },
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const h: Record<string, string> = { ...headers };
    if (c.cookie) h.cookie = `${SESSION_COOKIE}=${c.cookie}`;
    if (c.csrf) h["x-csrf-token"] = c.csrf;
    const res = await app.inject({
      method,
      url,
      headers: h,
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return res;
  }

  const cookieOf = (res: Awaited<ReturnType<typeof req>>) =>
    res.cookies.find((x) => x.name === SESSION_COOKIE);

  /** Passwort-Schritt. Gibt Cookie + CSRF-Token der Zwischen-Sitzung zurück. */
  async function login(email: string, password = PASSWORD, prev?: Cookies) {
    const res = await req("POST", "/auth/login", prev, { email, password });
    const body = res.json();
    return {
      res,
      body,
      c: { cookie: cookieOf(res)?.value, csrf: body.csrfToken as string | undefined } as Cookies,
    };
  }

  const codeAt = (secret: Buffer, offsetSteps = 0) =>
    hotp(secret, totpCounter(clock.t.getTime()) + offsetSteps);

  /** Komplette Ersteinrichtung: Login, TOTP einrichten, bestätigen. */
  async function enroll(email: string) {
    const l = await login(email);
    const s = await req("POST", "/auth/2fa/setup", l.c);
    const secret = base32Decode(s.json().secret);
    const done = await req("POST", "/auth/2fa", l.c, { code: codeAt(secret) });
    const body = done.json();
    return {
      secret,
      recoveryCodes: body.recoveryCodes as string[],
      c: { cookie: cookieOf(done)?.value, csrf: body.csrfToken as string } as Cookies,
    };
  }

  /** Login mit bereits eingerichtetem TOTP. Spult die Uhr vor, damit der Code neu ist. */
  async function fullLogin(email: string, secret: Buffer) {
    clock.advance(30_000);
    const l = await login(email);
    const done = await req("POST", "/auth/2fa", l.c, { code: codeAt(secret) });
    return {
      res: done,
      c: { cookie: cookieOf(done)?.value, csrf: done.json().csrfToken } as Cookies,
    };
  }

  return { req, cookieOf, login, enroll, fullLogin, codeAt };
}

export async function setup(
  opts: { config?: Partial<AuthConfig>; audit?: AuditRepo; resetMinMs?: number } = {},
) {
  const config = testConfig(opts.config);
  const users = new MemoryUserRepo();
  const sessions = new MemorySessionRepo();
  const throttle = new MemoryThrottleRepo();
  const audit = opts.audit ?? new MemoryAuditRepo();
  const mail = new FakeMail();
  const clock = new Clock();
  const real = createPasswordHasher(config.peppers, config.argon2);
  const calls = { verify: 0, verifyAbsent: 0 };
  const hasher: PasswordHasher = {
    hash: (p) => real.hash(p),
    needsRehash: (s) => real.needsRehash(s),
    verify: (s, p) => {
      calls.verify++;
      return real.verify(s, p);
    },
    verifyAbsent: (p) => {
      calls.verifyAbsent++;
      return real.verifyAbsent(p);
    },
  };
  // Einladungen legt die Platform an (wie im Betrieb); das Auth-Modul löst sie ein.
  const platformInvitations = new MemoryInvitations();
  const outbox = new MemoryInvitationOutbox();
  const invitations = new MemoryInvitationRepo(platformInvitations, users);
  const passwordReset = new MemoryPasswordResetRepo(users);
  const platform = createPlatform({
    invitations: platformInvitations,
    invitationSender: outbox,
    clock: clock.now,
  });
  const app = await buildApp(loadConfig({ LOG_LEVEL: "silent" }), false, {
    auth: {
      config,
      users,
      sessions,
      throttle,
      audit,
      mail,
      hasher,
      invitations,
      passwordReset,
      resetMinMs: opts.resetMinMs ?? 0,
      clock: clock.now,
    },
    platform,
  });

  /** Legt eine Einladung an und liefert das Token, das sonst nur die Mail trägt. */
  const invitation = async (
    to: { email: string; role?: "admin" | "user"; userId?: string | null; name?: string },
    tenantId = MEMORY_TENANT,
  ) => {
    await invite(
      platform,
      { id: tenantId, name: "Verein Test" },
      { email: to.email, role: to.role ?? "admin", userId: to.userId ?? null, name: to.name },
    );
    return outbox.sent.at(-1)!.token;
  };

  const addUser = async (email: string, extra: Partial<User> = {}) =>
    users.add({ email, passwordHash: await real.hash(PASSWORD), ...extra });

  const { req, cookieOf, login, enroll, fullLogin, codeAt } = harness(app, clock);
  /** Lässt Mails im Hintergrund (nach der Antwort) zu Ende laufen. */
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  return {
    app,
    users,
    sessions,
    throttle,
    audit: audit as MemoryAuditRepo,
    mail,
    clock,
    calls,
    config,
    real,
    addUser,
    invitation,
    flush,
    platform,
    platformInvitations,
    req,
    cookieOf,
    login,
    enroll,
    fullLogin,
    codeAt,
  };
}
