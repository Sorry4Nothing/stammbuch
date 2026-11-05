import { createCipheriv, randomBytes } from "node:crypto";
import { totpBoxFromEnv } from "@stammbuch/mail";
import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode } from "./base32.js";
import { loadAuthConfig } from "./config.js";
import { ARGON2_MIN, checkPasswordPolicy, createPasswordHasher } from "./password.js";
import { generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode } from "./recovery.js";
import { decryptSecret, encryptSecret } from "./secretbox.js";
import { FAILURE_DECAY_MS, LOCK_MAX_MS, lockedForSeconds, nextFailureState } from "./throttle.js";
import { hotp, otpauthUri, totpCounter, verifyTotp } from "./totp.js";
import type { ThrottleState } from "./types.js";

const RFC_SECRET = Buffer.from("12345678901234567890");

describe("Base32", () => {
  it("entspricht RFC 4648", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI").toString()).toBe("foobar");
  });
  it("Rundreise mit Zufallsdaten", () => {
    for (let n = 1; n < 40; n++) {
      const b = randomBytes(n);
      expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
    }
  });
  it("lehnt ungültige Zeichen ab", () => {
    expect(() => base32Decode("0189")).toThrow();
  });
});

describe("HOTP/TOTP (RFC 4226 / RFC 6238)", () => {
  it("HOTP-Testvektoren aus RFC 4226 Anhang D", () => {
    const expected = [
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ];
    expected.forEach((code, i) => expect(hotp(RFC_SECRET, i)).toBe(code));
  });

  it("TOTP-Testvektoren (SHA-1, 8 Stellen) aus RFC 6238 Anhang B", () => {
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [t, code] of vectors) expect(hotp(RFC_SECRET, Math.floor(t / 30), 8)).toBe(code);
  });

  describe("Zeitfenster", () => {
    const now = 1_700_000_010_000;
    const c = totpCounter(now);
    it("akzeptiert den aktuellen Schritt und liefert den Zähler", () => {
      expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, c), now)).toBe(c);
    });
    it("toleriert genau einen Schritt Uhrabweichung in beide Richtungen", () => {
      expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, c - 1), now)).toBe(c - 1);
      expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, c + 1), now)).toBe(c + 1);
    });
    it("lehnt zwei Schritte Abweichung ab", () => {
      expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, c - 2), now)).toBeNull();
      expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, c + 2), now)).toBeNull();
    });
    it("lehnt Format-Verstösse ab", () => {
      for (const bad of ["", "12345", "1234567", "abcdef", "12 456", "١٢٣٤٥٦"]) {
        expect(verifyTotp(RFC_SECRET, bad, now)).toBeNull();
      }
    });
  });

  it("otpauth-URI enthält Parameter und maskierte Beschriftung", () => {
    const uri = otpauthUri(RFC_SECRET, "a+b@x.ch", "Stammbuch");
    expect(uri).toContain("otpauth://totp/Stammbuch:a%2Bb%40x.ch?");
    expect(uri).toContain("secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(uri).toContain("period=30");
    expect(uri).toContain("digits=6");
  });
});

