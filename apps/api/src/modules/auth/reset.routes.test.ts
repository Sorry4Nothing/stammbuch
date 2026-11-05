import { describe, expect, it } from "vitest";
import { MEMORY_TENANT } from "./memory.js";
import { ORIGIN, PASSWORD, setup } from "./auth.testkit.js";

/**
 * «Passwort vergessen» (Issue #65) und eigener Name (Issue #66) mit den Speicher-Repositories. Dieselben Fälle
 * laufen gegen PostgreSQL in auth.pg.int.test.ts.
 */

const REQUEST = "/auth/password-reset/request";
const CONFIRM = "/auth/password-reset/confirm";
const NEW_PASSWORD = "ein-neues-langes-passwort-42";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000bb";
const MINUTE = 60_000;

type T = Awaited<ReturnType<typeof setup>>;

async function withApp<R>(fn: (t: T) => Promise<R>, opts: Parameters<typeof setup>[0] = {}) {
  const t = await setup(opts);
  try {
    return await fn(t);
  } finally {
    await t.app.close();
  }
}

const ask = (t: T, email: string) => t.req("POST", REQUEST, undefined, { email });
const confirm = (t: T, body: object) => t.req("POST", CONFIRM, undefined, body);

/** Fordert den Link an und liefert sein Token (das sonst nur die Mail trägt). */
async function requestToken(t: T, email: string) {
  const res = await ask(t, email);
  expect(res.statusCode).toBe(204);
  await t.flush();
  return t.mail.lastResetToken();
}

const NEUTRAL = {
  error: {
    code: "INVALID_RESET",
    message: "Der Link oder der Code ist ungültig oder abgelaufen.",
  },
};

