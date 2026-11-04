import { randomBytes } from "node:crypto";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { base32Decode } from "./base32.js";
import type { AuthConfig } from "./config.js";
import {
  MemoryAuditRepo,
  MemorySessionRepo,
  MemoryThrottleRepo,
  MemoryUserRepo,
} from "./memory.js";
import { ARGON2_MIN, createPasswordHasher } from "./password.js";
import type { PasswordHasher } from "./password.js";
import { SESSION_COOKIE } from "./routes.js";
import type { AuditRepo, MailPort, SecurityNotice, User } from "./types.js";
import { hotp, totpCounter } from "./totp.js";

export const ORIGIN = "https://app.test";
export const PASSWORD = "korrekt-pferd-batterie-heftklammer";
export const peppers = [{ id: "p2", secret: "x".repeat(40) }];

export function testConfig(over: Partial<AuthConfig> = {}): AuthConfig {
  return {
    peppers,
    totpKey: randomBytes(32),
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
  failing = false;
  sendSecurityNotice(notice: SecurityNotice) {
    if (this.failing) return Promise.reject(new Error("SMTP down"));
    this.sent.push(notice);
    return Promise.resolve();
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

export async function setup(opts: { config?: Partial<AuthConfig>; audit?: AuditRepo } = {}) {
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
  const app = await buildApp(loadConfig({ LOG_LEVEL: "silent" }), false, {
    auth: { config, users, sessions, throttle, audit, mail, hasher, clock: clock.now },
  });

  const addUser = async (email: string, extra: Partial<User> = {}) =>
    users.add({ email, passwordHash: await real.hash(PASSWORD), ...extra });

  async function req(
    method: "GET" | "POST",
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
    req,
    cookieOf,
    login,
    enroll,
    fullLogin,
    codeAt,
  };
}
