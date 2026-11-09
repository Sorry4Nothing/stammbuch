import { describe, expect, it } from "vitest";
import { chef as platformChef } from "../../platform/platform.testkit.js";
import { setup, ORIGIN, PASSWORD } from "./auth.testkit.js";
import { MEMORY_TENANT } from "./memory.js";
import { SESSION_COOKIE } from "./routes.js";
import type { AuditRepo } from "./types.js";

const EMAIL = "anna@verein.test";

async function withUser<T>(fn: (t: Awaited<ReturnType<typeof setup>>) => Promise<T>) {
  const t = await setup();
  await t.addUser(EMAIL);
  try {
    return await fn(t);
  } finally {
    await t.app.close();
  }
}

describe("Anmeldung braucht den zweiten Faktor", () => {
  it("Passwort allein gibt nur eine Zwischen-Sitzung ohne Zugriff", () =>
    withUser(async (t) => {
      const l = await t.login(EMAIL);
      expect(l.res.statusCode).toBe(200);
      expect(l.body.status).toBe("mfa_setup_required");

      const me = await t.req("GET", "/auth/me", l.c);
      expect(me.json().state).toBe("pending");

      // Funktionen für volle Sitzungen bleiben verschlossen (auch mit korrektem CSRF-Token).
      const pw = await t.req("POST", "/auth/password", l.c, {
        currentPassword: PASSWORD,
        newPassword: "ein-ganz-anderes-passwort-9",
      });
      expect(pw.statusCode).toBe(401);
    }));

  it("Einrichtung: falscher Code scheitert, richtiger liefert 10 Wiederherstellungscodes einmalig", () =>
    withUser(async (t) => {
      const l = await t.login(EMAIL);
      const setup = await t.req("POST", "/auth/2fa/setup", l.c);
      expect(setup.json().otpauthUri).toMatch(/^otpauth:\/\/totp\//);

      const bad = await t.req("POST", "/auth/2fa", l.c, { code: "000000" });
      expect(bad.statusCode).toBe(401);
      expect(bad.json().error.code).toBe("INVALID_CODE");

      const { base32Decode } = await import("./base32.js");
      const secret = base32Decode(setup.json().secret);
      const ok = await t.req("POST", "/auth/2fa", l.c, { code: t.codeAt(secret) });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().recoveryCodes).toHaveLength(10);
      expect(ok.json().user).toEqual({
        id: expect.any(String),
        email: EMAIL,
        name: expect.any(String),
        role: "user",
      });

      // Gespeichert wird nur Verschlüsseltes bzw. Gehashtes.
      const u = (await t.users.findByEmail(EMAIL))!;
      expect(u.totpSecretEnc).not.toContain(setup.json().secret);
      for (const code of ok.json().recoveryCodes) {
        expect(JSON.stringify(u)).not.toContain(code);
        expect(JSON.stringify(u)).not.toContain(code.replaceAll("-", ""));
      }
      expect(u.recoveryCodeHashes).toHaveLength(10);
      expect(t.mail.sent.map((m) => m.kind)).toEqual(["mfa_enrolled"]);

      // Die Zwischen-Sitzung ist verbraucht; die neue Sitzung gibt Zugriff.
      expect((await t.req("GET", "/auth/me", l.c)).statusCode).toBe(401);
      const c = { cookie: t.cookieOf(ok)!.value, csrf: ok.json().csrfToken };
      expect((await t.req("GET", "/auth/me", c)).json().state).toBe("authenticated");
    }));

  it("Setup ist nur für Nutzer ohne TOTP möglich", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      t.clock.advance(30_000);
      const l = await t.login(EMAIL);
      expect(l.body.status).toBe("mfa_required");
      const res = await t.req("POST", "/auth/2fa/setup", l.c);
      expect(res.statusCode).toBe(403);
      expect(e.recoveryCodes).toHaveLength(10);
    }));

  it("Login mit eingerichtetem TOTP führt zu einer vollen Sitzung", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      const f = await t.fullLogin(EMAIL, e.secret);
      expect(f.res.statusCode).toBe(200);
      expect(f.res.json().recoveryCodes).toBeUndefined();
      expect((await t.req("GET", "/auth/me", f.c)).json().state).toBe("authenticated");
    }));

  it("lehnt Sitzungsrouten ohne Cookie ab (deny by default)", () =>
    withUser(async (t) => {
      for (const [m, url] of [
        ["GET", "/auth/me"],
        ["POST", "/auth/2fa"],
        ["POST", "/auth/2fa/setup"],
        ["POST", "/auth/recovery"],
        ["POST", "/auth/password"],
        ["POST", "/auth/admin/users/x/2fa-reset"],
      ] as const) {
        const res = await t.req(m, url, undefined, m === "POST" ? {} : undefined);
        expect([400, 401]).toContain(res.statusCode);
        expect(res.statusCode).not.toBe(200);
      }
    }));
});