describe("Passwort vergessen: Link anfordern", () => {
  it("bekannte und unbekannte Adressen bekommen genau dieselbe Antwort; nur das Konto bekommt eine Mail", () =>
    withApp(async (t) => {
      await t.addUser("anna@verein.test");
      const known = await ask(t, "anna@verein.test");
      const unknown = await ask(t, "gibts-nicht@verein.test");
      await t.flush();

      for (const r of [known, unknown]) {
        expect(r.statusCode).toBe(204);
        expect(r.body).toBe("");
        expect(r.cookies).toHaveLength(0);
      }
      expect(known.headers).toMatchObject({ "cache-control": "no-store" });
      expect(Object.keys(known.headers).sort()).toEqual(Object.keys(unknown.headers).sort());

      expect(t.mail.resets).toHaveLength(1);
      const mail = t.mail.resets[0]!;
      expect(mail.to).toBe("anna@verein.test");
      const link = new URL(mail.link);
      // Token im Fragment: weder in Zugriffsprotokollen noch im Referer (wie bei der Einladung).
      expect(link.origin + link.pathname).toBe(`${ORIGIN}/passwort-zuruecksetzen`);
      expect(link.hash.slice(1)).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 Bit
      expect(mail.expiresAt.getTime() - t.clock.t.getTime()).toBe(30 * MINUTE);
    }));

  it("unabhängig von Gross-/Kleinschreibung und Leerraum der Adresse", () =>
    withApp(async (t) => {
      await t.addUser("anna@verein.test");
      expect((await ask(t, "  Anna@Verein.TEST ")).statusCode).toBe(204);
      await t.flush();
      expect(t.mail.resets).toHaveLength(1);
    }));

  it("dauert für bekannte und unbekannte Adressen gleich lang (Mindestdauer)", () =>
    withApp(
      async (t) => {
        await t.addUser("anna@verein.test");
        const time = async (email: string) => {
          const t0 = performance.now();
          await ask(t, email);
          return performance.now() - t0;
        };
        expect(await time("anna@verein.test")).toBeGreaterThanOrEqual(110);
        expect(await time("niemand@verein.test")).toBeGreaterThanOrEqual(110);
      },
      { resetMinMs: 120 },
    ));

  it("sendet nichts an gesperrte oder noch nicht aktivierte Konten, antwortet aber gleich", () =>
    withApp(async (t) => {
      await t.addUser("aus@verein.test", { disabled: true });
      expect((await ask(t, "aus@verein.test")).statusCode).toBe(204);
      await t.flush();
      expect(t.mail.resets).toHaveLength(0);
    }));

  it("höchstens 3 Links pro Stunde und Konto; die vierte Anfrage wirkt gleich, sendet aber nichts", () =>
    withApp(async (t) => {
      await t.addUser("anna@verein.test");
      for (let i = 0; i < 4; i++) {
        t.clock.advance(MINUTE);
        expect((await ask(t, "anna@verein.test")).statusCode).toBe(204);
      }
      await t.flush();
      expect(t.mail.resets).toHaveLength(3);
      // Nach einer Stunde geht es wieder.
      t.clock.advance(60 * MINUTE);
      await ask(t, "anna@verein.test");
      await t.flush();
      expect(t.mail.resets).toHaveLength(4);
    }));

  it("begrenzt die Route pro IP auf die Hälfte des Auth-Limits (SR-04, SR-71)", () =>
    withApp(
      async (t) => {
        const codes: number[] = [];
        for (let i = 0; i < 7; i++) codes.push((await ask(t, `x${i}@verein.test`)).statusCode);
        expect(codes.filter((c) => c === 204)).toHaveLength(5);
        expect(codes.filter((c) => c === 429)).toHaveLength(2);
      },
      { config: { rateLimitMax: 10 } },
    ));

  it("lehnt eine ungültige Adresse und eine fremde Origin ab", () =>
    withApp(async (t) => {
      expect((await t.req("POST", REQUEST, undefined, { email: "keine-adresse" })).statusCode).toBe(
        400,
      );
      expect((await t.req("POST", REQUEST, undefined, {})).statusCode).toBe(400);
      const res = await t.req(
        "POST",
        REQUEST,
        undefined,
        { email: "a@verein.test" },
        { origin: "https://evil.test" },
      );
      expect(res.statusCode).toBe(403);
    }));

  it("ein Fehler beim Mailversand ändert die Antwort nicht und steht im Protokoll, ohne Token", () =>
    withApp(async (t) => {
      await t.addUser("anna@verein.test");
      t.mail.failing = true;
      expect((await ask(t, "anna@verein.test")).statusCode).toBe(204);
      await t.flush();
      expect(t.audit.events.find((e) => e.type === "notice_failed")).toMatchObject({
        outcome: "failure",
        detail: { kind: "password_reset" },
      });
    }));

  it("protokolliert jede Anfrage, nie die Adresse im Klartext und nie das Token", () =>
    withApp(async (t) => {
      await t.addUser("anna@verein.test");
      const token = await requestToken(t, "anna@verein.test");
      await ask(t, "gibts-nicht@verein.test");
      const events = t.audit.events.filter((e) => e.type === "password_reset_requested");
      expect(events.map((e) => e.outcome)).toEqual(["success", "failure"]);
      const text = JSON.stringify(t.audit.events);
      expect(text).not.toContain(token);
      expect(text).not.toContain("anna@verein.test");
      expect(text).not.toContain("gibts-nicht");
    }));
});

