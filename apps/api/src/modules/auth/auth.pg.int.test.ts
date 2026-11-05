import { createHash, randomBytes } from "node:crypto";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { Datenbank } from "@stammbuch/db";
import { createTestDatabase, withCredentials } from "../../../../../packages/db/test/helpers.js";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { Clock, FakeMail, harness, ORIGIN, PASSWORD, testConfig } from "./auth.testkit.js";
import type { Cookies } from "./auth.testkit.js";
import { base32Decode } from "./base32.js";
import { createPgAuth } from "./pg.js";
import { createServices } from "../../services.js";
import { createPasswordHasher } from "./password.js";
import { SESSION_COOKIE } from "./routes.js";
import { hashRecoveryCode, normalizeRecoveryCode } from "./recovery.js";
import { deriveKey, hmacHex } from "./secretbox.js";
import { totpCounter } from "./totp.js";
import type { AuditEvent, AuditRepo } from "./types.js";

/**
 * Integrationstests gegen echtes PostgreSQL (Wegwerf-Container, siehe test/global-setup.ts).
 * Die API läuft als Rolle stammbuch_app (RLS aktiv), Fixtures legt der Eigentümer an.
 */

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const P = "33333333-3333-4333-8333-333333333333"; // Anbieter (Chef-Admin)
const sha256 = (s: string) => createHash("sha256").update(s).digest();