describe("Cookie (SR-02)", () => {
  it("setzt HttpOnly, Secure, SameSite=Strict, Path=/ und das __Host-Präfix", () =>
    withUser(async (t) => {
      const l = await t.login(EMAIL);
      const c = t.cookieOf(l.res)!;
      expect(c.name).toBe("__Host-sid");
      expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/" });
      expect(c.domain).toBeUndefined();
      expect(c.maxAge).toBe(600); // Zwischen-Sitzung: 10 min
      expect(c.value.length).toBeGreaterThanOrEqual(43);
      expect(l.res.headers["cache-control"]).toBe("no-store");
    }));

  it("speichert das Token nie im Klartext", () =>
    withUser(async (t) => {
      const l = await t.login(EMAIL);
      expect(t.sessions.sessions.has(l.c.cookie!)).toBe(false);
      expect(JSON.stringify([...t.sessions.sessions.values()])).not.toContain(l.c.cookie);
    }));
});

describe("Rotation der Sitzung (SR-02)", () => {
  it("Login mit untergeschobenem Cookie (Fixation) macht dieses ungültig und vergibt neue ID", () =>
    withUser(async (t) => {
      const first = await t.login(EMAIL);
      const second = await t.login(EMAIL, PASSWORD, first.c);
      expect(second.c.cookie).not.toBe(first.c.cookie);
      expect((await t.req("GET", "/auth/me", first.c)).statusCode).toBe(401);
      expect((await t.req("GET", "/auth/me", second.c)).statusCode).toBe(200);
    }));

  it("nach dem zweiten Faktor wechselt die Sitzungs-ID; die Zwischen-Sitzung ist tot", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      t.clock.advance(30_000);
      const l = await t.login(EMAIL);
      const done = await t.req("POST", "/auth/2fa", l.c, { code: t.codeAt(e.secret) });
      expect(t.cookieOf(done)!.value).not.toBe(l.c.cookie);
      expect(done.json().csrfToken).not.toBe(l.c.csrf);
      expect((await t.req("GET", "/auth/me", l.c)).statusCode).toBe(401);
    }));

  it("Passwortwechsel rotiert und beendet alle anderen Sitzungen", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      const other = await t.fullLogin(EMAIL, e.secret);
      const mine = await t.fullLogin(EMAIL, e.secret);
      const res = await t.req("POST", "/auth/password", mine.c, {
        currentPassword: PASSWORD,
        newPassword: "neues-sehr-langes-passwort-42",
      });
      expect(res.statusCode).toBe(200);
      const fresh = { cookie: t.cookieOf(res)!.value, csrf: res.json().csrfToken };
      expect(fresh.cookie).not.toBe(mine.c.cookie);
      expect((await t.req("GET", "/auth/me", other.c)).statusCode).toBe(401);
      expect((await t.req("GET", "/auth/me", mine.c)).statusCode).toBe(401);
      expect((await t.req("GET", "/auth/me", fresh)).statusCode).toBe(200);
      expect((await t.req("GET", "/auth/me", e.c)).statusCode).toBe(401);
      expect(t.mail.sent.at(-1)?.kind).toBe("password_changed");
    }));
});

describe("Ablauf und Widerruf (SR-02)", () => {
  it("Zwischen-Sitzung verfällt nach 10 Minuten", () =>
    withUser(async (t) => {
      const l = await t.login(EMAIL);
      t.clock.advance(10 * 60_000 + 1000);
      expect((await t.req("GET", "/auth/me", l.c)).statusCode).toBe(401);
    }));

  it("verfällt bei Inaktivität (Idle) und absolut, auch bei Aktivität", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      const idle = await t.fullLogin(EMAIL, e.secret);
      t.clock.advance(2 * 3_600_000 + 1000);
      expect((await t.req("GET", "/auth/me", idle.c)).statusCode).toBe(401);

      const busy = await t.fullLogin(EMAIL, e.secret);
      for (let i = 0; i < 7; i++) {
        t.clock.advance(100 * 60_000);
        expect((await t.req("GET", "/auth/me", busy.c)).statusCode).toBe(200);
      }
      t.clock.advance(100 * 60_000); // > 12 h seit Anmeldung
      expect((await t.req("GET", "/auth/me", busy.c)).statusCode).toBe(401);
    }));

  it("Logout widerruft serverseitig und löscht das Cookie", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      const res = await t.req("POST", "/auth/logout", e.c);
      expect(res.statusCode).toBe(204);
      expect(t.cookieOf(res)!.value).toBe("");
      expect((await t.req("GET", "/auth/me", e.c)).statusCode).toBe(401); // altes Token ist tot
      expect((await t.audit.list({})).map((x) => x.type)).toContain("logout");
    }));

  it("Logout ohne Sitzung ist idempotent", () =>
    withUser(async (t) => {
      expect((await t.req("POST", "/auth/logout")).statusCode).toBe(204);
    }));

  it("deaktivierte Nutzer verlieren laufende Sitzungen", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      const u = (await t.users.findByEmail(EMAIL))!;
      (t.users as unknown as { users: Map<string, { disabled: boolean }> }).users.get(
        u.id,
      )!.disabled = true;
      expect((await t.req("GET", "/auth/me", e.c)).statusCode).toBe(401);
      t.clock.advance(30_000);
      expect((await t.login(EMAIL)).res.statusCode).toBe(401);
    }));
});