describe("Passwort vergessen: neues Passwort setzen", () => {
  it("mit zweitem Faktor: Passwort neu, alle Sitzungen beendet, Anmeldung nur mit neuem Passwort und Code", () =>
    withApp(async (t) => {
      await t.addUser("anna@verein.test");
      const e = await t.enroll("anna@verein.test");
      const token = await requestToken(t, "anna@verein.test");
      t.clock.advance(30_000); // frischer Zeitschritt: der Code der Einrichtung gilt nicht noch einmal

      const res = await confirm(t, { token, password: NEW_PASSWORD, code: t.codeAt(e.secret) });
      expect(res.statusCode).toBe(204);
      // Keine Anmeldung durch das Zurücksetzen: kein Cookie, und die alte Sitzung ist weg.
      expect(res.cookies).toHaveLength(0);
      expect((await t.req("GET", "/auth/me", e.c)).statusCode).toBe(401);

      expect((await t.login("anna@verein.test", PASSWORD)).res.statusCode).toBe(401);
      t.clock.advance(30_000);
      const l = await t.login("anna@verein.test", NEW_PASSWORD);
      expect(l.body.status).toBe("mfa_required");
      expect((await t.req("POST", "/auth/2fa", l.c, { code: t.codeAt(e.secret) })).statusCode).toBe(
        200,
      );

      expect(t.audit.events.find((x) => x.type === "password_reset_done")).toMatchObject({
        outcome: "success",
        tenantId: MEMORY_TENANT,
      });
      expect(t.mail.sent.map((n) => n.kind)).toContain("password_changed");
    }));

  it("das Token gilt genau einmal; ein neuer Link macht den alten ungültig", () =>
    withApp(async (t) => {
      await t.addUser("anna@verein.test");
      const first = await requestToken(t, "anna@verein.test");
      t.clock.advance(MINUTE);
      const second = await requestToken(t, "anna@verein.test");
      expect((await confirm(t, { token: first, password: NEW_PASSWORD })).json()).toEqual(NEUTRAL);
      expect((await confirm(t, { token: second, password: NEW_PASSWORD })).statusCode).toBe(204);
      expect(
        (await confirm(t, { token: second, password: "ein-anderes-passwort-77" })).json(),
      ).toEqual(NEUTRAL);
      expect((await t.login("anna@verein.test", NEW_PASSWORD)).res.statusCode).toBe(200);
    }));

  it("unbekannt, abgelaufen, benutzt und beschädigt liefern dieselbe Antwort", () =>
    withApp(async (t) => {
      await t.addUser("anna@verein.test");
      const used = await requestToken(t, "anna@verein.test");
      await confirm(t, { token: used, password: NEW_PASSWORD });
      t.clock.advance(MINUTE);
      const old = await requestToken(t, "anna@verein.test");
      t.clock.advance(30 * MINUTE + 1000);

      const answers = [
        await confirm(t, { token: used, password: "ein-anderes-passwort-77" }),
        await confirm(t, { token: old, password: NEW_PASSWORD }),
        await confirm(t, { token: "A".repeat(43), password: NEW_PASSWORD }),
        await confirm(t, { token: "kein base64url!", password: NEW_PASSWORD }),
        await confirm(t, { token: "0".repeat(64), password: NEW_PASSWORD }),
      ];
      for (const a of answers) {
        expect(a.statusCode).toBe(400);
        expect(a.json()).toEqual(NEUTRAL);
        expect(a.cookies).toHaveLength(0);
      }
    }));

  it("verlangt den zweiten Faktor: ohne Code und mit falschem Code bleibt das Token gültig", () =>
    withApp(async (t) => {
      await t.addUser("anna@verein.test");
      const e = await t.enroll("anna@verein.test");
      const token = await requestToken(t, "anna@verein.test");
      t.clock.advance(30_000);
      const before = (await t.users.findByEmail("anna@verein.test"))!.passwordHash;

      expect((await confirm(t, { token, password: NEW_PASSWORD })).json()).toEqual(NEUTRAL);
      expect((await confirm(t, { token, password: NEW_PASSWORD, code: "000000" })).json()).toEqual(
        NEUTRAL,
      );
      expect(
        (await confirm(t, { token, password: NEW_PASSWORD, code: "AAAA-BBBB-CCCC-DDDD" })).json(),
      ).toEqual(NEUTRAL);
      expect((await t.users.findByEmail("anna@verein.test"))!.passwordHash).toBe(before);
      expect(t.audit.events.filter((x) => x.type === "password_reset_failure")).toHaveLength(3);

      expect(
        (await confirm(t, { token, password: NEW_PASSWORD, code: t.codeAt(e.secret) })).statusCode,
      ).toBe(204);
    }));

  it("ein Wiederherstellungscode genügt, gilt aber nur einmal", () =>
    withApp(async (t) => {
      await t.addUser("anna@verein.test");
      const e = await t.enroll("anna@verein.test");
      const [recovery] = e.recoveryCodes as [string];
      const token = await requestToken(t, "anna@verein.test");
      expect(
        (await confirm(t, { token, password: NEW_PASSWORD, code: recovery.toLowerCase() }))
          .statusCode,
      ).toBe(204);
      expect((await t.users.findByEmail("anna@verein.test"))!.recoveryCodeHashes).toHaveLength(9);

      t.clock.advance(MINUTE);
      const again = await requestToken(t, "anna@verein.test");
      expect(
        (await confirm(t, { token: again, password: "ein-drittes-passwort-123", code: recovery }))
          .statusCode,
      ).toBe(400);
    }));

  it("ein schon benutzter Einmalcode (Replay) wird abgelehnt", () =>
    withApp(async (t) => {
      await t.addUser("anna@verein.test");
      const e = await t.enroll("anna@verein.test"); // verbraucht den Zeitschritt dieses Codes
      const token = await requestToken(t, "anna@verein.test");
      const res = await confirm(t, { token, password: NEW_PASSWORD, code: t.codeAt(e.secret) });
      expect(res.statusCode).toBe(400);
      expect(t.audit.events.some((x) => x.type === "password_reset_failure")).toBe(true);
    }));

  it("ohne eingerichteten zweiten Faktor genügt das Token", () =>
    withApp(async (t) => {
      await t.addUser("neu@verein.test");
      const token = await requestToken(t, "neu@verein.test");
      expect((await confirm(t, { token, password: NEW_PASSWORD })).statusCode).toBe(204);
      const l = await t.login("neu@verein.test", NEW_PASSWORD);
      expect(l.body.status).toBe("mfa_setup_required");
    }));

  it("falsche Codes zählen gegen die Kontosperre; danach hilft auch der richtige Code nicht (429)", () =>
    withApp(async (t) => {
      await t.addUser("anna@verein.test");
      const e = await t.enroll("anna@verein.test");
      const token = await requestToken(t, "anna@verein.test");
      t.clock.advance(30_000);
      for (let i = 0; i < 5; i++) {
        await confirm(t, { token, password: NEW_PASSWORD, code: "000000" });
      }
      const res = await confirm(t, { token, password: NEW_PASSWORD, code: t.codeAt(e.secret) });
      expect(res.statusCode).toBe(429);
      expect(res.headers["retry-after"]).toBeDefined();
      // Auch die Anmeldung ist für dieses Konto gesperrt (gleicher Zähler).
      expect((await t.login("anna@verein.test", PASSWORD)).res.statusCode).toBe(429);
      // Nach der Sperre geht es mit demselben Link weiter.
      t.clock.advance(2 * MINUTE);
      t.clock.advance(30_000);
      expect(
        (await confirm(t, { token, password: NEW_PASSWORD, code: t.codeAt(e.secret) })).statusCode,
      ).toBe(204);
    }));

  it("setzt die Kontosperre durch das erfolgreiche Zurücksetzen zurück", () =>
    withApp(async (t) => {
      await t.addUser("anna@verein.test");
      for (let i = 0; i < 5; i++) await t.login("anna@verein.test", "falsch-falsch-falsch");
      expect((await t.login("anna@verein.test", PASSWORD)).res.statusCode).toBe(429);
      const token = await requestToken(t, "anna@verein.test");
      expect((await confirm(t, { token, password: NEW_PASSWORD })).statusCode).toBe(204);
      expect((await t.login("anna@verein.test", NEW_PASSWORD)).res.statusCode).toBe(200);
    }));

  it("schwache Passwörter werden abgelehnt, ohne das Token zu verbrauchen", () =>
    withApp(async (t) => {
      await t.addUser("anna@verein.test");
      const token = await requestToken(t, "anna@verein.test");
      for (const password of ["kurz", "passwordpassword", "mein-anna@verein-pw"]) {
        const res = await confirm(t, { token, password });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe("WEAK_PASSWORD");
      }
      expect((await confirm(t, { token, password: NEW_PASSWORD })).statusCode).toBe(204);
    }));

  it("ein schwaches Passwort verrät bei ungültigem Token nichts über die Adresse", () =>
    withApp(async (t) => {
      const res = await confirm(t, { token: "A".repeat(43), password: "kurz" });
      expect(res.json()).toEqual(NEUTRAL);
    }));

  it("gleichzeitig eingelöst gewinnt genau eine Anfrage", () =>
    withApp(async (t) => {
      await t.addUser("anna@verein.test");
      const token = await requestToken(t, "anna@verein.test");
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((i) => confirm(t, { token, password: `passwort-nummer-${i}-lang` })),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([204, 400, 400, 400, 400]);
    }));

  it("gleichzeitig mit demselben Einmalcode gewinnt genau eine Anfrage", () =>
    withApp(async (t) => {
      await t.addUser("anna@verein.test");
      const e = await t.enroll("anna@verein.test");
      const token = await requestToken(t, "anna@verein.test");
      t.clock.advance(30_000);
      const code = t.codeAt(e.secret);
      const results = await Promise.all(
        [1, 2, 3, 4].map((i) => confirm(t, { token, password: `passwort-nummer-${i}-lang`, code })),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([204, 400, 400, 400]);
    }));

  it("das Token eines Kontos setzt nur dieses Konto zurück, auch über Kunden hinweg", () =>
    withApp(async (t) => {
      await t.addUser("anna@verein.test");
      await t.addUser("bruno@anderer.test", { tenantId: OTHER_TENANT });
      const before = (await t.users.findByEmail("bruno@anderer.test"))!.passwordHash;
      const token = await requestToken(t, "anna@verein.test");
      // Eine fremde Adresse im Body ändert nichts am Ziel: es zählt allein das Token.
      expect(
        (
          await confirm(t, {
            token,
            password: NEW_PASSWORD,
            email: "bruno@anderer.test",
            userId: "x",
          })
        ).statusCode,
      ).toBe(204);
      expect((await t.users.findByEmail("bruno@anderer.test"))!.passwordHash).toBe(before);
      expect((await t.login("anna@verein.test", NEW_PASSWORD)).res.statusCode).toBe(200);
      expect((await t.login("bruno@anderer.test", PASSWORD)).res.statusCode).toBe(200);
      expect(t.audit.events.find((e) => e.type === "password_reset_done")?.tenantId).toBe(
        MEMORY_TENANT,
      );
    }));

  it("ein Konto, das zwischen Anfrage und Einlösen gesperrt wurde, lässt sich nicht mehr zurücksetzen", () =>
    withApp(async (t) => {
      const u = await t.addUser("anna@verein.test");
      const token = await requestToken(t, "anna@verein.test");
      t.users.disable(u.id);
      expect((await confirm(t, { token, password: NEW_PASSWORD })).json()).toEqual(NEUTRAL);
    }));

  it("prüft Eingaben und die Origin", () =>
    withApp(async (t) => {
      for (const body of [
        {},
        { token: "x" },
        { password: NEW_PASSWORD },
        { token: "", password: "p" },
      ]) {
        expect((await confirm(t, body)).statusCode).toBe(400);
      }
      expect(
        (await confirm(t, { token: "x".repeat(300), password: NEW_PASSWORD })).statusCode,
      ).toBe(400);
      expect(
        (
          await t.req(
            "POST",
            CONFIRM,
            undefined,
            { token: "x", password: NEW_PASSWORD },
            { origin: "https://evil.test" },
          )
        ).statusCode,
      ).toBe(403);
    }));

  it("ein Chef-Admin kann sein Passwort auf demselben Weg zurücksetzen", () =>
    withApp(async (t) => {
      await t.addUser("chef@anbieter.test", { role: "chief_admin" });
      const token = await requestToken(t, "chef@anbieter.test");
      expect((await confirm(t, { token, password: NEW_PASSWORD })).statusCode).toBe(204);
    }));
});

describe("Eigenen Namen ändern", () => {
  it("ändert den Namen, zeigt ihn in der Sitzung und protokolliert es", () =>
    withApp(async (t) => {
      const u = await t.addUser("anna@verein.test");
      const e = await t.enroll("anna@verein.test");
      expect((await t.req("GET", "/auth/me", e.c)).json().user.name).toBe("anna");

      const res = await t.req("PATCH", "/auth/me", e.c, { name: "  Anna Muster " });
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toEqual({
        id: u.id,
        email: "anna@verein.test",
        name: "Anna Muster",
        role: "user",
      });
      expect((await t.req("GET", "/auth/me", e.c)).json().user.name).toBe("Anna Muster");
      expect((await t.users.findById(MEMORY_TENANT, u.id))!.name).toBe("Anna Muster");
      expect(t.audit.events.find((x) => x.type === "name_changed")).toMatchObject({
        outcome: "success",
        actorUserId: u.id,
        targetUserId: u.id,
      });
    }));

  it("betrifft nur den eigenen Benutzer, auch wenn der Body eine andere ID nennt", () =>
    withApp(async (t) => {
      await t.addUser("anna@verein.test");
      const other = await t.addUser("bruno@verein.test");
      const e = await t.enroll("anna@verein.test");
      await t.req("PATCH", "/auth/me", e.c, { name: "Anna", id: other.id, userId: other.id });
      expect((await t.users.findById(MEMORY_TENANT, other.id))!.name).toBe("bruno");
    }));

  it("verlangt eine volle Sitzung und das CSRF-Token", () =>
    withApp(async (t) => {
      await t.addUser("anna@verein.test");
      const e = await t.enroll("anna@verein.test");
      const patch = (c: typeof e.c, body: object = { name: "X" }) =>
        t.req("PATCH", "/auth/me", c, body);

      expect((await patch({ cookie: undefined, csrf: undefined })).statusCode).toBe(401);
      expect((await patch({ ...e.c, csrf: "falsch" })).statusCode).toBe(403);
      // Zwischen-Sitzung (Passwort geprüft, zweiter Faktor fehlt): kein Zugriff.
      const pending = await t.login("anna@verein.test");
      expect((await patch(pending.c)).statusCode).toBe(401);
      expect((await t.users.findByEmail("anna@verein.test"))!.name).toBe("anna");
    }));

  it("prüft die Eingabe", () =>
    withApp(async (t) => {
      await t.addUser("anna@verein.test");
      const e = await t.enroll("anna@verein.test");
      for (const body of [
        {},
        { name: "" },
        { name: "   " },
        { name: "x".repeat(121) },
        { name: 5 },
      ]) {
        expect((await t.req("PATCH", "/auth/me", e.c, body)).statusCode).toBe(400);
      }
    }));
});

describe("Passwort vergessen ohne Repository", () => {
  it("sendet nichts und setzt nichts zurück (fail closed)", async () => {
    const { buildApp } = await import("../../app.js");
    const { loadConfig } = await import("../../config.js");
    const { MemoryAuditRepo, MemorySessionRepo, MemoryThrottleRepo, MemoryUserRepo } =
      await import("./memory.js");
    const { testConfig, FakeMail } = await import("./auth.testkit.js");
    const mail = new FakeMail();
    const app = await buildApp(loadConfig({ LOG_LEVEL: "silent" }), false, {
      auth: {
        config: testConfig(),
        users: new MemoryUserRepo(),
        sessions: new MemorySessionRepo(),
        throttle: new MemoryThrottleRepo(),
        audit: new MemoryAuditRepo(),
        mail,
        resetMinMs: 0,
      },
    });
    const ask = await app.inject({ method: "POST", url: REQUEST, payload: { email: "a@b.test" } });
    expect(ask.statusCode).toBe(204);
    expect(mail.resets).toHaveLength(0);
    const res = await app.inject({
      method: "POST",
      url: CONFIRM,
      payload: { token: "x".repeat(43), password: NEW_PASSWORD },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(NEUTRAL);
    await app.close();
  });
});