describe("Verschlüsselung der TOTP-Geheimnisse", () => {
  const k = (n: number) => Buffer.alloc(32, n);
  const box = totpBoxFromEnv({ AUTH_TOTP_KEY: randomBytes(32).toString("base64") });
  /** Altformat vor dem Schlüsselring: `v1.<iv>.<tag>.<ct>` mit dem Hauptschlüssel. */
  const legacyEncrypt = (key: Buffer, aad: string, plain: Buffer) => {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return ["v1", iv, c.getAuthTag(), ct]
      .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
      .join(".");
  };

  it("Rundreise", () => {
    const enc = encryptSecret(box, "u1", RFC_SECRET);
    expect(enc).not.toContain(RFC_SECRET.toString("base64url"));
    expect(decryptSecret(box, "u1", enc).equals(RFC_SECRET)).toBe(true);
  });
  it("lehnt falschen Schlüssel, falsche Nutzer-ID und Manipulation ab", () => {
    const enc = encryptSecret(box, "u1", RFC_SECRET);
    const other = totpBoxFromEnv({ AUTH_TOTP_KEY: randomBytes(32).toString("base64") });
    expect(() => decryptSecret(other, "u1", enc)).toThrow();
    expect(() => decryptSecret(box, "u2", enc)).toThrow();
    const [v, id, iv, tag, ct] = enc.split(".");
    const flipped = Buffer.from(ct!, "base64url");
    flipped[0] = flipped[0]! ^ 1;
    expect(() =>
      decryptSecret(box, "u1", [v, id, iv, tag, flipped.toString("base64url")].join(".")),
    ).toThrow();
  });
  it("verwendet pro Verschlüsselung eine neue IV", () => {
    expect(encryptSecret(box, "u1", RFC_SECRET)).not.toBe(encryptSecret(box, "u1", RFC_SECRET));
  });
  it("liest das Altformat ohne Schlüssel-ID mit dem Hauptschlüssel und schreibt es neu im Ringformat", () => {
    const main = k(1);
    const ring = totpBoxFromEnv({
      AUTH_TOTP_KEY: main.toString("base64"),
      AUTH_TOTP_KEYS: `k2:${k(2).toString("base64")}`,
    });
    const old = legacyEncrypt(main, "u1", RFC_SECRET);
    expect(old.split(".")).toHaveLength(4);
    expect(ring.needsRotation(old)).toBe(true);
    expect(decryptSecret(ring, "u1", old).equals(RFC_SECRET)).toBe(true);
    expect(() => decryptSecret(ring, "u2", old)).toThrow();
    const neu = ring.rotate(old, "u1");
    expect(neu.split(".")[1]).toBe("k2");
    expect(ring.needsRotation(neu)).toBe(false);
    expect(decryptSecret(ring, "u1", neu).equals(RFC_SECRET)).toBe(true);
  });
  it("Schlüsselring: aktueller Schlüssel verschlüsselt, alte bleiben lesbar, ohne Ring bleibt der Hauptschlüssel", () => {
    const main = k(1).toString("base64");
    const v1 = totpBoxFromEnv({
      AUTH_TOTP_KEY: main,
      AUTH_TOTP_KEYS: `k1:${k(5).toString("base64")}`,
    });
    expect(v1.currentKeyId).toBe("k1");
    const v2 = totpBoxFromEnv({
      AUTH_TOTP_KEY: main,
      AUTH_TOTP_KEYS: `k1:${k(5).toString("base64")},k2:${k(6).toString("base64")}`,
    });
    expect(v2.currentKeyId).toBe("k2");
    const alt = encryptSecret(v1, "u1", RFC_SECRET);
    expect(decryptSecret(v2, "u1", alt).equals(RFC_SECRET)).toBe(true);
    expect(v2.needsRotation(alt)).toBe(true);
    // Neuer Schlüssel ohne den alten im Ring: Altdaten sind unlesbar, nicht still falsch.
    const v3 = totpBoxFromEnv({
      AUTH_TOTP_KEY: main,
      AUTH_TOTP_KEYS: `k2:${k(6).toString("base64")}`,
    });
    expect(() => decryptSecret(v3, "u1", alt)).toThrow();
    // Ohne Ring verschlüsselt der Hauptschlüssel (Ring-ID `legacy`).
    expect(totpBoxFromEnv({ AUTH_TOTP_KEY: main }).currentKeyId).toBe("legacy");
  });
  it("lehnt fehlerhafte Schlüsselringe ab, ohne Schlüssel im Text", () => {
    const main = k(1).toString("base64");
    expect(() => totpBoxFromEnv({})).toThrow("AUTH_TOTP_KEY");
    expect(() =>
      totpBoxFromEnv({ AUTH_TOTP_KEY: main, AUTH_TOTP_KEYS: "ohne-doppelpunkt" }),
    ).toThrow("AUTH_TOTP_KEYS");
    expect(() => totpBoxFromEnv({ AUTH_TOTP_KEY: main, AUTH_TOTP_KEYS: `legacy:${main}` })).toThrow(
      "reserviert",
    );
    expect(() => totpBoxFromEnv({ AUTH_TOTP_KEY: main, AUTH_TOTP_KEYS: "k1:AAAA" })).toThrow();
    expect(() =>
      totpBoxFromEnv({ AUTH_TOTP_KEY: main, AUTH_TOTP_KEY_ID: "gibt-es-nicht" }),
    ).toThrow();
  });
});