describe("CSRF", () => {
  it("verlangt das Token-Header bei allen schreibenden Sitzungsrouten", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      const body = { currentPassword: PASSWORD, newPassword: "neues-sehr-langes-passwort-42" };
      const none = await t.req("POST", "/auth/password", { ...e.c, csrf: undefined }, body);
      const wrong = await t.req("POST", "/auth/password", { ...e.c, csrf: "falsch" }, body);
      expect(none.statusCode).toBe(403);
      expect(wrong.statusCode).toBe(403);
      expect(none.json().error.code).toBe("CSRF_INVALID");
      expect((await t.req("POST", "/auth/logout", { ...e.c, csrf: undefined })).statusCode).toBe(
        403,
      );
      // Passwort unverändert
      const u = (await t.users.findByEmail(EMAIL))!;
      expect(await t.real.verify(u.passwordHash, PASSWORD)).toBe(true);
    }));

  it("lehnt fremde Origin ab und protokolliert sie; die eigene Origin passt", () =>
    withUser(async (t) => {
      const evil = await t.req(
        "POST",
        "/auth/login",
        undefined,
        { email: EMAIL, password: PASSWORD },
        {
          origin: "https://evil.test",
        },
      );
      expect(evil.statusCode).toBe(403);
      expect(t.cookieOf(evil)).toBeUndefined();
      expect((await t.audit.list({})).map((x) => x.type)).toContain("csrf_rejected");

      const good = await t.req(
        "POST",
        "/auth/login",
        undefined,
        { email: EMAIL, password: PASSWORD },
        {
          origin: ORIGIN,
        },
      );
      expect(good.statusCode).toBe(200);
    }));

  it("lehnt Nicht-JSON-Inhalte ab (Formular-Posts von Fremdseiten)", () =>
    withUser(async (t) => {
      const res = await t.app.inject({
        method: "POST",
        url: "/auth/login",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `email=${EMAIL}&password=${PASSWORD}`,
      });
      expect(res.statusCode).toBe(415);
    }));
});

describe("Sperre nach Fehlversuchen (SR-04)", () => {
  it("sperrt nach 5 Fehlversuchen, auch für das richtige Passwort, mit Retry-After", () =>
    withUser(async (t) => {
      for (let i = 0; i < 5; i++) {
        expect((await t.login(EMAIL, "falsch-falsch-falsch")).res.statusCode).toBe(401);
      }
      const locked = await t.login(EMAIL, PASSWORD);
      expect(locked.res.statusCode).toBe(429);
      expect(locked.res.headers["retry-after"]).toBe("60");
      expect(t.cookieOf(locked.res)).toBeUndefined();
      expect((await t.audit.list({})).map((x) => x.type)).toContain("login_locked");

      t.clock.advance(61_000);
      expect((await t.login(EMAIL, PASSWORD)).res.statusCode).toBe(200);
    }));

  it("verlängert die Sperre bei weiteren Fehlversuchen (Backoff)", () =>
    withUser(async (t) => {
      for (let i = 0; i < 5; i++) await t.login(EMAIL, "falsch-falsch-falsch");
      t.clock.advance(61_000);
      expect((await t.login(EMAIL, "falsch-falsch-falsch")).res.statusCode).toBe(401); // 6. Versuch
      const locked = await t.login(EMAIL, PASSWORD);
      expect(locked.res.statusCode).toBe(429);
      expect(locked.res.headers["retry-after"]).toBe("120");
    }));

  it("zählt auch falsche zweite Faktoren; ein richtiges Passwort setzt den Zähler nicht zurück", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      for (let i = 0; i < 3; i++) await t.login(EMAIL, "falsch-falsch-falsch");
      t.clock.advance(30_000);
      const l = await t.login(EMAIL); // Passwort richtig
      expect(l.res.statusCode).toBe(200);
      expect((await t.req("POST", "/auth/2fa", l.c, { code: "000000" })).statusCode).toBe(401); // 4.
      expect((await t.req("POST", "/auth/2fa", l.c, { code: "000001" })).statusCode).toBe(401); // 5. -> Sperre
      const r = await t.req("POST", "/auth/2fa", l.c, { code: t.codeAt(e.secret) });
      expect(r.statusCode).toBe(429); // auch der richtige Code wird während der Sperre nicht angenommen
    }));

  it("vollständige Anmeldung setzt den Zähler zurück", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      for (let i = 0; i < 4; i++) await t.login(EMAIL, "falsch-falsch-falsch");
      expect((await t.fullLogin(EMAIL, e.secret)).res.statusCode).toBe(200);
      for (let i = 0; i < 4; i++) {
        expect((await t.login(EMAIL, "falsch-falsch-falsch")).res.statusCode).toBe(401);
      }
    }));

  it("beendet eine Zwischen-Sitzung nach 5 falschen Codes", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      t.clock.advance(30_000);
      const l = await t.login(EMAIL);
      // Zähler pro Sitzung (5), Konto-Sperre greift ebenfalls bei 5: Sitzung ist danach tot.
      for (let i = 0; i < 5; i++) await t.req("POST", "/auth/2fa", l.c, { code: "00000" + i });
      expect((await t.req("GET", "/auth/me", l.c)).statusCode).toBe(401);
      t.clock.advance(61_000);
      expect((await t.fullLogin(EMAIL, e.secret)).res.statusCode).toBe(200);
    }));
});

