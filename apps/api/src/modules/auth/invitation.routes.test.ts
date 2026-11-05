import { describe, expect, it } from "vitest";
import { MEMORY_TENANT } from "./memory.js";
import { MAX_INVITATION_FAILURES } from "./types.js";
import { PASSWORD, ORIGIN, setup } from "./auth.testkit.js";
import { base32Decode } from "./base32.js";
import { SESSION_COOKIE } from "./routes.js";

/**
 * Einladung einlösen (Issue #56) mit den Speicher-Repositories. Dieselben Fälle laufen gegen PostgreSQL in
 * auth.pg.int.test.ts und platform/postgres.pg.test.ts.
 */

const URL = "/auth/invitations/redeem";
const NEW_PASSWORD = "ein-neues-langes-passwort-42";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000bb";
const DAY = 86_400_000;

type T = Awaited<ReturnType<typeof setup>>;

async function withApp<R>(fn: (t: T) => Promise<R>, opts: Parameters<typeof setup>[0] = {}) {
  const t = await setup(opts);
  try {
    return await fn(t);
  } finally {
    await t.app.close();
  }
}

const redeem = (t: T, token: string, password = NEW_PASSWORD, extra: object = {}) =>
  t.req("POST", URL, undefined, { token, password, ...extra });

const NEUTRAL = {
  error: { code: "INVALID_INVITATION", message: "Die Einladung ist ungültig oder abgelaufen." },
};

