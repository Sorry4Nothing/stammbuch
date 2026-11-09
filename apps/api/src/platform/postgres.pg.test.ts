import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { Datenbank } from "@stammbuch/db";
import { SecretBox, pgRotationSource, totpBoxFromEnv } from "@stammbuch/mail";
import { createTestDatabase, withCredentials } from "../../../../packages/db/test/helpers.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { Clock, PASSWORD, harness, testConfig } from "../modules/auth/auth.testkit.js";
import type { Cookies } from "../modules/auth/auth.testkit.js";
import { base32Decode } from "../modules/auth/base32.js";
import { createPgAuth } from "../modules/auth/pg.js";
import { createPasswordHasher } from "../modules/auth/password.js";
import { createTenantResolver } from "../modules/people/postgres.js";
import { SESSION_COOKIE } from "../modules/auth/routes.js";
import { makePng } from "./platform.testkit.js";
import { hashToken } from "./helpers.js";
import { createPostgresPlatform } from "./postgres.js";
import type { InvitationMessage, Platform } from "./types.js";

/**
 * Platform gegen echtes PostgreSQL (Wegwerf-Container, siehe packages/db/test/global-setup.ts). Die API läuft als
 * Rolle stammbuch_app (RLS aktiv), Anmeldung und Sitzung sind die echten (Auth-Modul, PostgreSQL), Fixtures legt der
 * Eigentümer an.
 */

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const P = "33333333-3333-4333-8333-333333333333"; // Anbieter (Chef-Admin)