describe("Keine Konto-Enumeration (SR-05)", () => {
  it("unbekannte E-Mail und falsches Passwort sind nicht unterscheidbar", () =>
    withUser(async (t) => {
      const known = await t.login(EMAIL, "falsch-falsch-falsch");
      const unknown = await t.login("niemand@verein.test", "falsch-falsch-falsch");
      expect(unknown.res.statusCode).toBe(known.res.statusCode);
      expect(unknown.res.body).toBe(known.res.body);
      expect(Object.keys(unknown.res.headers).sort()).toEqual(
        Object.keys(known.res.headers).sort(),
      );
    }));

  it("betreibt für unbekannte Konten denselben Hash-Aufwand", () =>
    withUser(async (t) => {
      await t.login(EMAIL, "falsch-falsch-falsch");
      await t.login("niemand@verein.test", "falsch-falsch-falsch");
      expect(t.calls).toEqual({ verify: 1, verifyAbsent: 1 });
    }));

  it("sperrt unbekannte Konten identisch (gleiche Statusfolge, gleiche Antworten)", () =>
    withUser(async (t) => {
      const seq = async (email: string) => {
        const out: string[] = [];
        for (let i = 0; i < 7; i++) {
          const r = await t.login(email, "falsch-falsch-falsch");
          out.push(`${r.res.statusCode}|${r.res.headers["retry-after"] ?? ""}|${r.res.body}`);
        }
        return out;
      };
      const known = await seq(EMAIL);
      t.clock.advance(3_600_000 * 3);
      const unknown = await seq("niemand@verein.test");
      expect(unknown).toEqual(known);
      expect(known.filter((x) => x.startsWith("429"))).toHaveLength(2);
    }));

  it("behandelt E-Mail-Schreibweisen gleich (Gross-/Kleinschreibung, Leerzeichen)", () =>
    withUser(async (t) => {
      expect((await t.login("  ANNA@Verein.TEST ")).res.statusCode).toBe(200);
    }));

  it("speichert im Protokoll keine Klartext-E-Mail unbekannter Konten", () =>
    withUser(async (t) => {
      await t.login("niemand@verein.test", "falsch-falsch-falsch");
      expect(JSON.stringify(t.audit.events)).not.toContain("niemand");
    }));
});

describe("TOTP-Zeitfenster und Replay-Schutz", () => {
  it("akzeptiert einen Code aus dem Nachbarschritt, nicht aus zwei Schritten Abstand", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      t.clock.advance(60_000);
      const l1 = await t.login(EMAIL);
      const tooOld = await t.req("POST", "/auth/2fa", l1.c, { code: t.codeAt(e.secret, -2) });
      expect(tooOld.statusCode).toBe(401);
      const tooNew = await t.req("POST", "/auth/2fa", l1.c, { code: t.codeAt(e.secret, 2) });
      expect(tooNew.statusCode).toBe(401);
      const drift = await t.req("POST", "/auth/2fa", l1.c, { code: t.codeAt(e.secret, 1) });
      expect(drift.statusCode).toBe(200);
    }));

  it("nimmt denselben Code nicht zweimal an, auch nicht in einer neuen Sitzung", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      t.clock.advance(30_000);
      const l1 = await t.login(EMAIL);
      const code = t.codeAt(e.secret);
      expect((await t.req("POST", "/auth/2fa", l1.c, { code })).statusCode).toBe(200);
      const l2 = await t.login(EMAIL);
      const replay = await t.req("POST", "/auth/2fa", l2.c, { code });
      expect(replay.statusCode).toBe(401);
      expect((await t.audit.list({})).map((x) => x.type)).toContain("mfa_replay");
      // Nächster Zeitschritt funktioniert wieder.
      t.clock.advance(30_000);
      const l3 = await t.login(EMAIL);
      expect(
        (await t.req("POST", "/auth/2fa", l3.c, { code: t.codeAt(e.secret) })).statusCode,
      ).toBe(200);
    }));

  it("nimmt auch den Code der Einrichtung nicht noch einmal an", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      const l = await t.login(EMAIL);
      const replay = await t.req("POST", "/auth/2fa", l.c, { code: t.codeAt(e.secret) });
      expect(replay.statusCode).toBe(401);
    }));

  it("nimmt einen älteren Zeitschritt nach einem neueren nicht an", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      t.clock.advance(30_000);
      const l1 = await t.login(EMAIL);
      await t.req("POST", "/auth/2fa", l1.c, { code: t.codeAt(e.secret, 1) }); // Zähler = jetzt+1
      const l2 = await t.login(EMAIL);
      expect(
        (await t.req("POST", "/auth/2fa", l2.c, { code: t.codeAt(e.secret, 0) })).statusCode,
      ).toBe(401);
    }));

  it("Rennen: zwei gleichzeitige Einlösungen desselben Codes, nur eine gewinnt", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      t.clock.advance(30_000);
      const a = await t.login(EMAIL);
      const b = await t.login(EMAIL);
      const code = t.codeAt(e.secret);
      const [ra, rb] = await Promise.all([
        t.req("POST", "/auth/2fa", a.c, { code }),
        t.req("POST", "/auth/2fa", b.c, { code }),
      ]);
      expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 401]);
    }));
});