describe("Wiederherstellungscodes", () => {
  it("erzeugt 10 verschiedene Codes mit 80 Bit", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^([A-Z2-9]{4}-){3}[A-Z2-9]{4}$/);
  });
  it("Hash ist schlüsselabhängig und tolerant gegenüber Schreibweise", () => {
    const k1 = randomBytes(32);
    const code = "ABCD-EFGH-JKLM-NPQR";
    expect(hashRecoveryCode(k1, code)).toBe(hashRecoveryCode(k1, "abcd efgh-jklm npqr"));
    expect(hashRecoveryCode(k1, code)).not.toBe(hashRecoveryCode(randomBytes(32), code));
    expect(hashRecoveryCode(k1, code)).not.toContain("ABCD");
    expect(normalizeRecoveryCode(" ab-cd ")).toBe("ABCD");
  });
});

describe("Passwort-Hashing (SR-01)", () => {
  const pepper = [{ id: "p2", secret: "a".repeat(40) }];
  const h = createPasswordHasher(pepper, ARGON2_MIN);

  it("verweigert Parameter unter dem OWASP-Minimum", () => {
    expect(() =>
      createPasswordHasher(pepper, { memoryCost: 8192, timeCost: 2, parallelism: 1 }),
    ).toThrow();
    expect(() =>
      createPasswordHasher(pepper, { memoryCost: 19456, timeCost: 1, parallelism: 1 }),
    ).toThrow();
  });

  it("erzeugt Argon2id mit Pepper-ID und Salt, verifiziert korrekt", async () => {
    const a = await h.hash("geheimes passwort 123");
    const b = await h.hash("geheimes passwort 123");
    expect(a).toMatch(/^p2:\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
    expect(await h.verify(a, "geheimes passwort 123")).toBe(true);
    expect(await h.verify(a, "geheimes passwort 124")).toBe(false);
  });

  it("Standardparameter liegen über dem Minimum", async () => {
    const d = createPasswordHasher(pepper);
    expect(await d.hash("x")).toMatch(/m=65536,t=3,p=1/);
  });

  it("der Pepper geht in den Hash ein", async () => {
    const stored = await h.hash("pw-pw-pw-pw-pw");
    const other = createPasswordHasher([{ id: "p2", secret: "b".repeat(40) }], ARGON2_MIN);
    expect(await other.verify(stored, "pw-pw-pw-pw-pw")).toBe(false);
  });

  it("normalisiert Unicode (NFKC)", async () => {
    const stored = await h.hash("Café-Passwort-1");
    expect(await h.verify(stored, "Café-Passwort-1")).toBe(true);
  });

  it("verweigert kaputte oder fremde Hash-Formate (fail secure)", async () => {
    for (const bad of [
      "",
      "p2:",
      "nope",
      "p9:$argon2id$v=19$m=19456,t=2,p=1$abc$def",
      "p2:$argon2id$kaputt",
    ]) {
      expect(await h.verify(bad, "x")).toBe(false);
    }
  });

  it("Pepper-Rotation: alte Hashes bleiben prüfbar und werden zum Rehash gemeldet", async () => {
    const oldHash = await h.hash("pw-pw-pw-pw-pw");
    const rotated = createPasswordHasher(
      [{ id: "p3", secret: "c".repeat(40) }, ...pepper],
      ARGON2_MIN,
    );
    expect(await rotated.verify(oldHash, "pw-pw-pw-pw-pw")).toBe(true);
    expect(rotated.needsRehash(oldHash)).toBe(true);
    expect(rotated.needsRehash(await rotated.hash("x"))).toBe(false);
  });

  it("meldet Rehash, wenn die Parameter angehoben wurden", async () => {
    const stored = await h.hash("pw-pw-pw-pw-pw");
    const stronger = createPasswordHasher(pepper, {
      memoryCost: 32768,
      timeCost: 2,
      parallelism: 1,
    });
    expect(stronger.needsRehash(stored)).toBe(true);
    expect(h.needsRehash(stored)).toBe(false);
    expect(h.needsRehash("garbage")).toBe(true);
  });
});

describe("Passwortregeln (SR-06)", () => {
  it("verlangt Länge, aber keine Zeichenklassen", async () => {
    expect(await checkPasswordPolicy("kurz", "a@b.ch")).toBe("too_short");
    expect(await checkPasswordPolicy("nurkleinbuchstaben", "a@b.ch")).toBeNull();
    expect(await checkPasswordPolicy("ein ganzer satz als passwort", "a@b.ch")).toBeNull();
  });
  it("erlaubt mindestens 64 Zeichen, begrenzt bei 128", async () => {
    expect(await checkPasswordPolicy("ab".repeat(32) + "cd".repeat(10), "a@b.ch")).toBeNull();
    expect(await checkPasswordPolicy("ab1".repeat(50), "a@b.ch")).toBe("too_long");
  });
  it("lehnt Blockliste, Wiederholungen und E-Mail-Bestandteile ab", async () => {
    expect(await checkPasswordPolicy("Passwort123456", "a@b.ch")).toBe("blocked");
    expect(await checkPasswordPolicy("aaaaaaaaaaaaaa", "a@b.ch")).toBe("blocked");
    expect(await checkPasswordPolicy("robin.lehmann-geheim", "robin.lehmann@x.ch")).toBe(
      "contains_email",
    );
  });
  it("nutzt eine austauschbare Blockliste", async () => {
    const bl = { isBlocked: (p: string) => Promise.resolve(p === "geleakt-aber-lang-genug") };
    expect(await checkPasswordPolicy("geleakt-aber-lang-genug", "a@b.ch", bl)).toBe("blocked");
  });
});

describe("Sperre mit Backoff (SR-04)", () => {
  const t0 = new Date("2026-11-04T10:00:00Z");
  const at = (ms: number) => new Date(t0.getTime() + ms);

  it("sperrt erst ab dem 5. Fehlversuch und verdoppelt die Dauer bis zum Maximum", () => {
    let s: ThrottleState | null = null;
    const locks: number[] = [];
    for (let i = 0; i < 12; i++) {
      s = nextFailureState(s, at(i));
      locks.push(lockedForSeconds(s, at(i)));
    }
    expect(locks.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(locks.slice(4, 8)).toEqual([60, 120, 240, 480]);
    expect(Math.max(...locks)).toBe(LOCK_MAX_MS / 1000);
  });

  it("ist nach Ablauf der Sperre wieder frei", () => {
    let s: ThrottleState | null = null;
    for (let i = 0; i < 5; i++) s = nextFailureState(s, t0);
    expect(lockedForSeconds(s, t0)).toBe(60);
    expect(lockedForSeconds(s, at(60_000))).toBe(0);
  });

  it("vergisst alte Fehlversuche nach 24 h", () => {
    let s: ThrottleState | null = null;
    for (let i = 0; i < 4; i++) s = nextFailureState(s, t0);
    s = nextFailureState(s, at(FAILURE_DECAY_MS + 1));
    expect(s.failures).toBe(1);
    expect(s.lockedUntil).toBeNull();
  });
});

describe("Konfiguration", () => {
  const ok = {
    AUTH_PEPPERS: `p1:${"s".repeat(40)}`,
    AUTH_TOTP_KEY: randomBytes(32).toString("base64"),
    APP_ORIGIN: "https://app.example.ch/pfad",
  };
  it("lädt gültige Werte und reduziert die Origin", () => {
    const c = loadAuthConfig(ok);
    expect(c.appOrigin).toBe("https://app.example.ch");
    expect(c.peppers).toEqual([{ id: "p1", secret: "s".repeat(40) }]);
  });
  it("bricht bei schwachen oder fehlenden Secrets ab", () => {
    expect(() => loadAuthConfig({ ...ok, AUTH_PEPPERS: "p1:kurz" })).toThrow();
    expect(() => loadAuthConfig({ ...ok, AUTH_TOTP_KEY: "AAAA" })).toThrow();
    expect(() =>
      loadAuthConfig({ ...ok, AUTH_PEPPERS: `p1:${"s".repeat(40)},p1:${"t".repeat(40)}` }),
    ).toThrow();
    expect(() => loadAuthConfig({})).toThrow();
  });
});