describe("Einladung einlösen", () => {
  it("der erste Admin eines Kunden: Passwort setzen, 2FA einrichten, danach normal anmelden", () =>
    withApp(async (t) => {
      const token = await t.invitation({ email: "gruender@verein.test" }, OTHER_TENANT);

      const res = await redeem(t, token);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "mfa_setup_required", csrfToken: expect.any(String) });
      const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
      expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/" });
      // Der Benutzer gehört dem Kunden der Einladung und ist aktiv.
      const user = (await t.users.findByEmail("gruender@verein.test"))!;
      expect(user).toMatchObject({ tenantId: OTHER_TENANT, role: "user", disabled: false });
      expect(user.passwordHash).not.toContain(NEW_PASSWORD);

      // Wie nach dem Passwort-Schritt der Anmeldung: nur eine Zwischen-Sitzung, ohne Zugriff.
      const c = { cookie: cookie.value, csrf: res.json().csrfToken as string };
      expect((await t.req("GET", "/auth/me", c)).json().state).toBe("pending");
      expect(
        (await t.req("POST", "/auth/password", c, { currentPassword: "x", newPassword: "y" }))
          .statusCode,
      ).toBe(401);

      const setupRes = await t.req("POST", "/auth/2fa/setup", c);
      expect(setupRes.statusCode).toBe(200);
      const secret = base32Decode(setupRes.json().secret);
      const done = await t.req("POST", "/auth/2fa", c, { code: t.codeAt(secret) });
      expect(done.statusCode).toBe(200);
      expect(done.json().recoveryCodes).toHaveLength(10);
      const full = { cookie: t.cookieOf(done)!.value, csrf: done.json().csrfToken as string };
      expect((await t.req("GET", "/auth/me", full)).json()).toMatchObject({
        state: "authenticated",
        user: { email: "gruender@verein.test", role: "user" },
      });

      // Abmelden und mit dem neuen Passwort samt zweitem Faktor wieder anmelden.
      await t.req("POST", "/auth/logout", full);
      t.clock.advance(30_000); // frischer Zeitschritt für den Code
      const l = await t.login("gruender@verein.test", NEW_PASSWORD);
      expect(l.body.status).toBe("mfa_required");
      const code = await t.req("POST", "/auth/2fa", l.c, { code: t.codeAt(secret) });
      expect(code.statusCode).toBe(200);
      expect((await t.users.findByEmail("gruender@verein.test"))!.tenantId).toBe(OTHER_TENANT);

      const events = t.audit.events.filter((e) => e.type === "invitation_redeemed");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        outcome: "success",
        tenantId: OTHER_TENANT,
        targetUserId: user.id,
        detail: { role: "admin" },
      });
    }));

  it("ein vorhandener, eingeladener Benutzer wird freigegeben; die Rolle kommt aus der Einladung", () =>
    withApp(async (t) => {
      const invited = await t.addUser("neu@verein.test", { disabled: true, passwordHash: "!" });
      const token = await t.invitation({
        email: "neu@verein.test",
        role: "user",
        userId: invited.id,
      });
      expect((await t.users.findByEmail("neu@verein.test"))!.disabled).toBe(true);
      expect((await t.login("neu@verein.test")).res.statusCode).toBe(401);

      expect((await redeem(t, token)).statusCode).toBe(200);
      const after = (await t.users.findByEmail("neu@verein.test"))!;
      expect(after).toMatchObject({ id: invited.id, disabled: false });
      expect(t.audit.events.find((e) => e.type === "invitation_redeemed")).toMatchObject({
        detail: { role: "user" },
      });
      expect((await t.login("neu@verein.test", NEW_PASSWORD)).res.statusCode).toBe(200);
    }));

  it("ein Token gilt genau einmal", () =>
    withApp(async (t) => {
      const token = await t.invitation({ email: "einmal@verein.test" });
      expect((await redeem(t, token)).statusCode).toBe(200);
      const second = await redeem(t, token, "ein-anderes-passwort-77");
      expect(second.statusCode).toBe(400);
      expect(second.json()).toEqual(NEUTRAL);
      // Das erste Passwort gilt weiter, das zweite wurde nie gesetzt.
      expect((await t.login("einmal@verein.test", NEW_PASSWORD)).res.statusCode).toBe(200);
      expect((await t.login("einmal@verein.test", "ein-anderes-passwort-77")).res.statusCode).toBe(
        401,
      );
    }));

  it("gleichzeitig eingelöst gewinnt genau eine Anfrage", () =>
    withApp(async (t) => {
      const token = await t.invitation({ email: "rennen@verein.test" });
      const results = await Promise.all(
        [1, 2, 3, 4].map((i) => redeem(t, token, `passwort-nummer-${i}-lang`)),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400, 400, 400]);
    }));

  it("abgelaufen, schon benutzt, falsch und unbekannt liefern dieselbe Antwort", () =>
    withApp(async (t) => {
      const used = await t.invitation({ email: "benutzt@verein.test" });
      await redeem(t, used);
      const expired = await t.invitation({ email: "alt@verein.test" });
      t.clock.advance(7 * DAY + 1000);
      const fresh = await t.invitation({ email: "frisch@verein.test" });

      const answers = [
        await redeem(t, used), // benutzt
        await redeem(t, expired), // abgelaufen
        await redeem(t, "x".repeat(43)), // unbekannt
        await redeem(t, fresh.slice(0, -1) + (fresh.endsWith("A") ? "B" : "A")), // fast richtig
        await redeem(t, "kein base64url!"), // beschädigt
      ];
      for (const a of answers) {
        expect(a.statusCode).toBe(400);
        expect(a.json()).toEqual(NEUTRAL);
        expect(a.cookies).toHaveLength(0);
      }
      expect(await t.users.findByEmail("alt@verein.test")).toBeNull();
      // Die gültige Einladung ist davon unberührt.
      expect((await redeem(t, fresh)).statusCode).toBe(200);
    }));

  it("schwache Passwörter werden abgelehnt, ohne die Einladung zu verbrauchen", () =>
    withApp(async (t) => {
      const token = await t.invitation({ email: "schwach.anna@verein.test" });
      const weak = [
        ["kurz", "too_short"],
        ["passwordpassword", "blocked"],
        ["xx".repeat(70), "too_long"],
        ["mein-schwach.anna-pw", "contains_email"],
      ] as const;
      for (const [password] of weak) {
        const res = await redeem(t, token, password);
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe("WEAK_PASSWORD");
        expect(res.cookies).toHaveLength(0);
      }
      expect(await t.users.findByEmail("schwach.anna@verein.test")).toBeNull();
      expect((await redeem(t, token, PASSWORD)).statusCode).toBe(200);
    }));

  it("ein schwaches Passwort verrät bei ungültigem Token nichts über die Adresse", () =>
    withApp(async (t) => {
      // Ohne gültige Einladung kennt der Server keine Adresse: dieselbe Regel wie für jeden anderen Aufruf.
      const res = await redeem(t, "x".repeat(43), "kurz");
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("WEAK_PASSWORD");
    }));

  it("ein aktives Konto lässt sich über eine Einladung nicht übernehmen", () =>
    withApp(async (t) => {
      const victim = await t.addUser("opfer@verein.test");
      const token = await t.invitation({ email: "opfer@verein.test" });
      const res = await redeem(t, token, "uebernahme-passwort-123");
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual(NEUTRAL);
      const same = (await t.users.findByEmail("opfer@verein.test"))!;
      expect(same.passwordHash).toBe(victim.passwordHash);
      // Auch mit Benutzer-Verweis auf ein aktives Konto.
      const viaId = await t.invitation({ email: "opfer@verein.test", userId: victim.id });
      expect((await redeem(t, viaId, "uebernahme-passwort-123")).statusCode).toBe(400);
      expect((await t.users.findByEmail("opfer@verein.test"))!.passwordHash).toBe(
        victim.passwordHash,
      );
    }));

  it("Mandant und Rolle kommen aus der Einladung, nie aus der Anfrage", () =>
    withApp(async (t) => {
      const a = await t.invitation({ email: "a@verein.test", role: "user" }, MEMORY_TENANT);
      const b = await t.invitation({ email: "b@verein.test", role: "admin" }, OTHER_TENANT);
      const forged = { tenantId: OTHER_TENANT, role: "chief_admin", kunden_rolle: "admin" };
      expect((await redeem(t, a, NEW_PASSWORD, forged)).statusCode).toBe(200);
      expect((await redeem(t, b, NEW_PASSWORD, forged)).statusCode).toBe(200);
      expect(await t.users.findByEmail("a@verein.test")).toMatchObject({
        tenantId: MEMORY_TENANT,
        role: "user",
      });
      expect(await t.users.findByEmail("b@verein.test")).toMatchObject({
        tenantId: OTHER_TENANT,
        role: "user",
      });
      const roles = t.audit.events
        .filter((e) => e.type === "invitation_redeemed")
        .map((e) => [e.tenantId, e.detail?.["role"]]);
      expect(roles).toEqual([
        [MEMORY_TENANT, "user"],
        [OTHER_TENANT, "admin"],
      ]);
    }));

  it("rotiert eine mitgeschickte Sitzung und protokolliert Fehlversuche ohne Token", () =>
    withApp(async (t) => {
      await t.addUser("vorher@verein.test");
      const before = await t.login("vorher@verein.test");
      const token = await t.invitation({ email: "rotation@verein.test" });
      const res = await t.req("POST", URL, before.c, { token, password: NEW_PASSWORD });
      expect(res.statusCode).toBe(200);
      expect(t.cookieOf(res)!.value).not.toBe(before.c.cookie);
      expect((await t.req("GET", "/auth/me", before.c)).statusCode).toBe(401);

      await redeem(t, "x".repeat(43));
      const failure = t.audit.events.find((e) => e.type === "invitation_rejected");
      expect(failure).toMatchObject({ outcome: "failure", tenantId: null });
      expect(JSON.stringify(t.audit.events)).not.toContain(token);
      expect(JSON.stringify(t.audit.events)).not.toContain(NEW_PASSWORD);
    }));

  it("prüft Eingaben und die Origin", () =>
    withApp(async (t) => {
      for (const body of [
        {},
        { token: "a" },
        { password: NEW_PASSWORD },
        { token: 1, password: "x" },
      ]) {
        const res = await t.req("POST", URL, undefined, body);
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe("VALIDATION");
      }
      const big = await t.req("POST", URL, undefined, {
        token: "t".repeat(300),
        password: PASSWORD,
      });
      expect(big.statusCode).toBe(400);
      const token = await t.invitation({ email: "origin@verein.test" });
      const foreign = await t.req(
        "POST",
        URL,
        undefined,
        { token, password: NEW_PASSWORD },
        {
          origin: "https://evil.test",
        },
      );
      expect(foreign.statusCode).toBe(403);
      const own = await t.req(
        "POST",
        URL,
        undefined,
        { token, password: NEW_PASSWORD },
        {
          origin: ORIGIN,
        },
      );
      expect(own.statusCode).toBe(200);
    }));

  it("begrenzt die öffentliche Route pro IP (SR-71)", () =>
    withApp(
      async (t) => {
        const codes: number[] = [];
        for (let i = 0; i < 5; i++) codes.push((await redeem(t, "x".repeat(43))).statusCode);
        expect(codes).toEqual([400, 400, 400, 429, 429]);
      },
      { config: { rateLimitMax: 3 } },
    ));

  it("der erste Admin bekommt den Namen aus der Einladung, sonst den Teil der Adresse vor dem @", () =>
    withApp(async (t) => {
      const named = await t.invitation({ email: "eva@verein.test", name: "Eva Gründerin" });
      const plain = await t.invitation({ email: "paul.muster@verein.test" });
      expect((await redeem(t, named)).statusCode).toBe(200);
      expect((await redeem(t, plain)).statusCode).toBe(200);
      expect((await t.users.findByEmail("eva@verein.test"))!.name).toBe("Eva Gründerin");
      expect((await t.users.findByEmail("paul.muster@verein.test"))!.name).toBe("paul.muster");
    }));

  it("sperrt die Einladung nach 10 Fehlversuchen, auch für das richtige Passwort", () =>
    withApp(async (t) => {
      const token = await t.invitation({ email: "gesperrt@verein.test" });
      const other = await t.invitation({ email: "daneben@verein.test" });
      for (let i = 0; i < MAX_INVITATION_FAILURES; i++) {
        expect((await redeem(t, token, "kurz")).json().error.code).toBe("WEAK_PASSWORD");
      }
      // Ab jetzt wie eine unbekannte Einladung: kein Hinweis, dass es sie gab.
      const res = await redeem(t, token, NEW_PASSWORD);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual(NEUTRAL);
      expect(await t.users.findByEmail("gesperrt@verein.test")).toBeNull();
      expect(t.audit.events.filter((e) => e.type === "invitation_failure")).toHaveLength(10);
      expect(JSON.stringify(t.audit.events)).not.toContain(token);
      // Andere Einladungen bleiben unberührt (die Sperre gilt pro Einladung).
      expect((await redeem(t, other)).statusCode).toBe(200);
    }));

  it("vor der Schwelle bleibt die Einladung gültig", () =>
    withApp(async (t) => {
      const token = await t.invitation({ email: "knapp@verein.test" });
      for (let i = 0; i < MAX_INVITATION_FAILURES - 1; i++) await redeem(t, token, "kurz");
      expect((await redeem(t, token)).statusCode).toBe(200);
    }));

  it("unbekannte Tokens zählen nirgends und sperren niemanden", () =>
    withApp(async (t) => {
      const token = await t.invitation({ email: "ruhig@verein.test" });
      for (let i = 0; i < 15; i++) await redeem(t, `unbekannt-${i}-`.padEnd(43, "x"));
      expect(t.audit.events.filter((e) => e.type === "invitation_failure")).toHaveLength(0);
      expect((await redeem(t, token)).statusCode).toBe(200);
    }));

  it("ohne Einladungs-Repository lässt sich nichts einlösen (fail closed)", async () => {
    const { buildApp } = await import("../../app.js");
    const { loadConfig } = await import("../../config.js");
    const { MemoryAuditRepo, MemorySessionRepo, MemoryThrottleRepo, MemoryUserRepo } =
      await import("./memory.js");
    const { testConfig, FakeMail } = await import("./auth.testkit.js");
    const app = await buildApp(loadConfig({ LOG_LEVEL: "silent" }), false, {
      auth: {
        config: testConfig(),
        users: new MemoryUserRepo(),
        sessions: new MemorySessionRepo(),
        throttle: new MemoryThrottleRepo(),
        audit: new MemoryAuditRepo(),
        mail: new FakeMail(),
      },
    });
    const res = await app.inject({
      method: "POST",
      url: URL,
      payload: { token: "x".repeat(43), password: NEW_PASSWORD },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(NEUTRAL);
    await app.close();
  });
});