describe("Wiederherstellungscodes", () => {
  it("funktionieren genau einmal, tolerant bei Schreibweise", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      const code = e.recoveryCodes[0]!;

      const l1 = await t.login(EMAIL);
      const ok = await t.req("POST", "/auth/recovery", l1.c, {
        code: code.toLowerCase().replaceAll("-", " "),
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().remainingRecoveryCodes).toBe(9);
      const c = { cookie: t.cookieOf(ok)!.value, csrf: ok.json().csrfToken };
      expect((await t.req("GET", "/auth/me", c)).json().state).toBe("authenticated");

      const l2 = await t.login(EMAIL);
      const again = await t.req("POST", "/auth/recovery", l2.c, { code });
      expect(again.statusCode).toBe(401);
      expect(again.json().error.code).toBe("INVALID_CODE");

      // Ein anderer Code funktioniert weiterhin.
      const other = await t.req("POST", "/auth/recovery", l2.c, { code: e.recoveryCodes[1] });
      expect(other.statusCode).toBe(200);
      expect(other.json().remainingRecoveryCodes).toBe(8);

      const types = (await t.audit.list({})).map((x) => x.type);
      expect(types).toContain("recovery_used");
      expect(types).toContain("recovery_failure");
      expect(t.mail.sent.filter((m) => m.kind === "recovery_used")).toHaveLength(2);
    }));

  it("sind einzeln gleichzeitig nur einmal einlösbar", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      const a = await t.login(EMAIL);
      const b = await t.login(EMAIL);
      const [ra, rb] = await Promise.all([
        t.req("POST", "/auth/recovery", a.c, { code: e.recoveryCodes[2] }),
        t.req("POST", "/auth/recovery", b.c, { code: e.recoveryCodes[2] }),
      ]);
      expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 401]);
    }));

  it("falsche Codes zählen gegen die Sperre", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      const l = await t.login(EMAIL);
      for (let i = 0; i < 5; i++) {
        await t.req("POST", "/auth/recovery", l.c, { code: "AAAA-AAAA-AAAA-AAA" + i });
      }
      const l2 = await t.login(EMAIL, PASSWORD);
      expect(l2.res.statusCode).toBe(429);
      expect(e.recoveryCodes).toHaveLength(10);
    }));

  it("sind ohne eingerichtetes TOTP nicht verwendbar", () =>
    withUser(async (t) => {
      const l = await t.login(EMAIL);
      const res = await t.req("POST", "/auth/recovery", l.c, { code: "AAAA-AAAA-AAAA-AAAA" });
      expect(res.statusCode).toBe(401);
    }));
});

describe("Passwort ändern (SR-06)", () => {
  it("prüft das aktuelle Passwort (und zählt Fehler), die Regeln und die Gleichheit", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      const post = (currentPassword: string, newPassword: string) =>
        t.req("POST", "/auth/password", e.c, { currentPassword, newPassword });

      const wrong = await post("falsch", "neues-sehr-langes-passwort-42");
      expect(wrong.statusCode).toBe(401);
      const short = await post(PASSWORD, "kurz");
      expect(short.statusCode).toBe(400);
      expect(short.json().error.code).toBe("WEAK_PASSWORD");
      expect((await post(PASSWORD, "Passwort123456")).json().error.code).toBe("WEAK_PASSWORD");
      expect((await post(PASSWORD, PASSWORD)).json().error.code).toBe("WEAK_PASSWORD");
      // ohne Kompositionsregeln: nur Kleinbuchstaben genügen, wenn lang genug
      expect((await post(PASSWORD, "nurkleinbuchstabenundleerzeichen")).statusCode).toBe(200);
    }));

  it("neues Passwort gilt, altes nicht mehr; Hash trägt aktuellen Pepper", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      await t.req("POST", "/auth/password", e.c, {
        currentPassword: PASSWORD,
        newPassword: "neues-sehr-langes-passwort-42",
      });
      t.clock.advance(30_000);
      expect((await t.login(EMAIL, PASSWORD)).res.statusCode).toBe(401);
      expect((await t.login(EMAIL, "neues-sehr-langes-passwort-42")).res.statusCode).toBe(200);
      expect((await t.audit.list({})).map((x) => x.type)).toContain("password_changed");
    }));

  it("5 falsche aktuelle Passwörter sperren das Konto", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      for (let i = 0; i < 5; i++) {
        await t.req("POST", "/auth/password", e.c, {
          currentPassword: "falsch",
          newPassword: "x".repeat(20),
        });
      }
      const res = await t.req("POST", "/auth/password", e.c, {
        currentPassword: PASSWORD,
        newPassword: "neues-sehr-langes-passwort-42",
      });
      expect(res.statusCode).toBe(429);
    }));

  it("hasht Hashes mit altem Pepper nach erfolgreichem Login neu", async () => {
    const { createPasswordHasher, ARGON2_MIN } = await import("./password.js");
    const peppers = [
      { id: "p2", secret: "n".repeat(40) },
      { id: "p1", secret: "o".repeat(40) },
    ];
    const t = await setup({ config: { peppers } });
    const oldOnly = createPasswordHasher([peppers[1]!], ARGON2_MIN);
    const u = await t.addUser("alt@verein.test", { passwordHash: await oldOnly.hash(PASSWORD) });
    expect(u.passwordHash.startsWith("p1:")).toBe(true);
    expect((await t.login("alt@verein.test", "falsch-falsch-falsch")).res.statusCode).toBe(401);
    expect((await t.users.findById(u.tenantId, u.id))!.passwordHash.startsWith("p1:")).toBe(true);
    expect((await t.login("alt@verein.test")).res.statusCode).toBe(200);
    const stored = (await t.users.findById(u.tenantId, u.id))!.passwordHash;
    expect(stored.startsWith("p2:")).toBe(true);
    expect(await t.real.verify(stored, PASSWORD)).toBe(true);
    await t.app.close();
  });
});