describe("Auth gegen PostgreSQL", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let owner: pg.Client;
  let db: Datenbank;
  let store: ReturnType<typeof createPgAuth>;
  const config = testConfig();
  const clock = new Clock(new Date()); // echte Zeit: die Datenbank prüft Ablauf mit now()
  const mail = new FakeMail();
  const hasher = createPasswordHasher(config.peppers, config.argon2);
  const failAudit = new Set<AuditEvent["type"]>();
  let app: Awaited<ReturnType<typeof buildApp>>;
  let h: ReturnType<typeof harness>;

  const q = async <T extends object = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ) => (await owner.query<T>(text, params)).rows;

  async function addUser(tenant: string, email: string, rolle: "user" | "chief_admin" = "user") {
    const [row] = await q<{ id: string }>(
      `INSERT INTO benutzer (kunde_id, email, name, passwort_hash, rolle)
       VALUES ($1, $2, 'Test', $3, $4) RETURNING id`,
      [tenant, email, await hasher.hash(PASSWORD), rolle],
    );
    return { id: row!.id, tenant, email };
  }

  /** Benutzer anlegen, 2FA einrichten, voll anmelden. */
  async function enrolled(tenant: string, email: string, rolle: "user" | "chief_admin" = "user") {
    const u = await addUser(tenant, email, rolle);
    const e = await h.enroll(email);
    return { ...u, secret: e.secret, recoveryCodes: e.recoveryCodes, c: e.c };
  }

  const activeFullSessions = async (userId: string) =>
    Number(
      (
        await q<{ n: string }>(
          "SELECT count(*) AS n FROM sitzung WHERE benutzer_id = $1 AND phase = 'full' AND widerrufen_am IS NULL",
          [userId],
        )
      )[0]!.n,
    );

  beforeAll(async () => {
    testDb = await createTestDatabase(inject("adminUrl"), inject("templateDb"));
    owner = new pg.Client({ connectionString: testDb.adminUrl });
    await owner.connect();
    await owner.query(
      "INSERT INTO kunde (id, name) VALUES ($1, 'Kunde A'), ($2, 'Kunde B'), ($3, 'Anbieter')",
      [A, B, P],
    );
    db = new Datenbank(withCredentials(testDb.adminUrl, "stammbuch_app", inject("appPassword")));
    store = createPgAuth(db);
    const audit: AuditRepo = {
      append: (ev) =>
        failAudit.has(ev.type) ? Promise.reject(new Error("audit down")) : store.audit.append(ev),
      list: (f) => store.audit.list(f),
    };
    app = await buildApp(loadConfig({ LOG_LEVEL: "silent" }), false, {
      auth: { config, ...store, audit, mail, clock: clock.now },
    });
    // Beispielrouten eines fremden Moduls, die authenticateRequest benutzen.
    app.get("/t/whoami", async (req, reply) => {
      const a = await app.authenticateRequest(req);
      return a ?? reply.status(401).send({ error: "nein" });
    });
    app.post("/t/echo", async (req, reply) => {
      const a = await app.authenticateRequest(req);
      return a ?? reply.status(401).send({ error: "nein" });
    });
    h = harness(app, clock);
  });

  afterAll(async () => {
    await app.close();
    await db.close();
    await owner.end();
    await testDb.drop();
  });

  // ------------------------------------------------------------------------------------------

  it("Login-Ablauf end-to-end: Passwort, TOTP-Einrichtung, Sitzung, Logout, erneuter Login", async () => {
    const u = await addUser(A, "e2e@a.test");

    const l = await h.login(u.email);
    expect(l.res.statusCode).toBe(200);
    expect(l.body.status).toBe("mfa_setup_required");
    const [pending] = await q<{ phase: string; token_hash: Buffer; csrf_token: string }>(
      "SELECT phase, token_hash, csrf_token FROM sitzung WHERE benutzer_id = $1",
      [u.id],
    );
    // Gespeichert wird nur der Hash des Cookie-Tokens (SR-02).
    expect(pending).toMatchObject({ phase: "pending" });
    expect(pending!.token_hash.equals(sha256(l.c.cookie!))).toBe(true);
    expect(
      JSON.stringify(await q("SELECT * FROM sitzung WHERE benutzer_id = $1", [u.id])),
    ).not.toContain(l.c.cookie);

    const setup = await h.req("POST", "/auth/2fa/setup", l.c);
    const secret = base32Decode(setup.json().secret);
    const done = await h.req("POST", "/auth/2fa", l.c, { code: h.codeAt(secret) });
    expect(done.statusCode).toBe(200);
    const codes: string[] = done.json().recoveryCodes;
    expect(codes).toHaveLength(10);
    const full = { cookie: h.cookieOf(done)!.value, csrf: done.json().csrfToken as string };

    const me = await h.req("GET", "/auth/me", full);
    expect(me.json()).toMatchObject({
      state: "authenticated",
      user: { id: u.id, email: u.email, role: "user" },
    });

    // Datenbankzustand: Geheimnis verschlüsselt, Codes nur als HMAC, Zwischen-Sitzung widerrufen.
    const [row] = await q<{
      totp_secret_enc: string;
      totp_letzter_zaehler: string;
      totp_eingerichtet_am: Date;
    }>(
      "SELECT totp_secret_enc, totp_letzter_zaehler, totp_eingerichtet_am FROM benutzer WHERE id = $1",
      [u.id],
    );
    expect(row!.totp_secret_enc).toMatch(/^v1\./);
    expect(row!.totp_secret_enc).not.toContain(setup.json().secret);
    expect(row!.totp_eingerichtet_am).toBeInstanceOf(Date);
    expect(Number(row!.totp_letzter_zaehler)).toBe(totpCounter(clock.t.getTime()));
    const stored = (
      await q<{ code_hmac: string }>(
        "SELECT code_hmac FROM wiederherstellungscode WHERE benutzer_id = $1",
        [u.id],
      )
    ).map((r) => r.code_hmac);
    expect(stored).toHaveLength(10);
    const recoveryKey = deriveKey(config.totpKey, "recovery-code");
    expect(stored.sort()).toEqual(codes.map((c) => hashRecoveryCode(recoveryKey, c)).sort());
    for (const c of codes) expect(stored).not.toContain(normalizeRecoveryCode(c));
    const [pendingNow] = await q<{ widerrufen_am: Date | null }>(
      "SELECT widerrufen_am FROM sitzung WHERE token_hash = $1",
      [sha256(l.c.cookie!)],
    );
    expect(pendingNow!.widerrufen_am).not.toBeNull();
    expect((await h.req("GET", "/auth/me", l.c)).statusCode).toBe(401); // alte ID ist tot

    // Protokoll im Mandanten.
    const types = (await store.audit.list({ tenantId: A, userId: u.id })).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["login_success", "mfa_enrolled", "mfa_success"]));

    // Logout widerruft serverseitig.
    expect((await h.req("POST", "/auth/logout", full)).statusCode).toBe(204);
    expect((await h.req("GET", "/auth/me", full)).statusCode).toBe(401);

    // Erneuter Login braucht den zweiten Faktor.
    const again = await h.fullLogin(u.email, secret);
    expect(again.res.statusCode).toBe(200);
    expect((await h.req("GET", "/auth/me", again.c)).json().state).toBe("authenticated");
  });

  it("Parallel-Replay: derselbe TOTP-Code funktioniert genau einmal", async () => {
    const u = await enrolled(A, "replay@a.test");
    clock.advance(30_000);
    const [l1, l2] = [await h.login(u.email), await h.login(u.email)];
    const code = h.codeAt(u.secret);
    const before = await activeFullSessions(u.id);

    const res = await Promise.all([
      h.req("POST", "/auth/2fa", l1.c, { code }),
      h.req("POST", "/auth/2fa", l2.c, { code }),
    ]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    expect(await activeFullSessions(u.id)).toBe(before + 1);
    expect((await store.audit.list({ tenantId: A, userId: u.id })).map((e) => e.type)).toContain(
      "mfa_replay",
    );

    // Viele gleichzeitige Versuche auf derselben Zwischen-Sitzung: wieder genau ein Erfolg.
    clock.advance(30_000);
    const l3 = await h.login(u.email);
    const code3 = h.codeAt(u.secret);
    const many = await Promise.all(
      Array.from({ length: 6 }, () => h.req("POST", "/auth/2fa", l3.c, { code: code3 })),
    );
    expect(many.filter((r) => r.statusCode === 200)).toHaveLength(1);
  });

  it("atomare Repo-Operationen halten unter Last (CAS)", async () => {
    const u = await enrolled(A, "cas@a.test");
    // TOTP-Zähler: von 20 gleichzeitigen Versuchen mit demselben Zeitschritt gewinnt genau einer.
    const next = totpCounter(clock.t.getTime()) + 5;
    const adv = await Promise.all(
      Array.from({ length: 20 }, () => store.users.advanceTotpCounter(A, u.id, next)),
    );
    expect(adv.filter(Boolean)).toHaveLength(1);
    expect(await store.users.advanceTotpCounter(A, u.id, next - 1)).toBe(false); // nie rückwärts

    // Wiederherstellungscode: gleichzeitig verbrauchen, genau einmal.
    const hash = hmacHex(deriveKey(config.totpKey, "recovery-code"), "CODE");
    await store.users.replaceRecoveryCodes(A, u.id, [
      hash,
      hmacHex(deriveKey(config.totpKey, "recovery-code"), "ANDERER"),
    ]);
    const used = await Promise.all(
      Array.from({ length: 10 }, () => store.users.consumeRecoveryCode(A, u.id, hash)),
    );
    expect(used.filter(Boolean)).toHaveLength(1);
    expect((await store.users.findById(A, u.id))!.recoveryCodeHashes).toHaveLength(1);

    // Einrichtung: bereits eingerichtet, kein zweites Mal.
    expect(await store.users.enrollTotp(A, u.id, "v1.x.y.z", 1, [])).toBe(false);

    // MFA-Fehlversuche zählen lückenlos.
    const [sess] = await q<{ token_hash: Buffer }>(
      "SELECT token_hash FROM sitzung WHERE benutzer_id = $1 LIMIT 1",
      [u.id],
    );
    const id = sess!.token_hash.toString("hex");
    const counts = await Promise.all(
      Array.from({ length: 10 }, () => store.sessions.recordMfaFailure(A, id)),
    );
    expect(counts.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // Sperrzähler: Lesen-Ändern-Schreiben ohne verlorene Aktualisierung, auch für unbekannte Schlüssel.
    const key = hmacHex(deriveKey(config.totpKey, "account-key"), "cas-test");
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.throttle.update(key, (p) => ({
          failures: (p?.failures ?? 0) + 1,
          lastFailureAt: new Date(),
          lockedUntil: null,
        })),
      ),
    );
    expect((await store.throttle.get(key))!.failures).toBe(20);
    await store.throttle.clear(key);
    expect(await store.throttle.get(key)).toBeNull();
  });

  it("Wiederherstellungscode: parallel genau einmal, danach wertlos", async () => {
    const u = await enrolled(A, "recov@a.test");
    clock.advance(30_000);
    const [l1, l2] = [await h.login(u.email), await h.login(u.email)];
    const code = u.recoveryCodes[0]!;
    const res = await Promise.all([
      h.req("POST", "/auth/recovery", l1.c, { code }),
      h.req("POST", "/auth/recovery", l2.c, { code: code.toLowerCase().replaceAll("-", " ") }),
    ]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    expect((await store.users.findById(A, u.id))!.recoveryCodeHashes).toHaveLength(9);
    const l3 = await h.login(u.email);
    expect((await h.req("POST", "/auth/recovery", l3.c, { code })).statusCode).toBe(401);
  });

  it("Sperre: nach 5 Fehlversuchen 429, auch für unbekannte Konten, ohne E-Mail im Protokoll", async () => {
    const u = await addUser(A, "sperre@a.test");
    for (let i = 0; i < 5; i++) {
      expect((await h.login(u.email, "falsch-falsch-falsch")).res.statusCode).toBe(401);
    }
    const locked = await h.login(u.email); // richtiges Passwort hilft nicht
    expect(locked.res.statusCode).toBe(429);
    expect(Number(locked.res.headers["retry-after"])).toBeGreaterThan(0);

    // Unbekanntes Konto: identisches Verhalten (SR-05), Ereignisse ohne Mandanten.
    const ghost = "niemand@nirgends.test";
    const before = Number(
      (await q<{ n: string }>("SELECT count(*) AS n FROM auth_ereignis"))[0]!.n,
    );
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push((await h.login(ghost, "irgendwas-langes-1")).res.statusCode);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    const events = await q<{ aktion: string; details: unknown; benutzer_id: string | null }>(
      "SELECT aktion, details, benutzer_id FROM auth_ereignis ORDER BY id OFFSET $1",
      [before],
    );
    expect(events.map((e) => e.aktion)).toEqual([
      ...Array(5).fill("login_failure"),
      "login_locked",
    ]);
    expect(JSON.stringify(events)).not.toContain("niemand");
    expect(events.every((e) => e.benutzer_id === null)).toBe(true);
    // Der Fehlversuch eines bekannten Kontos steht im Protokoll seines Mandanten.
    expect((await store.audit.list({ tenantId: A, userId: u.id })).map((e) => e.type)).toContain(
      "login_failure",
    );

    // Sperre läuft ab.
    clock.advance(61_000);
    expect((await h.login(u.email)).res.statusCode).toBe(200);
  });

  it("zu viele falsche zweite Faktoren verbrauchen die Sitzung", async () => {
    const u = await enrolled(A, "brute@a.test");
    clock.advance(30_000);
    const l = await h.login(u.email);
    for (let i = 0; i < 5; i++) {
      expect((await h.req("POST", "/auth/2fa", l.c, { code: "000000" })).statusCode).toBe(401);
    }
    // Sitzung ist weg: selbst der richtige Code hilft nicht mehr.
    expect((await h.req("POST", "/auth/2fa", l.c, { code: h.codeAt(u.secret) })).statusCode).toBe(
      401,
    );
    expect(await activeFullSessions(u.id)).toBe(1); // nur die aus der Einrichtung
  });

  it("Rotation: neue Sitzungs-ID bei Login, Wechsel auf volle Stufe und Passwortänderung", async () => {
    const u = await enrolled(A, "rotation@a.test");
    const first = await h.fullLogin(u.email, u.secret);
    const second = await h.fullLogin(u.email, u.secret);
    expect(second.c.cookie).not.toBe(first.c.cookie);

    // Login mit mitgeschicktem alten Cookie widerruft den alten.
    clock.advance(30_000);
    const l = await h.login(u.email, PASSWORD, second.c);
    expect(l.c.cookie).not.toBe(second.c.cookie);
    expect((await h.req("GET", "/auth/me", second.c)).statusCode).toBe(401);
    expect(
      await q(
        "SELECT widerrufen_am FROM sitzung WHERE token_hash = $1 AND widerrufen_am IS NOT NULL",
        [sha256(second.c.cookie!)],
      ),
    ).toHaveLength(1);

    // Pending -> full: das Pending-Token wird ungültig.
    const done = await h.req("POST", "/auth/2fa", l.c, { code: h.codeAt(u.secret) });
    expect(done.statusCode).toBe(200);
    expect(h.cookieOf(done)!.value).not.toBe(l.c.cookie);
    expect((await h.req("GET", "/auth/me", l.c)).statusCode).toBe(401);

    // Passwortänderung: alle anderen Sitzungen sterben, die neue hat eine frische ID.
    const cur = { cookie: h.cookieOf(done)!.value, csrf: done.json().csrfToken as string };
    const pw = await h.req("POST", "/auth/password", cur, {
      currentPassword: PASSWORD,
      newPassword: "ein-ganz-anderes-passwort-9",
    });
    expect(pw.statusCode).toBe(200);
    expect((await h.req("GET", "/auth/me", cur)).statusCode).toBe(401);
    expect((await h.req("GET", "/auth/me", first.c)).statusCode).toBe(401);
    expect(await activeFullSessions(u.id)).toBe(1);
  });

  it("deaktivierte Benutzer: keine Anmeldung, bestehende Sitzungen enden", async () => {
    const u = await enrolled(A, "weg@a.test");
    await q("UPDATE benutzer SET aktiv = false WHERE id = $1", [u.id]);
    expect((await h.req("GET", "/auth/me", u.c)).statusCode).toBe(401);
    expect((await h.login(u.email)).res.statusCode).toBe(401);
  });

  describe("Chef-Admin-Reset des zweiten Faktors", () => {
    it("wirkt mandantenübergreifend, verlangt frischen TOTP-Code und protokolliert im Mandanten des Ziels", async () => {
      const chef = await enrolled(P, "chef@anbieter.test", "chief_admin");
      const target = await enrolled(A, "ziel@a.test");
      const targetSession = target.c;
      const reset = (id: string, code: string, c = chef.c) =>
        h.req("POST", `/auth/admin/users/${id}/2fa-reset`, c, { code });

      // Der Code der Anmeldung ist nicht "frisch": derselbe Zeitschritt wird abgelehnt.
      expect((await reset(target.id, h.codeAt(chef.secret))).statusCode).toBe(401);
      expect((await reset(target.id, "000000")).statusCode).toBe(401);
      expect((await store.users.findById(A, target.id))!.totpSecretEnc).not.toBeNull();
      expect((await h.req("GET", "/auth/me", targetSession)).statusCode).toBe(200);

      mail.sent.length = 0;
      clock.advance(30_000);
      const ok = await reset(target.id, h.codeAt(chef.secret));
      expect(ok.statusCode).toBe(204);

      const after = (await store.users.findById(A, target.id))!;
      expect(after).toMatchObject({
        totpSecretEnc: null,
        totpLastCounter: null,
        recoveryCodeHashes: [],
      });
      expect(after.passwordHash).toBeTruthy(); // keine Passwortübernahme
      expect((await h.req("GET", "/auth/me", targetSession)).statusCode).toBe(401);
      expect(mail.sent).toEqual([{ kind: "mfa_reset", to: "ziel@a.test", at: expect.any(Date) }]);

      // Eintrag im Protokoll des Ziel-Mandanten; der Akteur aus fremdem Mandanten steht in den Details.
      const [ev] = await q<{
        benutzer_id: string | null;
        objekt_id: string;
        details: { akteur: string };
      }>(
        "SELECT benutzer_id, objekt_id, details FROM audit_log WHERE kunde_id = $1 AND aktion = 'mfa_reset'",
        [A],
      );
      expect(ev).toMatchObject({
        benutzer_id: null,
        objekt_id: target.id,
        details: { akteur: chef.id },
      });
      expect(
        await q("SELECT 1 FROM audit_log WHERE kunde_id = $1 AND aktion = 'mfa_reset'", [P]),
      ).toHaveLength(0);
      expect(
        (await store.audit.list({ tenantId: A, userId: target.id })).find(
          (e) => e.type === "mfa_reset",
        ),
      ).toMatchObject({
        actorUserId: chef.id,
        targetUserId: target.id,
        outcome: "success",
      });
      // Fehlgeschlagene Step-ups stehen im Protokoll des Akteurs.
      expect(
        (await store.audit.list({ tenantId: P, userId: chef.id })).filter(
          (e) => e.type === "stepup_failure",
        ),
      ).toHaveLength(2);

      // Der Benutzer richtet beim nächsten Login neu ein.
      clock.advance(30_000);
      expect((await h.login(target.email)).body.status).toBe("mfa_setup_required");
    });

    it("verweigert normale Benutzer, Selbst-Reset und unbekannte Ziele", async () => {
      const user = await enrolled(A, "nurnutzer@a.test");
      const other = await enrolled(B, "andere@b.test");
      const chef = await enrolled(P, "chef2@anbieter.test", "chief_admin");
      clock.advance(30_000);
      const userFull = await h.fullLogin(user.email, user.secret);
      clock.advance(30_000);
      const denied = await h.req("POST", `/auth/admin/users/${other.id}/2fa-reset`, userFull.c, {
        code: h.codeAt(user.secret),
      });
      expect(denied.statusCode).toBe(403);
      expect((await store.users.findById(B, other.id))!.totpSecretEnc).not.toBeNull();
      expect(
        (await store.audit.list({ tenantId: A, userId: user.id })).map((e) => e.type),
      ).toContain("mfa_reset_denied");

      // Auch direkt: die Datenquelle gibt Nicht-Chef-Admins kein fremdes Ziel heraus.
      expect(await store.users.findForMfaReset(user.id, other.id)).toBeNull();
      expect(await store.users.findForMfaReset(chef.id, other.id)).toMatchObject({
        tenantId: B,
        id: other.id,
      });
      expect(await store.users.findForMfaReset(chef.id, "kein-uuid")).toBeNull();

      clock.advance(30_000);
      const chefFull = await h.fullLogin(chef.email, chef.secret);
      const self = await h.req("POST", `/auth/admin/users/${chef.id}/2fa-reset`, chefFull.c, {
        code: "123456",
      });
      expect(self.statusCode).toBe(403);
      clock.advance(30_000);
      const missing = await h.req(
        "POST",
        `/auth/admin/users/${"44444444-4444-4444-8444-444444444444"}/2fa-reset`,
        chefFull.c,
        { code: h.codeAt(chef.secret) },
      );
      expect(missing.statusCode).toBe(404);
      clock.advance(30_000);
      const junk = await h.req("POST", "/auth/admin/users/gibt-es-nicht/2fa-reset", chefFull.c, {
        code: h.codeAt(chef.secret),
      });
      expect(junk.statusCode).toBe(404);
    });
  });

  it("Wiederherstellungscodes erneuern: nur mit frischem TOTP, alte Codes sind wertlos", async () => {
    const u = await enrolled(A, "renew@a.test");
    const renew = (code: string) => h.req("POST", "/auth/recovery-codes/renew", u.c, { code });

    expect((await renew(h.codeAt(u.secret))).statusCode).toBe(401); // nicht frisch
    expect((await renew("000000")).statusCode).toBe(401);
    expect((await store.users.findById(A, u.id))!.recoveryCodeHashes).toHaveLength(10);

    clock.advance(30_000);
    mail.sent.length = 0;
    const res = await renew(h.codeAt(u.secret));
    expect(res.statusCode).toBe(200);
    const fresh: string[] = res.json().recoveryCodes;
    expect(fresh).toHaveLength(10);
    expect(fresh.some((c) => u.recoveryCodes.includes(c))).toBe(false);
    expect(mail.sent).toEqual([
      { kind: "recovery_codes_renewed", to: u.email, at: expect.any(Date) },
    ]);
    expect((await store.audit.list({ tenantId: A, userId: u.id })).map((e) => e.type)).toContain(
      "recovery_codes_renewed",
    );

    clock.advance(30_000);
    const l = await h.login(u.email);
    expect(
      (await h.req("POST", "/auth/recovery", l.c, { code: u.recoveryCodes[0] })).statusCode,
    ).toBe(401);
    expect((await h.req("POST", "/auth/recovery", l.c, { code: fresh[0] })).statusCode).toBe(200);

    // Ohne volle Sitzung kein Zugang.
    const pending = await h.login(u.email);
    expect(
      (await h.req("POST", "/auth/recovery-codes/renew", pending.c, { code: "123456" })).statusCode,
    ).toBe(401);
  });

  describe("Mandantentrennung", () => {
    it("Repos sehen und ändern nur den eigenen Mandanten", async () => {
      const a = await enrolled(A, "iso-a@a.test");
      const b = await enrolled(B, "iso-b@b.test");

      expect(await store.users.findById(A, b.id)).toBeNull();
      expect(await store.users.findById(B, b.id)).toMatchObject({ tenantId: B });
      await store.sessions.revokeAllForUser(A, b.id);
      await store.users.clearTotp(A, b.id);
      await store.users.setPasswordHash(A, b.id, "x");
      expect(await activeFullSessions(b.id)).toBe(1);
      expect((await store.users.findById(B, b.id))!.totpSecretEnc).not.toBeNull();
      expect((await store.users.findById(B, b.id))!.passwordHash).not.toBe("x");

      const events = await store.audit.list({ tenantId: A, limit: 500 });
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.tenantId === A)).toBe(true);
      expect(events.some((e) => e.targetUserId === b.id)).toBe(false);
      await expect(store.audit.list({})).rejects.toThrow();

      // Mandantenwechsel innerhalb einer Transaktion ist ein Fehler.
      await expect(store.atomic(A, () => store.users.findById(B, b.id))).rejects.toThrow(
        "Mandantenwechsel",
      );

      // Mandant der Sitzung kommt aus der Datenbank.
      expect((await h.req("GET", "/t/whoami", a.c)).json()).toEqual({
        tenantId: A,
        userId: a.id,
        rolle: "user",
      });
      expect((await h.req("GET", "/t/whoami", b.c)).json()).toEqual({
        tenantId: B,
        userId: b.id,
        rolle: "user",
      });
    });

    it("die Anwendungsrolle kann weder Rolle noch Mandant eines Benutzers setzen, noch gesperrte Tabellen lesen", async () => {
      const a = await addUser(A, "rolle@a.test");
      const denied = { code: "42501" };
      await expect(
        db.withKunde(A, (t) =>
          sql`UPDATE benutzer SET rolle = 'chief_admin' WHERE id = ${a.id}`.execute(t),
        ),
      ).rejects.toMatchObject(denied);
      await expect(
        db.withKunde(A, (t) =>
          sql`UPDATE benutzer SET kunde_id = ${B} WHERE id = ${a.id}`.execute(t),
        ),
      ).rejects.toMatchObject(denied);
      await expect(
        db.withKunde(A, (t) =>
          sql`INSERT INTO benutzer (kunde_id, email, name, passwort_hash, rolle) VALUES (${A}, 'x@a.test', 'X', 'h', 'chief_admin')`.execute(
            t,
          ),
        ),
      ).rejects.toMatchObject(denied);
      for (const t of ["auth_sperre", "auth_ereignis"]) {
        await expect(
          db.kysely.executeQuery(sql`SELECT * FROM ${sql.table(t)}`.compile(db.kysely)),
        ).rejects.toMatchObject(denied);
      }
      expect(
        (await q<{ rolle: string }>("SELECT rolle FROM benutzer WHERE id = $1", [a.id]))[0]!.rolle,
      ).toBe("user");
    });
  });

  describe("Atomarität: Aktion und Audit-Eintrag gelten zusammen oder gar nicht", () => {
    it("fällt das Protokoll bei der Einrichtung aus, bleibt nichts zurück und ein Wiederholen klappt", async () => {
      const u = await addUser(A, "atom1@a.test");
      const l = await h.login(u.email);
      const setup = await h.req("POST", "/auth/2fa/setup", l.c);
      const secret = base32Decode(setup.json().secret);

      failAudit.add("mfa_success");
      try {
        const res = await h.req("POST", "/auth/2fa", l.c, { code: h.codeAt(secret) });
        expect(res.statusCode).toBe(500);
      } finally {
        failAudit.clear();
      }
      const [row] = await q<{ totp_secret_enc: string | null }>(
        "SELECT totp_secret_enc FROM benutzer WHERE id = $1",
        [u.id],
      );
      expect(row!.totp_secret_enc).toBeNull();
      expect(
        await q("SELECT 1 FROM wiederherstellungscode WHERE benutzer_id = $1", [u.id]),
      ).toHaveLength(0);
      expect(
        await q("SELECT 1 FROM audit_log WHERE benutzer_id = $1 AND aktion = 'mfa_enrolled'", [
          u.id,
        ]),
      ).toHaveLength(0);
      // Zwischen-Sitzung lebt noch: gleicher Code, zweiter Versuch.
      expect((await h.req("POST", "/auth/2fa", l.c, { code: h.codeAt(secret) })).statusCode).toBe(
        200,
      );
    });

    it("fällt das Protokoll beim TOTP-Login aus, wird der Zähler nicht verbraucht", async () => {
      const u = await enrolled(A, "atom2@a.test");
      clock.advance(30_000);
      const l = await h.login(u.email);
      const code = h.codeAt(u.secret);
      const counterBefore = (await store.users.findById(A, u.id))!.totpLastCounter;
      failAudit.add("mfa_success");
      try {
        expect((await h.req("POST", "/auth/2fa", l.c, { code })).statusCode).toBe(500);
      } finally {
        failAudit.clear();
      }
      expect((await store.users.findById(A, u.id))!.totpLastCounter).toBe(counterBefore);
      expect((await h.req("POST", "/auth/2fa", l.c, { code })).statusCode).toBe(200);
    });

    it("fällt das Protokoll beim Login oder beim Passwortwechsel aus, entsteht keine Sitzung bzw. bleibt alles beim Alten", async () => {
      const u = await enrolled(A, "atom3@a.test");
      const sessionsBefore = Number(
        (
          await q<{ n: string }>("SELECT count(*) AS n FROM sitzung WHERE benutzer_id = $1", [u.id])
        )[0]!.n,
      );
      failAudit.add("login_success");
      try {
        expect((await h.login(u.email)).res.statusCode).toBe(500);
      } finally {
        failAudit.clear();
      }
      expect(
        Number(
          (
            await q<{ n: string }>("SELECT count(*) AS n FROM sitzung WHERE benutzer_id = $1", [
              u.id,
            ])
          )[0]!.n,
        ),
      ).toBe(sessionsBefore);

      const hashBefore = (
        await q<{ passwort_hash: string }>("SELECT passwort_hash FROM benutzer WHERE id = $1", [
          u.id,
        ])
      )[0]!.passwort_hash;
      failAudit.add("password_changed");
      try {
        const res = await h.req("POST", "/auth/password", u.c, {
          currentPassword: PASSWORD,
          newPassword: "ein-ganz-anderes-passwort-9",
        });
        expect(res.statusCode).toBe(500);
      } finally {
        failAudit.clear();
      }
      expect(
        (
          await q<{ passwort_hash: string }>("SELECT passwort_hash FROM benutzer WHERE id = $1", [
            u.id,
          ])
        )[0]!.passwort_hash,
      ).toBe(hashBefore);
      expect((await h.req("GET", "/auth/me", u.c)).statusCode).toBe(200); // Sitzung nicht widerrufen
    });

    it("fällt das Protokoll beim Reset aus, bleibt der zweite Faktor des Ziels bestehen", async () => {
      const chef = await enrolled(P, "chef3@anbieter.test", "chief_admin");
      const target = await enrolled(A, "atom4@a.test");
      clock.advance(30_000);
      failAudit.add("mfa_reset");
      try {
        const res = await h.req("POST", `/auth/admin/users/${target.id}/2fa-reset`, chef.c, {
          code: h.codeAt(chef.secret),
        });
        expect(res.statusCode).toBe(500);
      } finally {
        failAudit.clear();
      }
      expect((await store.users.findById(A, target.id))!.totpSecretEnc).not.toBeNull();
      expect(await activeFullSessions(target.id)).toBe(1);
    });
  });

  describe("authenticateRequest für andere Module", () => {
    it("gibt {tenantId, userId, rolle} nur für volle Sitzungen mit gültigem CSRF zurück", async () => {
      const u = await enrolled(A, "auth-req@a.test");
      const chef = await enrolled(P, "chef4@anbieter.test", "chief_admin");

      expect((await h.req("GET", "/t/whoami", u.c)).json()).toEqual({
        tenantId: A,
        userId: u.id,
        rolle: "user",
      });
      expect((await h.req("GET", "/t/whoami", chef.c)).json()).toEqual({
        tenantId: P,
        userId: chef.id,
        rolle: "chief_admin",
      });

      // Kein Cookie, falsches Cookie, nur Zwischen-Sitzung.
      expect((await h.req("GET", "/t/whoami")).statusCode).toBe(401);
      expect(
        (await h.req("GET", "/t/whoami", { cookie: "x".repeat(43), csrf: undefined })).statusCode,
      ).toBe(401);
      clock.advance(30_000);
      const pending = await h.login(u.email);
      expect((await h.req("GET", "/t/whoami", pending.c)).statusCode).toBe(401);

      // Schreibende Methoden: CSRF-Token und Origin sind Pflicht.
      expect((await h.req("POST", "/t/echo", u.c, {})).statusCode).toBe(200);
      expect((await h.req("POST", "/t/echo", { ...u.c, csrf: undefined }, {})).statusCode).toBe(
        401,
      );
      expect((await h.req("POST", "/t/echo", { ...u.c, csrf: "falsch" }, {})).statusCode).toBe(401);
      expect(
        (await h.req("POST", "/t/echo", u.c, {}, { origin: "https://evil.test" })).statusCode,
      ).toBe(401);
      expect((await h.req("POST", "/t/echo", u.c, {}, { origin: ORIGIN })).statusCode).toBe(200);
      expect(
        (await store.audit.list({ tenantId: A, userId: u.id })).filter(
          (e) => e.type === "csrf_rejected",
        ).length,
      ).toBeGreaterThanOrEqual(3);

      // Das Cookie allein reicht auch ohne Cookie-Plugin im Modul: rohe Header genügen.
      const raw = await app.inject({
        method: "GET",
        url: "/t/whoami",
        headers: { cookie: `a=b; ${SESSION_COOKIE}=${u.c.cookie}; c=d` },
      });
      expect(raw.json()).toMatchObject({ userId: u.id });
    });

    it("ohne Auth-Dienste gibt es keine Anmeldung (fail closed)", async () => {
      const bare = await buildApp(loadConfig({ LOG_LEVEL: "silent" }), false);
      expect(await bare.authenticateRequest({ headers: {}, method: "GET" } as never)).toBeNull();
      await bare.close();
    });
  });

  it("Start fehlgeschlagen statt unsicher: fehlende DATABASE_URL, Konfiguration oder privilegierte Rolle", async () => {
    const env = {
      AUTH_PEPPERS: `p1:${"x".repeat(40)}`,
      AUTH_TOTP_KEY: Buffer.alloc(32, 7).toString("base64"),
      APP_ORIGIN: ORIGIN,
    };
    const log = () => undefined;
    await expect(createServices(log, env)).rejects.toThrow("DATABASE_URL fehlt");
    await expect(createServices(log, { ...env, AUTH_PEPPERS: "zu-kurz" })).rejects.toThrow();
    // Eigentümer-/Superuser-Verbindung würde RLS aushebeln.
    await expect(createServices(log, { ...env, DATABASE_URL: testDb.adminUrl })).rejects.toThrow(
      "Superuser",
    );
    const appUrl = withCredentials(testDb.adminUrl, "stammbuch_app", inject("appPassword"));
    const ok = await createServices(log, { ...env, DATABASE_URL: appUrl });
    expect(ok.services.auth).toBeDefined();
    await ok.close();
  });

  describe("Einladung einlösen (Issue #56)", () => {
    const URL = "/auth/invitations/redeem";
    const NEW_PASSWORD = "ein-neues-langes-passwort-42";
    const neutral = {
      error: { code: "INVALID_INVITATION", message: "Die Einladung ist ungültig oder abgelaufen." },
    };
    const redeem = (token: string, password = NEW_PASSWORD, c?: Cookies) =>
      h.req("POST", URL, c, { token, password });

    /** Legt eine Einladung wie die Platform an (nur der Hash wird gespeichert) und liefert das Token. */
    async function invitation(
      tenant: string,
      email: string,
      opts: {
        rolle?: "admin" | "user";
        userId?: string;
        ablauf?: string;
        eingeloest?: boolean;
      } = {},
    ) {
      const token = randomBytes(32).toString("base64url");
      await q(
        `INSERT INTO einladung (kunde_id, email, rolle, benutzer_id, token_hash, erstellt_am, laeuft_ab_am, eingeloest_am)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz - interval '1 minute', $6::timestamptz + $7::interval, $8)`,
        [
          tenant,
          email,
          opts.rolle ?? "admin",
          opts.userId ?? null,
          sha256(token),
          clock.t,
          opts.ablauf ?? "7 days",
          opts.eingeloest ? clock.t : null,
        ],
      );
      return token;
    }
    const consumed = async (token: string) =>
      (
        await q<{ eingeloest_am: Date | null }>(
          "SELECT eingeloest_am FROM einladung WHERE token_hash = $1",
          [sha256(token)],
        )
      )[0]!.eingeloest_am !== null;
    const userRow = async (email: string) =>
      (
        await q<{
          id: string;
          kunde_id: string;
          name: string;
          passwort_hash: string;
          aktiv: boolean;
          status: string;
          kunden_rolle: string;
          rolle: string;
        }>(
          "SELECT id, kunde_id, name, passwort_hash, aktiv, status, kunden_rolle, rolle FROM benutzer WHERE email = $1",
          [email],
        )
      )[0];

    it("der erste Admin eines Kunden: Benutzer entsteht aktiv im Kunden der Einladung, 2FA, dann normale Anmeldung", async () => {
      const token = await invitation(A, "erster.admin@a.test");
      const res = await redeem(token);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "mfa_setup_required", csrfToken: expect.any(String) });

      const row = (await userRow("erster.admin@a.test"))!;
      expect(row).toMatchObject({
        kunde_id: A,
        name: "erster.admin",
        aktiv: true,
        status: "active",
        kunden_rolle: "admin",
        rolle: "user", // nie Anbieterrechte
      });
      expect(row.passwort_hash).toMatch(/^p2:\$argon2id\$/);
      expect(row.passwort_hash).not.toContain(NEW_PASSWORD);
      expect(await consumed(token)).toBe(true);

      // Die Zwischen-Sitzung kann nur die Einrichtung des zweiten Faktors.
      const c = { cookie: h.cookieOf(res)!.value, csrf: res.json().csrfToken as string };
      expect((await h.req("GET", "/t/whoami", c)).statusCode).toBe(401);
      const setup = await h.req("POST", "/auth/2fa/setup", c);
      const secret = base32Decode(setup.json().secret);
      const done = await h.req("POST", "/auth/2fa", c, { code: h.codeAt(secret) });
      expect(done.statusCode).toBe(200);
      expect(done.json().recoveryCodes).toHaveLength(10);
      const full = { cookie: h.cookieOf(done)!.value, csrf: done.json().csrfToken as string };
      expect((await h.req("GET", "/t/whoami", full)).json()).toEqual({
        tenantId: A,
        userId: row.id,
        rolle: "user",
      });
      await h.req("POST", "/auth/logout", full);

      // Anmelden wie jeder andere: neues Passwort, dann Code.
      clock.advance(30_000);
      const l = await h.login("erster.admin@a.test", NEW_PASSWORD);
      expect(l.body.status).toBe("mfa_required");
      const code = await h.req("POST", "/auth/2fa", l.c, { code: h.codeAt(secret) });
      expect(code.statusCode).toBe(200);

      const types = (await store.audit.list({ tenantId: A, userId: row.id })).map((e) => e.type);
      expect(types).toEqual(expect.arrayContaining(["invitation_redeemed", "mfa_enrolled"]));
      const redeemed = (await store.audit.list({ tenantId: A, userId: row.id })).find(
        (e) => e.type === "invitation_redeemed",
      )!;
      expect(redeemed).toMatchObject({ outcome: "success", detail: { role: "admin" } });
      expect(JSON.stringify(redeemed)).not.toContain(token);
    });

    it("ein eingeladener Benutzer wird aktiviert; die Kundenrolle kommt aus der Einladung", async () => {
      const [inv] = await q<{ id: string }>(
        `INSERT INTO benutzer (kunde_id, email, name, passwort_hash, aktiv, kunden_rolle, status)
         VALUES ($1, 'eingeladen@a.test', 'Eingeladen', '!', false, 'user', 'invited') RETURNING id`,
        [A],
      );
      expect((await h.login("eingeladen@a.test", NEW_PASSWORD)).res.statusCode).toBe(401);
      const token = await invitation(A, "eingeladen@a.test", { rolle: "admin", userId: inv!.id });
      expect((await redeem(token)).statusCode).toBe(200);
      expect(await userRow("eingeladen@a.test")).toMatchObject({
        id: inv!.id,
        name: "Eingeladen",
        aktiv: true,
        status: "active",
        kunden_rolle: "admin",
      });
      clock.advance(30_000);
      expect((await h.login("eingeladen@a.test", NEW_PASSWORD)).res.statusCode).toBe(200);
    });

    it("ein Token gilt einmal; abgelaufen, benutzt, falsch und unbekannt liefern dieselbe Antwort", async () => {
      const used = await invitation(A, "benutzt@a.test");
      expect((await redeem(used)).statusCode).toBe(200);
      const answers = [
        await redeem(used, "ein-anderes-passwort-77"), // benutzt
        await redeem(await invitation(A, "alt@a.test", { ablauf: "-1 second" })), // abgelaufen
        await redeem(await invitation(A, "fertig@a.test", { eingeloest: true })), // schon eingelöst
        await redeem(randomBytes(32).toString("base64url")), // unbekannt
        await redeem("kein base64url!"), // beschädigt
        await redeem("0".repeat(64)), // sieht aus wie ein Hash, ist keiner
      ];
      for (const a of answers) {
        expect(a.statusCode).toBe(400);
        expect(a.json()).toEqual(neutral);
        expect(a.cookies).toHaveLength(0);
      }
      expect(await userRow("alt@a.test")).toBeUndefined();
      expect(await userRow("fertig@a.test")).toBeUndefined();
      const [hash] = await q<{ passwort_hash: string }>(
        "SELECT passwort_hash FROM benutzer WHERE email = 'benutzt@a.test'",
      );
      expect(await hasher.verify(hash!.passwort_hash, NEW_PASSWORD)).toBe(true);
      expect(await hasher.verify(hash!.passwort_hash, "ein-anderes-passwort-77")).toBe(false);
    });

    it("gleichzeitig eingelöst gewinnt genau eine Anfrage", async () => {
      const token = await invitation(A, "rennen@a.test");
      const res = await Promise.all(
        [1, 2, 3, 4, 5, 6].map((i) => redeem(token, `passwort-nummer-${i}-lang`)),
      );
      expect(res.map((r) => r.statusCode).sort()).toEqual([200, 400, 400, 400, 400, 400]);
      expect(await q("SELECT 1 FROM benutzer WHERE email = 'rennen@a.test'")).toHaveLength(1);
    });

    it("schwache Passwörter verbrauchen die Einladung nicht", async () => {
      const token = await invitation(A, "schwach.berta@a.test");
      for (const password of ["kurz", "passwordpassword", "mein-schwach.berta-pw"]) {
        const res = await redeem(token, password);
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe("WEAK_PASSWORD");
      }
      expect(await consumed(token)).toBe(false);
      expect(await userRow("schwach.berta@a.test")).toBeUndefined();
      expect((await redeem(token)).statusCode).toBe(200);
    });

    it("ein aktives Konto lässt sich nicht übernehmen, und die Einladung bleibt unverbraucht (alles oder nichts)", async () => {
      const victim = await addUser(A, "opfer@a.test");
      const before = (await userRow("opfer@a.test"))!.passwort_hash;
      const viaMail = await invitation(A, "opfer@a.test"); // erster Admin mit vergebener Adresse
      const viaId = await invitation(A, "opfer@a.test", { userId: victim.id }); // Verweis auf ein aktives Konto
      for (const token of [viaMail, viaId]) {
        const res = await redeem(token, "uebernahme-passwort-123");
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual(neutral);
        expect(await consumed(token)).toBe(false);
      }
      expect((await userRow("opfer@a.test"))!.passwort_hash).toBe(before);
    });

    it("Mandantentrennung: eine Adresse eines anderen Kunden ist ebenso gesperrt, der Benutzer landet nur im Kunden der Einladung", async () => {
      await addUser(B, "fremd@b.test");
      const clash = await invitation(A, "fremd@b.test");
      expect((await redeem(clash)).statusCode).toBe(400);
      expect(await consumed(clash)).toBe(false);

      const token = await invitation(B, "neu@b.test", { rolle: "user" });
      expect((await redeem(token)).statusCode).toBe(200);
      const row = (await userRow("neu@b.test"))!;
      expect(row).toMatchObject({ kunde_id: B, kunden_rolle: "user" });
      // Aus Sicht des anderen Kunden gibt es den Benutzer nicht; das Ereignis steht im Protokoll von B.
      expect(await store.users.findById(A, row.id)).toBeNull();
      expect(await store.users.findById(B, row.id)).not.toBeNull();
      expect((await store.audit.list({ tenantId: A })).some((e) => e.targetUserId === row.id)).toBe(
        false,
      );
      expect((await store.audit.list({ tenantId: B })).some((e) => e.targetUserId === row.id)).toBe(
        true,
      );
    });

    it("gesperrte oder beendete Kunden lassen keine Einladung einlösen", async () => {
      const token = await invitation(B, "gesperrt@b.test");
      await q("UPDATE kunde SET status = 'suspended' WHERE id = $1", [B]);
      try {
        const res = await redeem(token);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual(neutral);
        expect(await consumed(token)).toBe(false);
      } finally {
        await q("UPDATE kunde SET status = 'active' WHERE id = $1", [B]);
      }
      expect((await redeem(token)).statusCode).toBe(200);
    });

    it("fällt das Protokoll aus, bleibt die Einladung gültig und es entsteht kein Benutzer (SR-54)", async () => {
      const token = await invitation(A, "audit.aus@a.test");
      failAudit.add("invitation_redeemed");
      try {
        const res = await redeem(token);
        expect(res.statusCode).toBe(500);
        expect(await consumed(token)).toBe(false);
        expect(await userRow("audit.aus@a.test")).toBeUndefined();
      } finally {
        failAudit.delete("invitation_redeemed");
      }
      expect((await redeem(token)).statusCode).toBe(200);
    });

    it("Fehlversuche stehen ohne Token im Ereignisprotokoll", async () => {
      await redeem("x".repeat(43));
      const rows = await q<{ aktion: string; ergebnis: string; details: object }>(
        "SELECT aktion, ergebnis, details FROM auth_ereignis WHERE aktion = 'invitation_rejected' ORDER BY id DESC LIMIT 1",
      );
      expect(rows[0]).toMatchObject({ aktion: "invitation_rejected", ergebnis: "failure" });
      expect(JSON.stringify(rows)).not.toContain("xxxxxxxx");
    });

    it("ein Chef-Admin lässt sich nicht über eine Einladung anlegen oder überschreiben", async () => {
      const chef = await addUser(P, "chef.einladung@anbieter.test", "chief_admin");
      const before = (await userRow("chef.einladung@anbieter.test"))!.passwort_hash;
      const token = await invitation(P, "chef.einladung@anbieter.test", { userId: chef.id });
      expect((await redeem(token, "uebernahme-passwort-123")).statusCode).toBe(400);
      expect((await userRow("chef.einladung@anbieter.test"))!.passwort_hash).toBe(before);
    });
  });

  it("Aufräumen: abgelaufene und widerrufene Sitzungen, alte Zähler und Ereignisse verschwinden", async () => {
    const u = await addUser(A, "purge@a.test");
    const ins = (tag: string, ablauf: string, widerruf: string | null) =>
      q(
        `INSERT INTO sitzung (kunde_id, benutzer_id, token_hash, erstellt_am, laeuft_ab_am, widerrufen_am, phase, csrf_token)
         VALUES ($1, $2, $3, now() - interval '3 hours', now() + $4::interval, $5, 'full', 'c')`,
        [A, u.id, sha256(tag), ablauf, widerruf ? new Date() : null],
      );
    await ins("abgelaufen", "-1 hour", null);
    await ins("widerrufen", "1 hour", "x");
    await ins("gueltig", "1 hour", null);
    const old = "a".repeat(64);
    await q(
      "INSERT INTO auth_sperre (schluessel, fehlversuche, letzter_fehler) VALUES ($1, 3, now() - interval '2 days')",
      [old],
    );
    await q(
      "INSERT INTO auth_ereignis (zeitpunkt, aktion, ergebnis) VALUES (now() - interval '100 days', 'alt', 'failure')",
    );

    const res = await db.raeumeAuthAuf(new Date());
    expect(res.sitzungen).toBeGreaterThanOrEqual(2);
    expect(res.sperren).toBeGreaterThanOrEqual(1);
    expect(res.ereignisse).toBeGreaterThanOrEqual(1);
    const left = await q<{ token_hash: Buffer }>(
      "SELECT token_hash FROM sitzung WHERE benutzer_id = $1",
      [u.id],
    );
    expect(left.map((r) => r.token_hash.toString("hex"))).toEqual([
      sha256("gueltig").toString("hex"),
    ]);
    expect(await q("SELECT 1 FROM auth_ereignis WHERE aktion = 'alt'")).toHaveLength(0);
    expect(await store.sessions.deleteExpired(new Date())).toBeGreaterThanOrEqual(0);
  });
});
