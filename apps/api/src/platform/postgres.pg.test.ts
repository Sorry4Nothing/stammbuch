import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { Datenbank } from "@stammbuch/db";
import { createTestDatabase, withCredentials } from "../../../../packages/db/test/helpers.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { Clock, PASSWORD, harness, testConfig } from "../modules/auth/auth.testkit.js";
import type { Cookies } from "../modules/auth/auth.testkit.js";
import { createPgAuth } from "../modules/auth/pg.js";
import { createPasswordHasher } from "../modules/auth/password.js";
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
    sessions[key] = (await h.enroll(email)).c;
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
        mail: { sendSecurityNotice: () => Promise.resolve() },
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
      expect(a["fiscal-year"]).toEqual({ startMonth: 7 });
      // Kunde B sieht seine Startwerte, nichts von A.
      const b = (await call("bAdmin", "GET", "/settings/organisation")).json();
      expect(b.master.name).toBe("Verein B");
      expect(b["fiscal-year"]).toEqual({ startMonth: 1 });
      expect((await call("aUser", "PUT", "/settings/organisation/master", master)).statusCode).toBe(
        403,
      );
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
  });
});
