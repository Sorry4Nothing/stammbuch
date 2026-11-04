import { randomBytes } from "node:crypto";
import { hash, parseOptions, verify } from "@node-rs/argon2";
import type { AuthConfig } from "./config.js";
import type { PasswordBlocklist } from "./types.js";

/** SR-01: OWASP-Minimum für Argon2id. Schwächere Parameter lassen den Start scheitern. */
export const ARGON2_MIN = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
/** Produktionsstandard: deutlich über dem Minimum (64 MiB, 3 Durchgänge). */
export const ARGON2_DEFAULT = { memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;
const ARGON2ID = 2; // Algorithm.Argon2id (const enum, daher als Zahl)

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(stored: string, password: string): Promise<boolean>;
  /** Gleicher Aufwand wie `verify`, ohne dass ein Konto existiert (SR-05, Timing). */
  verifyAbsent(password: string): Promise<void>;
  /** Pepper veraltet oder Parameter unter dem aktuellen Stand: beim nächsten Login neu hashen. */
  needsRehash(stored: string): boolean;
}

// Unicode-Normalisierung (NFKC), damit dasselbe Passwort auf allen Geräten gleich hasht.
const prep = (pw: string) => Buffer.from(pw.normalize("NFKC"), "utf8");

export function createPasswordHasher(
  peppers: AuthConfig["peppers"],
  params: { memoryCost: number; timeCost: number; parallelism: number } = ARGON2_DEFAULT,
): PasswordHasher {
  if (
    params.memoryCost < ARGON2_MIN.memoryCost ||
    params.timeCost < ARGON2_MIN.timeCost ||
    params.parallelism < ARGON2_MIN.parallelism
  ) {
    throw new Error("Argon2-Parameter unter dem Minimum von SR-01");
  }
  const current = peppers[0];
  if (!current) throw new Error("Kein Pepper konfiguriert");
  const secretOf = (id: string) => {
    const p = peppers.find((x) => x.id === id);
    return p ? Buffer.from(p.secret, "utf8") : null;
  };
  let dummy: Promise<string> | undefined;

  const hasher: PasswordHasher = {
    async hash(password) {
      const encoded = await hash(prep(password), { ...params, secret: secretOf(current.id)! });
      return `${current.id}:${encoded}`;
    },
    async verify(stored, password) {
      const i = stored.indexOf(":");
      const secret = i > 0 ? secretOf(stored.slice(0, i)) : null;
      if (!secret) return false;
      try {
        return await verify(stored.slice(i + 1), prep(password), { secret });
      } catch {
        return false; // beschädigter Hash: verweigern, nie durchlassen (SR-54)
      }
    },
    async verifyAbsent(password) {
      dummy ??= hasher.hash(randomBytes(24).toString("base64"));
      await hasher.verify(await dummy, password);
    },
    needsRehash(stored) {
      const i = stored.indexOf(":");
      if (i <= 0 || stored.slice(0, i) !== current.id) return true;
      try {
        const o = parseOptions(stored.slice(i + 1));
        return (
          o.algorithm !== ARGON2ID ||
          o.memoryCost < params.memoryCost ||
          o.timeCost < params.timeCost ||
          o.parallelism !== params.parallelism
        );
      } catch {
        return true;
      }
    },
  };
  return hasher;
}

/** SR-06 (NIST SP 800-63B-4): Länge statt Komposition, Blockliste, kein Zwangswechsel. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordProblem = "too_short" | "too_long" | "blocked" | "contains_email";

// shortcut: kleine eingebaute Liste, vor Produktivbetrieb durch eine Breach-Liste (z. B. HIBP
// k-Anonymity oder SecLists) hinter `PasswordBlocklist` ersetzen.
const COMMON = new Set(
  [
    "passwordpassword",
    "password1234",
    "password12345",
    "passwort1234",
    "passwort12345",
    "passwort123456",
    "123456789012",
    "1234567890123",
    "12345678901234",
    "123456789abc",
    "qwertzuiopasdf",
    "qwertyuiopasdf",
    "qwertzuiop12",
    "qwertyuiop12",
    "abcdefghijkl",
    "abcd12345678",
    "iloveyou1234",
    "welcome12345",
    "willkommen123",
    "stammbuch1234",
    "administrator",
    "adminadmin123",
    "letmein123456",
    "changeme1234",
    "000000000000",
    "111111111111",
    "aaaaaaaaaaaa",
    "zuerich123456",
    "schweiz123456",
  ].map((p) => p.toLowerCase()),
);

export const builtinBlocklist: PasswordBlocklist = {
  isBlocked: (pw) => Promise.resolve(COMMON.has(pw.normalize("NFKC").toLowerCase())),
};

export async function checkPasswordPolicy(
  password: string,
  email: string,
  blocklist: PasswordBlocklist = builtinBlocklist,
): Promise<PasswordProblem | null> {
  const len = [...password.normalize("NFKC")].length;
  if (len < PASSWORD_MIN_LENGTH) return "too_short";
  if (len > PASSWORD_MAX_LENGTH) return "too_long";
  const local = email.split("@")[0] ?? "";
  if (local.length >= 4 && password.toLowerCase().includes(local.toLowerCase())) {
    return "contains_email";
  }
  if (new Set(password).size < 4) return "blocked"; // z. B. "aaaaaaaaaaaaaa"
  return (await blocklist.isBlocked(password)) ? "blocked" : null;
}
