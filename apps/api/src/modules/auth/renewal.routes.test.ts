import { describe, expect, it } from "vitest";
import { base32Decode } from "./base32.js";
import { setup, PASSWORD } from "./auth.testkit.js";

const EMAIL = "anna@verein.test";

async function scenario() {
  const t = await setup();
  await t.addUser(EMAIL);
  const e = await t.enroll(EMAIL);
  t.clock.advance(30_000);
  const f = await t.fullLogin(EMAIL, e.secret);
  /** Schritt 1 mit frischem Code des bisherigen Faktors (jünger als der der Anmeldung). */
  const begin = (c = f.c, code?: string) => {
    t.clock.advance(30_000);
    return t.req("POST", "/auth/2fa/renew", c, { code: code ?? t.codeAt(e.secret) });
  };
  return { t, e, f, begin };
}

describe("Angaben zur eigenen Anmeldung", () => {
  it("verlangt eine volle Sitzung", async () => {
    const t = await setup();
    await t.addUser(EMAIL);
    expect((await t.req("GET", "/auth/security")).statusCode).toBe(401);
    const pending = await t.login(EMAIL);
    expect((await t.req("GET", "/auth/security", pending.c)).statusCode).toBe(401);
    await t.app.close();
  });

  it("liefert Datum der Einrichtung, Zahl unbenutzter Codes und letzte Passwortänderung", async () => {
    const { t, e, f } = await scenario();
    const before = (await t.req("GET", "/auth/security", f.c)).json();
    expect(before).toEqual({
      passwordChangedAt: null, // unbekannt statt erfunden
      totpSince: expect.any(String),
      recoveryLeft: 10,
      recoveryTotal: 10,
    });
    expect(Object.keys(before).sort()).toEqual([
      "passwordChangedAt",
      "recoveryLeft",
      "recoveryTotal",
      "totpSince",
    ]);

    // Ein Wiederherstellungscode verbraucht: 9 übrig.
    const l = await t.login(EMAIL);
    expect(
      (await t.req("POST", "/auth/recovery", l.c, { code: e.recoveryCodes[0] })).statusCode,
    ).toBe(200);
    const pw = await t.req("POST", "/auth/password", f.c, {
      currentPassword: PASSWORD,
      newPassword: "neues-sehr-langes-passwort-42",
    });
    expect(pw.statusCode).toBe(200);
    const after = (
      await t.req("GET", "/auth/security", {
        cookie: t.cookieOf(pw)!.value,
        csrf: pw.json().csrfToken,
      })
    ).json();
    expect(after.recoveryLeft).toBe(9);
    expect(Date.now() - Date.parse(after.passwordChangedAt)).toBeLessThan(60_000);
    await t.app.close();
  });

  it("hält die letzte volle Anmeldung fest, nicht die Zwischenstufe", async () => {
    const t = await setup();
    const user = await t.addUser(EMAIL);
    expect((await t.users.findById(user.tenantId, user.id))!.lastLoginAt).toBeNull();
    const e = await t.enroll(EMAIL);
    const first = t.clock.now();
    expect((await t.users.findById(user.tenantId, user.id))!.lastLoginAt).toEqual(first);
    t.clock.advance(30_000);
    await t.login(EMAIL); // nur Passwort: noch keine Anmeldung
    expect((await t.users.findById(user.tenantId, user.id))!.lastLoginAt).toEqual(first);
    await t.fullLogin(EMAIL, e.secret);
    expect((await t.users.findById(user.tenantId, user.id))!.lastLoginAt).toEqual(t.clock.now());
    await t.app.close();
  });
});