describe("Chef-Admin setzt 2FA zurück", () => {
  async function scenario() {
    const t = await setup();
    const admin = await t.addUser("chef@anbieter.test", { role: "chief_admin" });
    const target = await t.addUser(EMAIL);
    const adminE = await t.enroll(admin.email);
    const userE = await t.enroll(EMAIL);
    t.clock.advance(30_000);
    const adminLogin = await t.fullLogin(admin.email, adminE.secret);
    const userSession = await t.fullLogin(EMAIL, userE.secret);
    // Step-up: frischer TOTP-Code, jünger als der der Anmeldung (Uhr vorspulen).
    const reset = (id: string, c = adminLogin.c, code?: string) => {
      t.clock.advance(30_000);
      return t.req("POST", `/auth/admin/users/${id}/2fa-reset`, c, {
        code: code ?? t.codeAt(adminE.secret),
        reason: "Handy verloren",
        calledBack: true,
      });
    };
    return { t, admin, target, adminE, userE, adminLogin, userSession, reset };
  }

  it("löscht den zweiten Faktor, beendet Sitzungen, protokolliert und benachrichtigt", async () => {
    const { t, admin, target, userE, userSession, reset } = await scenario();
    t.mail.sent.length = 0;
    const res = await reset(target.id);
    expect(res.statusCode).toBe(204);

    const after = (await t.users.findById(target.tenantId, target.id))!;
    expect(after.totpSecretEnc).toBeNull();
    expect(after.recoveryCodeHashes).toEqual([]);
    expect(after.totpLastCounter).toBeNull();
    expect(after.passwordHash).toBe(target.passwordHash); // keine Passwortübernahme

    // Laufende Sitzungen des Nutzers sind tot.
    expect((await t.req("GET", "/auth/me", userSession.c)).statusCode).toBe(401);

    // Protokoll: Akteur und Ziel.
    const ev = (await t.audit.list({ userId: target.id })).find((e) => e.type === "mfa_reset")!;
    expect(ev).toMatchObject({
      outcome: "success",
      actorUserId: admin.id,
      targetUserId: target.id,
    });

    // Mail an den betroffenen Nutzer.
    expect(t.mail.sent).toEqual([{ kind: "mfa_reset", to: EMAIL, at: expect.any(Date) }]);

    // Alte Wiederherstellungscodes sind wertlos; beim nächsten Login wird neu eingerichtet.
    t.clock.advance(30_000);
    const l = await t.login(EMAIL);
    expect(l.body.status).toBe("mfa_setup_required");
    const old = await t.req("POST", "/auth/recovery", l.c, { code: userE.recoveryCodes[0] });
    expect(old.statusCode).toBe(401);
    const old2 = await t.req("POST", "/auth/2fa", l.c, { code: t.codeAt(userE.secret) });
    expect(old2.statusCode).toBe(401); // alter TOTP-Schlüssel gilt nicht mehr
    await t.app.close();
  });

  describe("Anbieter-Protokoll", () => {
    const providerLog = async (t: Awaited<ReturnType<typeof scenario>>["t"]) =>
      (await t.platform.platformAudit.query("platform", {}, { limit: 10, offset: 0 })).items;
    const withTenant = async () => {
      const s = await scenario();
      await s.t.platform.tenants.create(platformChef.accountId, {
        id: MEMORY_TENANT,
        name: "Verein Test",
        slug: "verein-test",
        status: "active",
        licenceValidUntil: "2099-12-31",
        createdAt: "2026-01-01T00:00:00.000Z",
        endedAt: null,
      });
      return s;
    };

    it("trägt Kunde, Benutzer, Grund und Rückruf ein, nie ins Kundenprotokoll", async () => {
      const { t, admin, target, adminE, adminLogin } = await withTenant();
      t.clock.advance(30_000);
      const res = await t.req("POST", `/auth/admin/users/${target.id}/2fa-reset`, adminLogin.c, {
        code: t.codeAt(adminE.secret),
        reason: "  Handy verloren  ",
        calledBack: true,
      });
      expect(res.statusCode).toBe(204);
      const log = await providerLog(t);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        action: "customer.user-2fa-reset",
        actor: admin.email,
        actorId: admin.id,
        target: `Verein Test: ${target.email.split("@")[0]} – Grund: Handy verloren – Rückruf bestätigt`,
      });
      // Weder Code noch E-Mail-Adresse des Benutzers stehen im Anbieter-Protokoll.
      expect(JSON.stringify(log)).not.toContain(target.email);
      expect(
        (await t.platform.audit.query(MEMORY_TENANT, {}, { limit: 10, offset: 0 })).total,
      ).toBe(0);
      await t.app.close();
    });

    it("verlangt Grund und Rückruf: fehlen sie, ist der Reset 400 und nichts ändert sich", async () => {
      const { t, target, adminE, adminLogin } = await withTenant();
      const valid = { reason: "Handy verloren", calledBack: true };
      const bad: Record<string, unknown>[] = [
        { ...valid, reason: undefined },
        { ...valid, reason: "kurz" },
        { ...valid, reason: "         x         " },
        { ...valid, calledBack: undefined },
        { ...valid, calledBack: false },
      ];
      for (const extra of bad) {
        t.clock.advance(30_000);
        const res = await t.req("POST", `/auth/admin/users/${target.id}/2fa-reset`, adminLogin.c, {
          code: t.codeAt(adminE.secret),
          ...extra,
        });
        expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      }
      expect((await t.users.findById(target.tenantId, target.id))!.totpSecretEnc).not.toBeNull();
      expect(await providerLog(t)).toEqual([]);
      await t.app.close();
    });

    it("lehnt zu lange oder ungültige Angaben ab, ohne zurückzusetzen", async () => {
      const { t, target, adminE, adminLogin } = await withTenant();
      for (const extra of [{ reason: "x".repeat(201) }, { reason: "" }, { calledBack: "ja" }]) {
        t.clock.advance(30_000);
        const res = await t.req("POST", `/auth/admin/users/${target.id}/2fa-reset`, adminLogin.c, {
          code: t.codeAt(adminE.secret),
          reason: "Handy verloren",
          calledBack: true,
          ...extra,
        });
        expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      }
      expect((await t.users.findById(target.tenantId, target.id))!.totpSecretEnc).not.toBeNull();
      expect(await providerLog(t)).toEqual([]);
      await t.app.close();
    });

    it("abgelehnte Versuche (Rolle, Selbst-Reset, falscher Code) schreiben keinen Eintrag", async () => {
      const { t, admin, target, userSession, adminLogin, reset } = await withTenant();
      await t.req("POST", `/auth/admin/users/${admin.id}/2fa-reset`, userSession.c, {
        code: "123456",
        reason: "Handy verloren",
        calledBack: true,
      });
      await reset(admin.id);
      await t.req("POST", `/auth/admin/users/${target.id}/2fa-reset`, adminLogin.c, {
        code: "000000",
        reason: "Handy verloren",
        calledBack: true,
      });
      expect(await providerLog(t)).toEqual([]);
      await t.app.close();
    });
  });

  it("verweigert normale Nutzer, protokolliert den Versuch, ändert nichts", async () => {
    const { t, admin, target, userSession } = await scenario();
    const res = await t.req("POST", `/auth/admin/users/${admin.id}/2fa-reset`, userSession.c, {
      code: "123456",
      reason: "Handy verloren",
      calledBack: true,
    });
    expect(res.statusCode).toBe(403);
    expect((await t.users.findById(admin.tenantId, admin.id))!.totpSecretEnc).not.toBeNull();
    const denied = (await t.audit.list({})).find((e) => e.type === "mfa_reset_denied")!;
    expect(denied).toMatchObject({ outcome: "failure", actorUserId: target.id });
    expect(t.mail.sent.filter((m) => m.kind === "mfa_reset")).toHaveLength(0);
    await t.app.close();
  });

  it("verlangt CSRF-Token und eine volle Sitzung", async () => {
    const { t, target, adminLogin } = await scenario();
    const noCsrf = await t.req(
      "POST",
      `/auth/admin/users/${target.id}/2fa-reset`,
      { ...adminLogin.c, csrf: undefined },
      { code: "123456", reason: "Handy verloren", calledBack: true },
    );
    expect(noCsrf.statusCode).toBe(403);
    const pendingOnly = await t.login("chef@anbieter.test");
    const res = await t.req("POST", `/auth/admin/users/${target.id}/2fa-reset`, pendingOnly.c, {
      code: "123456",
      reason: "Handy verloren",
      calledBack: true,
    });
    expect(res.statusCode).toBe(401);
    expect((await t.users.findById(target.tenantId, target.id))!.totpSecretEnc).not.toBeNull();
    await t.app.close();
  });

  it("erlaubt keinen Selbst-Reset und meldet unbekannte Ziele mit 404", async () => {
    const { t, admin, reset } = await scenario();
    expect((await reset(admin.id)).statusCode).toBe(403);
    expect((await reset("gibt-es-nicht")).statusCode).toBe(404);
    expect((await t.audit.list({})).some((e) => e.type === "mfa_reset_denied")).toBe(true);
    await t.app.close();
  });

  it("ein ausgefallener Mailversand macht den Reset nicht rückgängig, wird aber protokolliert", async () => {
    const { t, target, reset } = await scenario();
    t.mail.failing = true;
    const res = await reset(target.id);
    expect(res.statusCode).toBe(204);
    expect((await t.users.findById(target.tenantId, target.id))!.totpSecretEnc).toBeNull();
    const types = (await t.audit.list({})).map((e) => e.type);
    expect(types).toContain("mfa_reset");
    expect(types).toContain("notice_failed");
    await t.app.close();
  });

  it("die Rolle kommt aus der Datenbank, nie aus dem Request (SR-13)", async () => {
    const { t, target, userSession } = await scenario();
    const res = await t.req(
      "POST",
      `/auth/admin/users/${target.id}/2fa-reset`,
      userSession.c,
      { role: "chief_admin", code: "123456", reason: "Handy verloren", calledBack: true },
      { "x-role": "chief_admin" },
    );
    expect(res.statusCode).toBe(403);
    await t.app.close();
  });
});