describe("Platform gegen PostgreSQL", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let owner: pg.Client;
  let db: Datenbank;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let platform: Platform;
  const sent: InvitationMessage[] = [];
  const clock = new Clock(new Date());
  const config = testConfig();
  const hasher = createPasswordHasher(config.peppers, config.argon2);
  let h: ReturnType<typeof harness>;

  const ids = {} as Record<"aAdmin" | "aUser" | "bAdmin" | "chef", string>;
  const sessions = {} as Record<keyof typeof ids, Cookies>;
  const secrets = {} as Record<keyof typeof ids, Buffer>;

  async function addUser(
    key: keyof typeof ids,
    tenant: string,
    email: string,
    opts: { rolle?: "user" | "chief_admin"; kunden?: "admin" | "user" } = {},
  ) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO benutzer (kunde_id, email, name, passwort_hash, rolle, kunden_rolle)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        tenant,
        email,
        key,
        await hasher.hash(PASSWORD),
        opts.rolle ?? "user",
        opts.kunden ?? "user",
      ],
    );
    ids[key] = rows[0]!.id;
    const enrolled = await h.enroll(email);
    sessions[key] = enrolled.c;
    secrets[key] = enrolled.secret;
  }

  const call = (
    who: keyof typeof ids | undefined,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: object | Buffer,
    headers: Record<string, string> = {},
  ) => {
    const c = who && sessions[who];
    return app.inject({
      method,
      url,
      headers: {
        ...(c?.cookie
          ? { cookie: `${SESSION_COOKIE}=${c.cookie}`, "x-csrf-token": c.csrf ?? "" }
          : {}),
        ...headers,
      },
      ...(payload ? { payload } : {}),
    });
  };
  const q = async <T extends object>(text: string, params: unknown[] = []) =>
    (await owner.query<T>(text, params)).rows;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject("adminUrl"), inject("templateDb"));
    owner = new pg.Client({ connectionString: testDb.adminUrl });
    await owner.connect();
    await owner.query(
      `INSERT INTO kunde (id, name, lizenz_gueltig_bis) VALUES
        ($1, 'Verein A', '2099-12-31'), ($2, 'Verein B', '2099-12-31'), ($3, 'Anbieter', '2099-12-31')`,
      [A, B, P],
    );
    db = new Datenbank(withCredentials(testDb.adminUrl, "stammbuch_app", inject("appPassword")));
    const auth = createPgAuth(db);
    platform = createPostgresPlatform(db, {
      invitationSender: { send: async (m) => void sent.push(m) },
    });
    app = await buildApp(loadConfig({ LOG_LEVEL: "silent", RATE_LIMIT_MAX: "10000" }), false, {
      auth: {
        config,
        ...auth,
        mail: {
          sendSecurityNotice: () => Promise.resolve(),
          sendPasswordReset: () => Promise.resolve(),
        },
        clock: clock.now,
      },
      db,
      platform,
    });
    h = harness(app, clock);
    await addUser("aAdmin", A, "admin@a.test", { kunden: "admin" });
    await addUser("aUser", A, "user@a.test");
    await addUser("bAdmin", B, "admin@b.test", { kunden: "admin" });
    await addUser("chef", P, "chef@anbieter.test", { rolle: "chief_admin" });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
    await owner.end();
    await testDb.drop();
  });

  describe("Principal-Resolver", () => {
    it("ohne Sitzung: 401", async () => {
      expect((await call(undefined, "GET", "/settings/users")).statusCode).toBe(401);
      expect((await call(undefined, "GET", "/admin/customers")).statusCode).toBe(401);
    });

    it("Kundenrolle admin/user kommt aus der Datenbank und wirkt bei jeder Anfrage", async () => {
      expect((await call("aAdmin", "GET", "/settings/users")).statusCode).toBe(200);
      expect((await call("aUser", "GET", "/settings/users")).statusCode).toBe(403);
      expect((await call("aUser", "GET", "/settings/organisation")).statusCode).toBe(200);
      // Herabgestuft in der Datenbank: gilt sofort, die Sitzung bleibt gültig.
      await owner.query("UPDATE benutzer SET kunden_rolle = 'user' WHERE id = $1", [ids.aAdmin]);
      expect((await call("aAdmin", "GET", "/settings/users")).statusCode).toBe(403);
      await owner.query("UPDATE benutzer SET kunden_rolle = 'admin' WHERE id = $1", [ids.aAdmin]);
      expect((await call("aAdmin", "GET", "/settings/users")).statusCode).toBe(200);
    });

    it("der Chef-Admin ist nie Kundenbenutzer, der Kundenbenutzer nie Chef-Admin", async () => {
      expect((await call("chef", "GET", "/settings/organisation")).statusCode).toBe(403);
      expect((await call("chef", "GET", "/settings/users")).statusCode).toBe(403);
      expect((await call("aAdmin", "GET", "/admin/customers")).statusCode).toBe(403);
      expect((await call("aAdmin", "GET", "/admin/account")).statusCode).toBe(403);
    });

    it("Chef-Admin, dem die Rolle entzogen wurde, verliert den Zugriff sofort", async () => {
      await owner.query("UPDATE benutzer SET rolle = 'user' WHERE id = $1", [ids.chef]);
      // Die Sitzung trägt die Rolle der Datenbank: aus dem Chef-Admin wird ein Benutzer des Anbieter-Kunden.
      expect((await call("chef", "GET", "/admin/customers")).statusCode).toBe(403);
      await owner.query("UPDATE benutzer SET rolle = 'chief_admin' WHERE id = $1", [ids.chef]);
      expect((await call("chef", "GET", "/admin/customers")).statusCode).toBe(200);
    });
  });

  describe("Benutzer eines Kunden", () => {
    let invitedId: string;

    it("Admin lädt ein: Benutzer ist eingeladen und inaktiv, Einladung gespeichert, Token geht nur an den Versand", async () => {
      const res = await call("aAdmin", "POST", "/settings/users", {
        email: "Neu@A.test",
        name: "Neu",
        role: "user",
      });
      expect(res.statusCode).toBe(201);
      invitedId = res.json().id;
      expect(res.json()).toMatchObject({ email: "neu@a.test", role: "user", status: "invited" });
      expect(JSON.stringify(res.json())).not.toContain("token");
      const [row] = await q<{ aktiv: boolean; status: string }>(
        "SELECT aktiv, status FROM benutzer WHERE id = $1",
        [invitedId],
      );
      expect(row).toEqual({ aktiv: false, status: "invited" });
      const message = sent.at(-1)!;
      expect(message.to).toBe("neu@a.test");
      const [inv] = await q<{ token_hash: Buffer; benutzer_id: string; rolle: string }>(
        "SELECT token_hash, benutzer_id, rolle FROM einladung WHERE kunde_id = $1 AND email = 'neu@a.test'",
        [A],
      );
      expect(inv!.token_hash.toString("hex")).toBe(hashToken(message.token));
      expect(inv).toMatchObject({ benutzer_id: invitedId, rolle: "user" });
    });

    it("Eingeladene können sich nicht anmelden", async () => {
      const l = await h.login("neu@a.test");
      expect(l.res.statusCode).toBe(401);
    });

    it("gleiche E-Mail (auch bei einem anderen Kunden) ergibt dieselbe 409-Antwort", async () => {
      const same = await call("aAdmin", "POST", "/settings/users", {
        email: "neu@a.test",
        name: "X",
        role: "user",
      });
      const other = await call("aAdmin", "POST", "/settings/users", {
        email: "admin@b.test",
        name: "X",
        role: "user",
      });
      expect([same.statusCode, other.statusCode]).toEqual([409, 409]);
      expect(same.json()).toEqual(other.json());
    });

    it("die Liste zeigt nur den eigenen Kunden (nach Name), nie den Chef-Admin", async () => {
      const list = (await call("aAdmin", "GET", "/settings/users")).json().items as {
        email: string;
      }[];
      expect(list.map((u) => u.email)).toEqual(["admin@a.test", "user@a.test", "neu@a.test"]);
    });

    it("die Liste zeigt letzte Anmeldung und Stand des zweiten Faktors aus der Datenbank (#114)", async () => {
      const list = (await call("aAdmin", "GET", "/settings/users")).json().items as {
        email: string;
        lastLoginAt: string | null;
        totpEnrolled: boolean;
      }[];
      const by = (email: string) => list.find((u) => u.email === email)!;
      // Angemeldete Benutzer haben den zweiten Faktor eingerichtet und sich zuletzt eben angemeldet.
      expect(by("admin@a.test").totpEnrolled).toBe(true);
      expect(Date.now() - Date.parse(by("admin@a.test").lastLoginAt!)).toBeLessThan(5 * 60_000);
      // Eingeladen: weder Anmeldung noch Faktor, nichts erfunden.
      expect(by("neu@a.test")).toMatchObject({ lastLoginAt: null, totpEnrolled: false });
    });

    it("fremde Benutzer sind unsichtbar: Rolle ändern und Entfernen ergeben 404", async () => {
      expect(
        (await call("bAdmin", "PATCH", `/settings/users/${invitedId}`, { role: "admin" }))
          .statusCode,
      ).toBe(404);
      expect((await call("bAdmin", "DELETE", `/settings/users/${invitedId}`)).statusCode).toBe(404);
      expect(
        (await call("aAdmin", "PATCH", `/settings/users/${ids.bAdmin}`, { role: "user" }))
          .statusCode,
      ).toBe(404);
      const [row] = await q("SELECT kunden_rolle FROM benutzer WHERE id = $1", [ids.bAdmin]);
      expect(row).toEqual({ kunden_rolle: "admin" });
    });

    it("der letzte aktive Admin bleibt Admin; ein eingeladener Admin zählt nicht", async () => {
      expect(
        (await call("aAdmin", "PATCH", `/settings/users/${invitedId}`, { role: "admin" }))
          .statusCode,
      ).toBe(200);
      const self = await call("aAdmin", "PATCH", `/settings/users/${ids.aAdmin}`, { role: "user" });
      expect(self.statusCode).toBe(409);
      expect(
        (await call("aAdmin", "PATCH", `/settings/users/${invitedId}`, { role: "user" }))
          .statusCode,
      ).toBe(200);
    });

    it("Entfernen löscht den Benutzer, das Protokoll bleibt lesbar", async () => {
      expect((await call("aAdmin", "DELETE", `/settings/users/${invitedId}`)).statusCode).toBe(204);
      expect(await q("SELECT 1 FROM benutzer WHERE id = $1", [invitedId])).toEqual([]);
      const items = (await call("aAdmin", "GET", "/settings/audit?action=user.add")).json()
        .items as {
        actor: string;
        target: string;
      }[];
      expect(items).toEqual([
        expect.objectContaining({ actor: "admin@a.test", target: "neu@a.test" }),
      ]);
    });

    it("ein Benutzer mit angelegten Daten bleibt erhalten (409 statt 500)", async () => {
      await owner.query(
        `INSERT INTO kalender_event (kunde_id, titel, beginnt_am, endet_am, erstellt_von)
         VALUES ($1, 'Fest', now() + interval '1 day', now() + interval '2 days', $2)`,
        [A, ids.aUser],
      );
      expect((await call("aAdmin", "DELETE", `/settings/users/${ids.aUser}`)).statusCode).toBe(409);
      expect(await q("SELECT 1 FROM benutzer WHERE id = $1", [ids.aUser])).toHaveLength(1);
    });
  });

  describe("Organisation, Logo, Protokoll", () => {
    it("Organisation wird je Kunde gespeichert und gelesen", async () => {
      const master = {
        name: "Verein A neu",
        street: "",
        zip: "",
        city: "Bern",
        country: "CH",
        uid: "",
        vatNumber: "",
        email: "",
        phone: "",
        website: "",
      };
      expect(
        (await call("aAdmin", "PUT", "/settings/organisation/master", master)).statusCode,
      ).toBe(200);
      expect(
        (await call("aAdmin", "PUT", "/settings/organisation/fiscal-year", { startMonth: 7 }))
          .statusCode,
      ).toBe(200);
      const a = (await call("aUser", "GET", "/settings/organisation")).json();
      expect(a.master).toMatchObject({ name: "Verein A neu", city: "Bern" });
      expect(a["fiscal-year"]).toEqual({ startMonth: 7, closing: "monthly" });
      // Kunde B sieht seine Startwerte, nichts von A.
      const b = (await call("bAdmin", "GET", "/settings/organisation")).json();
      expect(b.master.name).toBe("Verein B");
      expect(b["fiscal-year"]).toEqual({ startMonth: 1, closing: "monthly" });
      expect((await call("aUser", "PUT", "/settings/organisation/master", master)).statusCode).toBe(
        403,
      );
    });

    it("Rechtsform, Periodenabschluss und Konto «Gutschriften auf» (#130): je Mandant, Konto aus dem eigenen Kontenplan", async () => {
      const put = (who: "aAdmin" | "bAdmin", section: string, payload: object) =>
        call(who, "PUT", `/settings/organisation/${section}`, payload);
      const bank = { bankName: "Bank", iban: "", qrIban: "", bic: "" };
      // Kontenplan von A anlegen (Standardplan) und ein eigenes Konto in B, das A nicht hat.
      await owner.query(
        `INSERT INTO buchhaltung_konto (kunde_id, nummer, name, art, aktiv)
         VALUES ($1, '1021', 'Bank Reserve', 'asset', true), ($1, '1022', 'Altes Konto', 'asset', false),
                ($2, '1099', 'Nur Verein B', 'asset', true)`,
        [A, B],
      );
      expect((await put("aAdmin", "bank", { ...bank, creditAccount: "1021" })).statusCode).toBe(
        200,
      );
      // Inaktiv, unbekannt, kein Bestandskonto, fremd (gehört nur B): abgewiesen.
      for (const creditAccount of ["1022", "9999", "3000", "1099"]) {
        expect(
          (await put("aAdmin", "bank", { ...bank, creditAccount })).statusCode,
          creditAccount,
        ).toBe(422);
      }
      expect((await put("bAdmin", "bank", { ...bank, creditAccount: "1099" })).statusCode).toBe(
        200,
      );
      // Umgekehrt: das Konto von A ist für B unbekannt.
      expect((await put("bAdmin", "bank", { ...bank, creditAccount: "1021" })).statusCode).toBe(
        422,
      );
      expect((await put("aAdmin", "master", { name: "A", legalForm: "verein" })).statusCode).toBe(
        200,
      );
      expect(
        (await put("aAdmin", "fiscal-year", { startMonth: 4, closing: "yearly" })).statusCode,
      ).toBe(200);
      const a = (await call("aAdmin", "GET", "/settings/organisation")).json();
      expect(a.bank.creditAccount).toBe("1021");
      expect(a.master.legalForm).toBe("verein");
      expect(a["fiscal-year"]).toEqual({ startMonth: 4, closing: "yearly" });
      const b = (await call("bAdmin", "GET", "/settings/organisation")).json();
      expect(b.master.legalForm).toBe("");
    });

    it("Protokoll: Fehlversuch steht mit Ergebnis «failure» im Protokoll, Erfolg bleibt «success» (#130)", async () => {
      await h.login("admin@a.test", "falsches-Passwort-123");
      const page = (await call("aAdmin", "GET", "/settings/audit?limit=200")).json() as {
        items: { action: string; result: string }[];
      };
      const failure = page.items.filter((e) => e.result === "failure");
      expect(failure.map((e) => e.action)).toContain("login_failure");
      expect(page.items.find((e) => e.action === "organisation.update")?.result).toBe("success");
      const rows = await q<{ aktion: string; ergebnis: string }>(
        "SELECT aktion, ergebnis FROM audit_log WHERE kunde_id = $1 AND ergebnis = 'fehler'",
        [A],
      );
      expect(rows.map((r) => r.aktion)).toContain("login_failure");
      const csv = await call("aAdmin", "GET", "/settings/audit/export?action=login_failure");
      expect(csv.body).toContain(";Ergebnis");
      expect(csv.body).toContain(";Fehlgeschlagen");
      // Die Anwendungsrolle kann das Ergebnis nachträglich nicht ändern.
      await expect(
        db.kysely
          .updateTable("audit_log")
          .set({ ergebnis: "erfolg" })
          .where("kunde_id", "=", A)
          .execute(),
      ).rejects.toThrow();
    });

    it("Logo: speichern, lesen, ersetzen, löschen", async () => {
      const png = makePng(100, 50);
      const put = await call("aAdmin", "PUT", "/settings/organisation/logo", png, {
        "content-type": "image/png",
      });
      expect(put.statusCode).toBe(204);
      const got = await call("aUser", "GET", "/settings/organisation/logo");
      expect(got.headers["content-type"]).toContain("image/png");
      expect(got.rawPayload.equals(png)).toBe(true);
      expect((await call("aUser", "GET", "/settings/organisation")).json().logo).toMatchObject({
        mime: "image/png",
        size: png.length,
      });
      expect((await call("bAdmin", "GET", "/settings/organisation/logo")).statusCode).toBe(404);
      const bigger = makePng(200, 200);
      await call("aAdmin", "PUT", "/settings/organisation/logo", bigger, {
        "content-type": "image/png",
      });
      expect(
        (await call("aUser", "GET", "/settings/organisation/logo")).rawPayload.equals(bigger),
      ).toBe(true);
      expect((await call("aAdmin", "DELETE", "/settings/organisation/logo")).statusCode).toBe(204);
      expect((await call("aAdmin", "DELETE", "/settings/organisation/logo")).statusCode).toBe(404);
    });

    it("Protokoll: neueste zuerst, filterbar, nur der eigene Kunde, ohne Feldwerte", async () => {
      const all = (await call("aAdmin", "GET", "/settings/audit?limit=200")).json() as {
        items: { id: string; at: string; actor: string; action: string; target: string }[];
        total: number;
      };
      expect(all.total).toBe(all.items.length);
      const times = all.items.map((e) => e.at);
      expect(times).toEqual([...times].sort().reverse());
      expect(
        all.items.some((e) => e.action === "organisation.update" && e.target === "master"),
      ).toBe(true);
      expect(JSON.stringify(all)).not.toContain("Verein A neu");
      const b = (await call("bAdmin", "GET", "/settings/audit")).json().items as {
        actor: string;
      }[];
      expect(b.every((e) => !e.actor.endsWith("@a.test"))).toBe(true);
      const page = (await call("aAdmin", "GET", "/settings/audit?limit=1&offset=1")).json();
      expect(page.items).toHaveLength(1);
      expect(page.total).toBe(all.total);
      const suche = (
        await call("aAdmin", "GET", `/settings/audit?q=${encodeURIComponent("%")}`)
      ).json();
      expect(suche.total).toBe(0);
      const csv = await call("aAdmin", "GET", "/settings/audit/export");
      expect(csv.statusCode).toBe(200);
      expect(csv.body).toContain("organisation.update");
    });
  });

  describe("Chef-Admin und Lizenz", () => {
    let customerId: string;

    it("legt einen Kunden an, listet, sucht und paginiert über alle Kunden", async () => {
      const res = await call("chef", "POST", "/admin/customers", {
        name: "Neuer Verein_%",
        contactEmail: "Kontakt@Neu.test",
        licenceValidUntil: "2099-01-01",
      });
      expect(res.statusCode).toBe(201);
      customerId = res.json().id;
      expect(res.json()).toMatchObject({
        slug: "neuer-verein",
        status: "active",
        licenceValidUntil: "2099-01-01",
        invitation: { email: "kontakt@neu.test", status: "pending" },
      });
      expect(sent.at(-1)).toMatchObject({ to: "kontakt@neu.test", tenantName: "Neuer Verein_%" });
      const list = (await call("chef", "GET", "/admin/customers?limit=2")).json();
      expect(list.total).toBe(4);
      expect(list.items).toHaveLength(2);
      const treffer = (
        await call("chef", "GET", `/admin/customers?q=${encodeURIComponent("_%")}`)
      ).json();
      expect(treffer.items.map((c: { name: string }) => c.name)).toEqual(["Neuer Verein_%"]);
      // Wildcards aus der Eingabe sind wörtlich.
      expect((await call("chef", "GET", "/admin/customers?q=%25")).json().total).toBe(1);
      expect((await call("chef", "GET", "/admin/customers?q=zzz")).json()).toEqual({
        items: [],
        total: 0,
      });
      expect((await call("chef", "GET", "/admin/customers?limit=2&offset=100")).json()).toEqual({
        items: [],
        total: 4,
      });
    });

    it("die Einladung des neuen Kunden lässt sich genau einmal einlösen", async () => {
      const { token } = sent.at(-1)!;
      const now = new Date();
      expect(await platform.invitations.consume(hashToken(token), now)).toMatchObject({
        tenantId: customerId,
        email: "kontakt@neu.test",
        role: "admin",
        userId: null,
      });
      expect(await platform.invitations.consume(hashToken(token), now)).toBeUndefined();
      expect(await platform.invitations.consume(hashToken("falsch"), now)).toBeUndefined();
      expect(await platform.invitations.consume("kein-hex", now)).toBeUndefined();
      const after = (await call("chef", "GET", `/admin/customers/${customerId}`)).json();
      expect(after.invitation.status).toBe("accepted");
    });

    it("Sperren wirkt sofort auf Kundenbenutzer, Aufheben ebenfalls", async () => {
      expect((await call("chef", "POST", `/admin/customers/${A}/suspend`)).json().status).toBe(
        "suspended",
      );
      expect((await call("aAdmin", "GET", "/settings/users")).statusCode).toBe(403);
      expect((await call("aAdmin", "GET", "/settings/licence")).json()).toMatchObject({
        state: "suspended",
        blocked: true,
      });
      expect((await call("bAdmin", "GET", "/settings/users")).statusCode).toBe(200);
      expect((await call("chef", "POST", `/admin/customers/${A}/reactivate`)).statusCode).toBe(200);
      expect((await call("aAdmin", "GET", "/settings/users")).statusCode).toBe(200);
    });

    it("abgelaufene Lizenz und Vertragsende sind Nur-Lesen; Lizenz verlängern öffnet wieder", async () => {
      expect(
        (await call("chef", "PATCH", `/admin/customers/${B}`, { licenceValidUntil: "2020-01-01" }))
          .statusCode,
      ).toBe(200);
      expect((await call("bAdmin", "GET", "/settings/users")).statusCode).toBe(200);
      const w = await call("bAdmin", "PUT", "/settings/organisation/fiscal-year", {
        startMonth: 2,
      });
      expect([w.statusCode, w.json().error.code]).toEqual([403, "LICENCE_READ_ONLY"]);
      await call("chef", "PATCH", `/admin/customers/${B}`, {
        licenceValidUntil: "2099-12-31",
        name: "Verein B AG",
      });
      expect(
        (await call("bAdmin", "PUT", "/settings/organisation/fiscal-year", { startMonth: 2 }))
          .statusCode,
      ).toBe(200);

      const ended = (await call("chef", "POST", `/admin/customers/${B}/end-contract`)).json();
      expect(ended).toMatchObject({ status: "ended", name: "Verein B AG" });
      expect(ended.endedAt).toEqual(expect.any(String));
      expect((await call("bAdmin", "GET", "/settings/licence")).json()).toMatchObject({
        state: "ended",
        readOnly: true,
      });
      expect(
        (await call("bAdmin", "PUT", "/settings/organisation/fiscal-year", { startMonth: 3 }))
          .statusCode,
      ).toBe(403);
      // Beendet bleibt beendet.
      expect((await call("chef", "POST", `/admin/customers/${B}/reactivate`)).statusCode).toBe(409);
    });

    it("die Anwendungsrolle kann Status und Lizenz nicht selbst ändern (auch nicht über die Platform)", async () => {
      await expect(
        platform.tenants.update(ids.aAdmin, A, { status: "suspended" }),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        platform.tenants.create(ids.aUser, {
          id: randomUUID(),
          name: "X",
          slug: "x",
          status: "active",
          licenceValidUntil: "2099-01-01",
          createdAt: new Date().toISOString(),
          endedAt: null,
        }),
      ).rejects.toMatchObject({ code: "42501" });
      expect((await platform.tenants.list(ids.aAdmin, {}, { limit: 10, offset: 0 })).items).toEqual(
        [],
      );
      expect((await q("SELECT status FROM kunde WHERE id = $1", [A]))[0]).toEqual({
        status: "active",
      });
    });

    it("Plattformprotokoll: Vorgänge des Chef-Admins, nur für ihn lesbar", async () => {
      const log = (await call("chef", "GET", "/admin/audit")).json() as {
        items: { actor: string; action: string; target: string }[];
        total: number;
      };
      expect(log.items.map((e) => e.action)).toEqual([
        "customer.end-contract",
        "customer.update",
        "customer.update",
        "customer.reactivate",
        "customer.suspend",
        "customer.create",
      ]);
      expect(log.items[0]).toMatchObject({ actor: "chef@anbieter.test", target: "Verein B AG" });
      const filtered = (await call("chef", "GET", "/admin/audit?action=customer.suspend")).json();
      expect(filtered.total).toBe(1);
      expect((await call("aAdmin", "GET", "/admin/audit")).statusCode).toBe(403);
      // Kundenprotokolle enthalten nichts davon.
      const kunde = (await call("aAdmin", "GET", "/settings/audit?limit=200")).json().items as {
        action: string;
      }[];
      expect(kunde.some((e) => e.action.startsWith("customer."))).toBe(false);
      await expect(
        platform.platformAudit.append("platform", {
          id: randomUUID(),
          at: new Date().toISOString(),
          actorId: ids.aAdmin,
          actor: "x",
          action: "customer.create",
          target: "",
        }),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("eigenes Konto des Chef-Admins lesen und ändern", async () => {
      expect((await call("chef", "GET", "/admin/account")).json()).toEqual({
        id: ids.chef,
        email: "chef@anbieter.test",
        displayName: "chef",
      });
      expect(
        (await call("chef", "PATCH", "/admin/account", { displayName: "Chef Anbieter" })).json()
          .displayName,
      ).toBe("Chef Anbieter");
      expect((await q("SELECT name FROM benutzer WHERE id = $1", [ids.chef]))[0]).toEqual({
        name: "Chef Anbieter",
      });
    });

    it("Slug: Kollisionen ohne Rennbedingung, Überschreiben, Ändern, Rechte, erreichbar über die öffentliche Kennung", async () => {
      const neu = (name: string, extra: object = {}) =>
        call("chef", "POST", "/admin/customers", {
          name,
          contactEmail: "k@slug.test",
          licenceValidUntil: "2099-01-01",
          ...extra,
        });
      // Gleichzeitig angelegt, gleicher Name: der UNIQUE-Constraint verteilt -2 bis -6.
      const rennen = await Promise.all(Array.from({ length: 5 }, () => neu("Neuer Verein")));
      expect(rennen.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
      expect(rennen.map((r) => r.json().slug as string).sort()).toEqual([
        "neuer-verein-2",
        "neuer-verein-3",
        "neuer-verein-4",
        "neuer-verein-5",
        "neuer-verein-6",
      ]);
      const own = await neu("Egal", { slug: "mein-slug" });
      expect(own.json().slug).toBe("mein-slug");
      expect((await neu("Egal 2", { slug: "mein-slug" })).statusCode).toBe(409);
      expect((await neu("Egal 3", { slug: "Ungültig!" })).statusCode).toBe(400);

      const id = own.json().id as string;
      expect((await call("chef", "PATCH", `/admin/customers/${id}`, { slug: "neuer-verein" })).statusCode).toBe(409);
      const geaendert = await call("chef", "PATCH", `/admin/customers/${id}`, { slug: "anderer-slug" });
      expect(geaendert.json().slug).toBe("anderer-slug");

      // Die öffentliche Auflösung (Selbstregistrierung) findet den neuen Kunden sofort.
      const resolve = createTenantResolver(db);
      expect(await resolve("anderer-slug")).toBe(id);
      expect(await resolve("mein-slug")).toBeUndefined();

      // Altkunden ohne Slug bleiben unverändert.
      const liste = (await call("chef", "GET", "/admin/customers?q=Verein%20A")).json();
      expect(liste.items[0]).toMatchObject({ id: A, slug: null });

      // Kundenadmin und Anwendungsrolle: verweigert.
      expect((await call("aAdmin", "PATCH", `/admin/customers/${id}`, { slug: "gekapert" })).statusCode).toBe(403);
      await expect(platform.tenants.update(ids.aAdmin, id, { slug: "gekapert" })).rejects.toMatchObject({ code: "42501" });
      await expect(
        db.withKunde(A, (t) => t.updateTable("kunde").set({ slug: "gekapert" }).execute()),
      ).rejects.toMatchObject({ code: "42501" });
      expect((await q("SELECT slug FROM kunde WHERE id = $1", [id]))[0]).toEqual({ slug: "anderer-slug" });
    }); // prettier-ignore
  });
  describe("Einladung einlösen: vom Chef-Admin angelegter Kunde", () => {
    const NEW_PASSWORD = "ein-neues-langes-passwort-42";

    it("der eingeladene Admin richtet Passwort und zweiten Faktor ein, meldet sich an und arbeitet nur in seinem Kunden", async () => {
      const created = await call("chef", "POST", "/admin/customers", {
        name: "Verein Einladung",
        contactEmail: "Gruender@Einladung.test",
        licenceValidUntil: "2099-12-31",
      });
      expect(created.statusCode).toBe(201);
      const customerId = created.json().id as string;
      const { token } = sent.at(-1)!;
      // Das Token erreicht den Chef-Admin nie; er könnte die Einladung sonst selbst einlösen.
      expect(JSON.stringify(created.json())).not.toContain(token);

      const redeemed = await h.req("POST", "/auth/invitations/redeem", undefined, {
        token,
        password: NEW_PASSWORD,
      });
      expect(redeemed.statusCode).toBe(200);
      expect(redeemed.json().status).toBe("mfa_setup_required");
      const pending = { cookie: h.cookieOf(redeemed)!.value, csrf: redeemed.json().csrfToken };
      const as = (c: Cookies) => ({
        cookie: `${SESSION_COOKIE}=${c.cookie}`,
        "x-csrf-token": c.csrf!,
      });

      // Vor dem zweiten Faktor kein Zugriff, auch nicht mit der Zwischen-Sitzung.
      expect(
        (await app.inject({ method: "GET", url: "/settings/users", headers: as(pending) }))
          .statusCode,
      ).toBe(401);
      const setup = await h.req("POST", "/auth/2fa/setup", pending);
      const secret = base32Decode(setup.json().secret);
      const done = await h.req("POST", "/auth/2fa", pending, { code: h.codeAt(secret) });
      expect(done.statusCode).toBe(200);
      const full = { cookie: h.cookieOf(done)!.value, csrf: done.json().csrfToken as string };

      const users = await app.inject({ method: "GET", url: "/settings/users", headers: as(full) });
      expect(users.statusCode).toBe(200);
      expect(users.json().items).toEqual([
        expect.objectContaining({
          email: "gruender@einladung.test",
          role: "admin",
          status: "active",
        }),
      ]);
      // Nie in einem anderen Kunden oder als Anbieter.
      expect(
        (await app.inject({ method: "GET", url: "/admin/customers", headers: as(full) }))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await q("SELECT kunde_id, rolle FROM benutzer WHERE email = 'gruender@einladung.test'")
        )[0],
      ).toEqual({ kunde_id: customerId, rolle: "user" });
      expect(
        (await q("SELECT 1 FROM benutzer WHERE kunde_id <> $1 AND email = 'gruender@einladung.test'", [customerId])),
      ).toHaveLength(0); // prettier-ignore

      // Der Chef-Admin sieht nur den Status der Einladung.
      expect(
        (await call("chef", "GET", `/admin/customers/${customerId}`)).json().invitation,
      ).toEqual({
        email: "gruender@einladung.test",
        status: "accepted",
      });

      // Zweites Einlösen: neutral. Abmelden und normal anmelden: Passwort und Code.
      const again = await h.req("POST", "/auth/invitations/redeem", undefined, {
        token,
        password: NEW_PASSWORD,
      });
      expect(again.statusCode).toBe(400);
      expect(again.json().error.code).toBe("INVALID_INVITATION");
      await h.req("POST", "/auth/logout", full);
      clock.advance(30_000);
      const l = await h.login("gruender@einladung.test", NEW_PASSWORD);
      expect(l.body.status).toBe("mfa_required");
      const code = await h.req("POST", "/auth/2fa", l.c, { code: h.codeAt(secret) });
      expect(code.statusCode).toBe(200);
      const back = { cookie: h.cookieOf(code)!.value, csrf: code.json().csrfToken as string };
      expect(
        (await app.inject({ method: "GET", url: "/settings/users", headers: as(back) })).statusCode,
      ).toBe(200);
    });
  });

  describe("Chef-Admin-Schnittstellen (Issue #115)", () => {
    const aCount = async () =>
      Number(
        (
          await q<{ n: string }>(
            "SELECT count(*) AS n FROM benutzer WHERE kunde_id = $1 AND rolle = 'user' AND aktiv",
            [A],
          )
        )[0]!.n,
      );

    it("legt einen Kunden mit Lizenzbeginn und Modulen an; Detail und Liste zeigen Nummer, Beginn, Module", async () => {
      const res = await call("chef", "POST", "/admin/customers", {
        name: "Lizenz AG",
        contactEmail: "kontakt@lizenz.test",
        licenceValidUntil: "2099-06-30",
        licenceStart: "2026-07-01",
        modules: ["mail", "kalender"],
      });
      expect(res.statusCode).toBe(201);
      const created = res.json();
      expect(created).toMatchObject({
        licenceStart: "2026-07-01",
        modules: ["mail", "kalender"],
        userCount: 0,
      });
      expect(created.licenceNumber).toMatch(/^L-\d{4}$/);
      const detail = (await call("chef", "GET", `/admin/customers/${created.id}`)).json();
      expect(detail).toMatchObject({
        licenceNumber: created.licenceNumber,
        licenceStart: "2026-07-01",
        modules: ["mail", "kalender"],
      });
      const list = (await call("chef", "GET", "/admin/customers?q=lizenz%20ag")).json();
      expect(list.items[0]).toMatchObject({ id: created.id, licenceNumber: created.licenceNumber });
      // Änderungen am Vertrag lassen Nummer, Beginn und Module stehen.
      const patched = (
        await call("chef", "PATCH", `/admin/customers/${created.id}`, {
          licenceValidUntil: "2099-12-31",
        })
      ).json();
      expect(patched).toMatchObject({
        licenceNumber: created.licenceNumber,
        licenceStart: "2026-07-01",
        modules: ["mail", "kalender"],
      });
    });

    it("zählt aktive Benutzer als Zahl und liefert Altkunden ohne Lizenzdaten leer", async () => {
      const detail = (await call("chef", "GET", `/admin/customers/${A}`)).json();
      expect(detail.userCount).toBe(await aCount());
      expect(detail.userCount).toBeGreaterThanOrEqual(2);
      // Von Hand angelegt (wie ein Altkunde): Nummer vergibt die Datenbank, Beginn und Module fehlen.
      expect(detail.licenceNumber).toMatch(/^L-\d{4}$/);
      expect(detail).toMatchObject({ licenceStart: null, modules: null });
      const list = (await call("chef", "GET", "/admin/customers?limit=200")).json();
      const inList = list.items.find((c: { id: string }) => c.id === A);
      expect(inList).toMatchObject({
        userCount: detail.userCount,
        licenceNumber: detail.licenceNumber,
      });
      const numbers = list.items.map((c: { licenceNumber: string }) => c.licenceNumber);
      expect(new Set(numbers).size).toBe(numbers.length);
    });

    it("die Benutzerliste eines Kunden zeigt fünf Felder, nur diesen Kunden, nur für den Chef-Admin", async () => {
      const res = await call("chef", "GET", `/admin/customers/${A}/users`);
      expect(res.statusCode).toBe(200);
      const items = res.json().items as {
        email: string;
        totp: string;
        lastLogin: string | null;
      }[];
      expect(items.map((u) => u.email).sort()).toEqual(["admin@a.test", "user@a.test"]);
      for (const u of items) {
        expect(Object.keys(u).sort()).toEqual(["email", "id", "lastLogin", "name", "totp"]);
        // Beide haben den zweiten Faktor eingerichtet und sich damit angemeldet.
        expect(u.totp).toBe("set");
        expect(u.lastLogin).not.toBeNull();
      }
      expect(res.body).not.toContain("admin@b.test");
      expect(res.body).not.toMatch(/hash|secret|recovery/i);
      const b = (await call("chef", "GET", `/admin/customers/${B}/users`)).json();
      expect(b.items.map((u: { email: string }) => u.email)).toEqual(["admin@b.test"]);
      for (const who of ["aAdmin", "aUser", "bAdmin"] as const) {
        expect((await call(who, "GET", `/admin/customers/${A}/users`)).statusCode, who).toBe(403);
      }
      expect((await call(undefined, "GET", `/admin/customers/${A}/users`)).statusCode).toBe(401);
    });

    it("2FA-Reset: Eintrag im Anbieter-Protokoll, Stand wechselt auf «missing», Sitzungen des Benutzers enden", async () => {
      await owner.query(
        "INSERT INTO benutzer (kunde_id, email, name, passwort_hash) VALUES ($1, 'reset@a.test', 'Reset Person', $2)",
        [A, await hasher.hash(PASSWORD)],
      );
      const enrolled = await h.enroll("reset@a.test");
      const targetId = (
        await q<{ id: string }>("SELECT id FROM benutzer WHERE email = 'reset@a.test'")
      )[0]!.id;
      const shown = async () =>
        (
          (await call("chef", "GET", `/admin/customers/${A}/users`)).json().items as {
            email: string;
            totp: string;
          }[]
        ).find((u) => u.email === "reset@a.test");
      expect(await shown()).toMatchObject({ totp: "set" });

      clock.advance(120_000);
      const reset = await call("chef", "POST", `/auth/admin/users/${targetId}/2fa-reset`, {
        code: h.codeAt(secrets.chef),
        reason: "Handy verloren",
        calledBack: true,
      });
      expect(reset.statusCode).toBe(204);
      expect(await shown()).toMatchObject({ totp: "missing" });
      expect((await h.req("GET", "/auth/me", enrolled.c)).statusCode).toBe(401);

      const log = (await call("chef", "GET", "/admin/audit?action=customer.user-2fa-reset")).json();
      expect(log.items).toHaveLength(1);
      expect(log.items[0]).toMatchObject({
        actor: "chef@anbieter.test",
        target: "Verein A: Reset Person – Grund: Handy verloren – Rückruf bestätigt",
      });
      // Das Kundenprotokoll von A kennt den Grund nicht.
      const customerLog = JSON.stringify(
        (await call("aAdmin", "GET", "/settings/audit?limit=100")).json(),
      );
      expect(customerLog).not.toContain("Handy verloren");

      // Falscher Code: nichts passiert, nichts im Anbieter-Protokoll.
      clock.advance(120_000);
      const bad = await call("chef", "POST", `/auth/admin/users/${ids.aUser}/2fa-reset`, {
        code: "000000",
        reason: "x",
        calledBack: true,
      });
      expect(bad.statusCode).toBe(401);
      expect(
        (await call("chef", "GET", "/admin/audit?action=customer.user-2fa-reset")).json().items,
      ).toHaveLength(1);
    });

    it("Sicherheit des eigenen Kontos: Zeitpunkte, Codes, Sitzungen, Anmeldungen; andere Sitzung beenden", async () => {
      await h.login("chef@anbieter.test", "falsches-passwort-xyz");
      const second = await h.fullLogin("chef@anbieter.test", secrets.chef);

      const sec = (await call("chef", "GET", "/admin/account/security")).json();
      expect(sec.totpSetUpAt).toEqual(expect.any(String));
      expect(sec.recoveryCodes).toEqual({ unused: 10, total: 10 });
      expect(sec.passwordChangedAt).toBeNull();
      expect(sec.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
      expect(sec.sessions.length).toBeGreaterThanOrEqual(2);
      expect(sec.logins.map((l: { method: string }) => l.method)).toEqual(
        expect.arrayContaining(["setup", "totp", "password_failed"]),
      );
      expect(JSON.stringify(sec)).not.toMatch(/secret|hash|token/i);

      const current = sec.sessions.find((s: { current: boolean }) => s.current);
      const others = sec.sessions.filter((s: { current: boolean }) => !s.current);
      expect(
        (await call("chef", "POST", `/admin/account/sessions/${current.id}/end`)).statusCode,
      ).toBe(404);
      expect((await call("chef", "GET", "/admin/account/security")).statusCode).toBe(200);
      // Fremde Sitzung (eines Kundenbenutzers) lässt sich nicht beenden.
      const [foreign] = await q<{ id: string }>(
        "SELECT id FROM sitzung WHERE benutzer_id = $1 LIMIT 1",
        [ids.bAdmin],
      );
      expect(
        (await call("chef", "POST", `/admin/account/sessions/${foreign!.id}/end`)).statusCode,
      ).toBe(404);
      expect((await h.req("GET", "/auth/me", sessions.bAdmin)).statusCode).toBe(200);

      // Eine andere eigene Sitzung beenden: die zweite Anmeldung ist danach tot.
      for (const s of others) {
        expect((await call("chef", "POST", `/admin/account/sessions/${s.id}/end`)).statusCode).toBe(
          204,
        );
      }
      expect((await h.req("GET", "/auth/me", second.c)).statusCode).toBe(401);
      expect((await call("chef", "GET", "/admin/account/security")).json().sessions).toHaveLength(
        1,
      );
      // Kundenbenutzer haben diese Routen nicht.
      expect((await call("aAdmin", "GET", "/admin/account/security")).statusCode).toBe(403);
      expect(
        (await call("aAdmin", "POST", `/admin/account/sessions/${current.id}/end`)).statusCode,
      ).toBe(403);
    });
  });

  describe("Schlüsselrotation durch den Chef-Admin (Issues #73, #74)", () => {
    const k = (n: number) => Buffer.alloc(32, n).toString("base64");
    // Ring nach einer Rotation: neuer Schlüssel k2, der Hauptschlüssel entschlüsselt die Altdaten.
    const ring = totpBoxFromEnv({
      AUTH_TOTP_KEY: config.totpKey.toString("base64"),
      AUTH_TOTP_KEYS: `k2:${k(2)}`,
    });
    const stranger = new SecretBox({ keys: { x: k(9) }, currentKeyId: "x" });
    let app2: Awaited<ReturnType<typeof buildApp>>;
    let h2: ReturnType<typeof harness>;
    let lost: string;

    const as2 = (c: Cookies, method: "GET" | "POST", url: string, payload?: object) =>
      app2.inject({
        method,
        url,
        headers: { cookie: `${SESSION_COOKIE}=${c.cookie}`, "x-csrf-token": c.csrf ?? "" },
        ...(payload ? { payload } : {}),
      });
    /**
     * Rotation mit frischem Einmalcode (Step-up): die Uhr läuft einen Zeitschritt weiter, damit der Code neu ist.
     * Nur drei POSTs pro Minute: ohne Code, falscher Code und Replay prüfen die Tests des Admin-Moduls und des Auth-Dienstes.
     */
    const rotate = (c: Cookies) => {
      clock.advance(30_000);
      return as2(c, "POST", "/admin/rotation", { code: h2.codeAt(secrets.chef) });
    };

    beforeAll(async () => {
      lost = randomUUID();
      await owner.query(
        `INSERT INTO benutzer (id, kunde_id, email, name, passwort_hash, totp_secret_enc, totp_letzter_zaehler, totp_eingerichtet_am)
         VALUES ($1, $2, 'verloren@b.test', 'Verloren', 'h', $3, 0, now())`,
        [lost, B, stranger.encryptBytes(Buffer.alloc(20, 1), lost)],
      );
      const platform2 = createPostgresPlatform(db, {
        invitationSender: { send: async (m) => void sent.push(m) },
        rotationBoxes: { totp: ring },
        clock: clock.now,
      });
      app2 = await buildApp(loadConfig({ LOG_LEVEL: "silent", RATE_LIMIT_MAX: "10000" }), false, {
        auth: {
          config: { ...config, totpBox: ring },
          ...createPgAuth(db),
          mail: {
            sendSecurityNotice: () => Promise.resolve(),
            sendPasswordReset: () => Promise.resolve(),
          },
          clock: clock.now,
        },
        db,
        platform: platform2,
      });
      h2 = harness(app2, clock);
    });

    afterAll(async () => {
      await app2?.close();
      await owner.query("DELETE FROM benutzer WHERE id = $1", [lost]);
    });

    it("Kundenbenutzer und Admins dürfen weder auslösen noch den Stand lesen", async () => {
      // Nur ein POST: das Limit der Route (3 pro Minute) zählt auch verweigerte Anfragen.
      expect((await as2(sessions.aAdmin, "POST", "/admin/rotation")).statusCode).toBe(403);
      for (const who of ["aAdmin", "aUser", "bAdmin"] as const) {
        expect((await as2(sessions[who], "GET", "/admin/rotation")).statusCode).toBe(403);
      }
      expect((await app2.inject({ method: "GET", url: "/admin/rotation" })).statusCode).toBe(401);
    });

    it("rotiert die TOTP-Geheimnisse aller Kunden, meldet das unlesbare nur als ID und protokolliert den Chef-Admin", async () => {
      const before = await q<{ n: number }>(
        "SELECT count(*)::int AS n FROM benutzer WHERE totp_secret_enc IS NOT NULL AND id <> $1",
        [lost],
      );
      const chefLogin = await h2.fullLogin("chef@anbieter.test", secrets.chef);
      expect(chefLogin.res.statusCode).toBe(200);

      const status = await as2(chefLogin.c, "GET", "/admin/rotation");
      expect(status.json()).toEqual({
        mail: { configured: false, lastRunAt: null, unreadable: [] },
        totp: { configured: true, lastRunAt: null, unreadable: [] },
      });

      const run = await rotate(chefLogin.c);
      expect(run.statusCode).toBe(200);
      expect(run.json()).toEqual({
        mail: null,
        totp: { rotated: before[0]!.n, failed: [lost], aborted: false },
      });
      expect(run.body).not.toMatch(/v1\.|AUTH_TOTP/);

      // Alle lesbaren Geheimnisse liegen jetzt unter k2 und gehören weiter ihrem Benutzer.
      const rows = await q<{ id: string; totp_secret_enc: string }>(
        "SELECT id, totp_secret_enc FROM benutzer WHERE totp_secret_enc IS NOT NULL AND id <> $1",
        [lost],
      );
      for (const r of rows) {
        expect(r.totp_secret_enc.split(".")[1]).toBe("k2");
        expect(ring.decryptBytes(r.totp_secret_enc, r.id)).toHaveLength(20);
      }
      expect(
        (
          await q<{ k: string }>(
            "SELECT split_part(totp_secret_enc, '.', 2) AS k FROM benutzer WHERE id = $1",
            [lost],
          )
        )[0]!.k,
      ).toBe("x");

      // Nach der Rotation lässt sich mit dem neuen Ring weiter anmelden (Zweiter Faktor entschlüsselt neu).
      const again = await h2.fullLogin("chef@anbieter.test", secrets.chef);
      expect(again.res.statusCode).toBe(200);

      const after = await as2(again.c, "GET", "/admin/rotation");
      expect(after.json().totp).toMatchObject({ configured: true, unreadable: [lost] });
      expect(after.json().totp.lastRunAt).not.toBeNull();

      const log = (await as2(again.c, "GET", "/admin/audit?action=auth.rotate-totp")).json();
      expect(log.items).toHaveLength(1);
      expect(log.items[0]).toMatchObject({
        actor: "chef@anbieter.test",
        action: "auth.rotate-totp",
        target: `umgeschlüsselt ${before[0]!.n}, fehlgeschlagen 1`,
      });
    });

    it("ein zweiter Lauf findet nichts mehr, das unlesbare Konto bleibt unverändert", async () => {
      const chefLogin = await h2.fullLogin("chef@anbieter.test", secrets.chef);
      const run = await rotate(chefLogin.c);
      expect(run.json().totp).toEqual({ rotated: 0, failed: [lost], aborted: false });
    });

    it("die API-Rolle erreicht die Rotation nur über die Chef-Funktionen, ein Kundenbenutzer als Akteur bleibt wirkungslos", async () => {
      const src = (actor: string) => pgRotationSource(db, "totp", actor);
      expect(await src(ids.aAdmin).list("k2", null, 10)).toEqual([]);
      await expect(src(ids.aAdmin).replace(A, ids.aAdmin, "x", "y")).rejects.toMatchObject({
        code: "42501",
      });
      expect((await src(ids.chef).list("zz", null, 1000)).length).toBeGreaterThan(0);
    });
  });
});