describe("2FA im angemeldeten Zustand neu einrichten", () => {
  it("ohne Code, mit falschem oder verbrauchtem Code gibt es keinen neuen Schlüssel", async () => {
    const { t, e, f, begin } = await scenario();
    expect((await t.req("POST", "/auth/2fa/renew", f.c, {})).statusCode).toBe(400);
    const wrong = await begin(f.c, "000000");
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe("INVALID_CODE");
    expect(wrong.body).not.toContain("secret");
    // Der Code der Anmeldung ist schon verbraucht (Replay-Schutz): nicht «frisch».
    t.clock.advance(-30_000);
    const used = await t.req("POST", "/auth/2fa/renew", f.c, { code: t.codeAt(e.secret) });
    expect(used.statusCode).toBe(401);
    const types = (await t.audit.list({})).map((x) => x.type);
    expect(types.filter((x) => x === "stepup_failure").length).toBeGreaterThanOrEqual(2);
    await t.app.close();
  });

  it("verlangt CSRF-Token und eine volle Sitzung", async () => {
    const { t, e, f } = await scenario();
    t.clock.advance(30_000);
    const code = t.codeAt(e.secret);
    for (const url of ["/auth/2fa/renew", "/auth/2fa/renew/confirm"]) {
      expect((await t.req("POST", url, { ...f.c, csrf: undefined }, { code })).statusCode).toBe(
        403,
      );
      expect((await t.req("POST", url, undefined, { code })).statusCode).toBe(401);
      const pending = await t.login(EMAIL);
      expect((await t.req("POST", url, pending.c, { code })).statusCode).toBe(401);
    }
    await t.app.close();
  });

  it("ohne Schritt 1 lässt sich nichts bestätigen", async () => {
    const { t, e, f } = await scenario();
    t.clock.advance(30_000);
    const res = await t.req("POST", "/auth/2fa/renew/confirm", f.c, { code: t.codeAt(e.secret) });
    expect(res.statusCode).toBe(401);
    await t.app.close();
  });

  it("ersetzt den Schlüssel erst nach dem ersten Code des neuen Schlüssels", async () => {
    const { t, e, f, begin } = await scenario();
    const user = (await t.users.findByEmail(EMAIL))!;
    // Eine zweite Sitzung, die durch die Erneuerung enden muss.
    const other = await t.fullLogin(EMAIL, e.secret);
    const started = await begin();
    expect(started.statusCode).toBe(200);
    const fresh = base32Decode(started.json().secret);
    expect(started.json().otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(Object.keys(started.json()).sort()).toEqual(["otpauthUri", "secret"]);

    // Bis zur Bestätigung gilt der bisherige Schlüssel.
    const same = (await t.users.findById(user.tenantId, user.id))!;
    expect(same.totpSecretEnc).toBe(user.totpSecretEnc);

    // Falscher Code: nichts ändert sich, der Fehlversuch zählt.
    t.clock.advance(30_000);
    const bad = await t.req("POST", "/auth/2fa/renew/confirm", f.c, { code: "000000" });
    expect(bad.statusCode).toBe(401);
    // Der Code des alten Schlüssels bestätigt nicht.
    const oldKey = await t.req("POST", "/auth/2fa/renew/confirm", f.c, {
      code: t.codeAt(e.secret),
    });
    expect(oldKey.statusCode).toBe(401);
    expect((await t.users.findById(user.tenantId, user.id))!.totpSecretEnc).toBe(
      user.totpSecretEnc,
    );

    t.mail.sent.length = 0;
    const done = await t.req("POST", "/auth/2fa/renew/confirm", f.c, { code: t.codeAt(fresh) });
    expect(done.statusCode).toBe(204);
    const after = (await t.users.findById(user.tenantId, user.id))!;
    expect(after.totpSecretEnc).not.toBe(user.totpSecretEnc);
    expect(after.recoveryCodeHashes).toHaveLength(10); // Wiederherstellungscodes bleiben

    // Die laufende Sitzung bleibt, andere enden.
    expect((await t.req("GET", "/auth/me", f.c)).statusCode).toBe(200);
    expect((await t.req("GET", "/auth/me", other.c)).statusCode).toBe(401);
    // Derselbe Code lässt sich nicht erneut bestätigen (Schritt 1 ist verbraucht).
    expect(
      (await t.req("POST", "/auth/2fa/renew/confirm", f.c, { code: t.codeAt(fresh) })).statusCode,
    ).toBe(401);

    // Anmeldung: nur noch der neue Schlüssel gilt.
    t.clock.advance(60_000);
    const l = await t.login(EMAIL);
    expect((await t.req("POST", "/auth/2fa", l.c, { code: t.codeAt(e.secret) })).statusCode).toBe(
      401,
    );
    const l2 = await t.login(EMAIL);
    expect((await t.req("POST", "/auth/2fa", l2.c, { code: t.codeAt(fresh) })).statusCode).toBe(
      200,
    );

    await t.flush();
    expect(t.mail.sent.map((m) => m.kind)).toContain("mfa_renewed");
    const types = (await t.audit.list({})).map((x) => x.type);
    expect(types).toContain("mfa_renewed");
    expect(types).toContain("mfa_failure");
    await t.app.close();
  });

  it("fünf falsche Bestätigungen beenden die Sitzung", async () => {
    const { t, f, begin } = await scenario();
    await begin();
    for (let i = 0; i < 5; i++) {
      t.clock.advance(1_000);
      await t.req("POST", "/auth/2fa/renew/confirm", f.c, { code: "000000" });
    }
    expect((await t.req("GET", "/auth/me", f.c)).statusCode).toBe(401);
    await t.app.close();
  });
});