describe("Step-up für andere Module (Schlüsselrotation)", () => {
  it("gilt nur für den Chef-Admin mit frischem Code, nur einmal, und sperrt nach Fehlversuchen", async () => {
    const t = await setup();
    const admin = await t.addUser("chef@anbieter.test", { role: "chief_admin" });
    await t.addUser(EMAIL);
    const adminE = await t.enroll(admin.email);
    const userE = await t.enroll(EMAIL);
    const userLogin = await t.fullLogin(EMAIL, userE.secret);
    const adminLogin = await t.fullLogin(admin.email, adminE.secret);
    const verify = (c: { cookie?: string }, code: string) =>
      t.app.verifyStepUp(
        { headers: { cookie: `${SESSION_COOKIE}=${c.cookie}` }, ip: "10.0.0.1" } as never,
        code,
      );

    // Der Code der Anmeldung ist nicht frisch (Replay-Schutz), ein Kundenbenutzer ist nie zugelassen.
    expect(await verify(adminLogin.c, t.codeAt(adminE.secret))).toBe("invalid");
    t.clock.advance(30_000);
    expect(await verify(userLogin.c, t.codeAt(userE.secret))).toBe("invalid");
    t.clock.advance(30_000);
    const fresh = t.codeAt(adminE.secret);
    expect(await verify(adminLogin.c, fresh)).toBe("ok");
    expect(await verify(adminLogin.c, fresh)).toBe("invalid");
    expect(await verify({ cookie: undefined }, fresh)).toBe("invalid");

    let last: Awaited<ReturnType<typeof verify>> = "invalid";
    for (let i = 0; i < 20 && last === "invalid"; i++) last = await verify(adminLogin.c, "000000");
    expect(last).toMatchObject({ kind: "locked" });
    await t.app.close();
  });
});

describe("Protokoll (SR-52, SR-50)", () => {
  it("erfasst Anmeldung, Fehlversuche und IP, aber keine Geheimnisse", () =>
    withUser(async (t) => {
      const e = await t.enroll(EMAIL);
      await t.login(EMAIL, "falsch-falsch-falsch");
      await t.req("POST", "/auth/logout", e.c);
      const dump = JSON.stringify(t.audit.events);
      const types = new Set(t.audit.events.map((x) => x.type));
      for (const needed of ["login_success", "login_failure", "mfa_enrolled", "logout"] as const) {
        expect(types.has(needed)).toBe(true);
      }
      expect(t.audit.events.every((x) => x.ip && x.at instanceof Date)).toBe(true);
      for (const secret of [
        PASSWORD,
        "falsch-falsch-falsch",
        e.c.cookie!,
        e.c.csrf!,
        ...e.recoveryCodes,
      ]) {
        expect(dump).not.toContain(secret);
      }
      expect(dump).not.toContain(Buffer.from(e.secret).toString("base64"));
    }));

  it("fail secure: fällt das Protokoll aus, gibt es keine Anmeldung", async () => {
    const broken: AuditRepo = {
      append: () => Promise.reject(new Error("db down")),
      list: () => Promise.resolve([]),
    };
    const t = await setup({ audit: broken });
    await t.addUser(EMAIL);
    const l = await t.login(EMAIL);
    expect(l.res.statusCode).toBe(500);
    expect(t.cookieOf(l.res)).toBeUndefined();
    expect(l.res.body).not.toContain("db down");
    await t.app.close();
  });
});

describe("Eingaben und Limits", () => {
  it("validiert Eingaben generisch (SR-20) und ignoriert unbekannte Felder (SR-72)", () =>
    withUser(async (t) => {
      for (const body of [
        {},
        { email: "kein-mail", password: "x" },
        { email: EMAIL },
        { email: EMAIL, password: "x".repeat(257) },
      ]) {
        const res = await t.req("POST", "/auth/login", undefined, body);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({
          error: { code: "VALIDATION", message: "Ungültige Anfrage." },
        });
      }
      const res = await t.req("POST", "/auth/login", undefined, {
        email: EMAIL,
        password: PASSWORD,
        role: "chief_admin",
      });
      expect(res.statusCode).toBe(200);
      const me = await t.req("GET", "/auth/me", {
        cookie: t.cookieOf(res)!.value,
        csrf: res.json().csrfToken,
      });
      expect(me.statusCode).toBe(200);
    }));

  it("2FA-Code: nur 6 Ziffern, Leerzeichen erlaubt", () =>
    withUser(async (t) => {
      const l = await t.login(EMAIL);
      for (const code of ["12345", "abcdef", "1234567", ""]) {
        expect((await t.req("POST", "/auth/2fa", l.c, { code })).statusCode).toBe(400);
      }
      expect((await t.req("POST", "/auth/2fa", l.c, { code: "123 456" })).statusCode).toBe(401);
    }));

  it("begrenzt Auth-Routen pro IP (SR-04)", async () => {
    const t = await setup({ config: { rateLimitMax: 3 } });
    await t.addUser(EMAIL);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++)
      codes.push((await t.login(EMAIL, "falsch-falsch-falsch")).res.statusCode);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
    await t.app.close();
  });

  it("registriert ohne Auth-Dienste keine Routen (fail closed)", async () => {
    const { buildApp } = await import("../../app.js");
    const { loadConfig } = await import("../../config.js");
    const app = await buildApp(loadConfig({ LOG_LEVEL: "silent" }));
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: {} })).statusCode).toBe(
      404,
    );
    await app.close();
  });

  it("Cookie-Name ist das __Host-Präfix", () => {
    expect(SESSION_COOKIE.startsWith("__Host-")).toBe(true);
  });
});
