import { createHash } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { installPlatform, licenceOf } from "../../platform/index.js";
import type { Access } from "../../platform/index.js";
import {
  TENANT_A,
  TENANT_B,
  as,
  chef,
  makeHarness,
  makeJpeg,
  makePng,
  principals,
} from "../../platform/platform.testkit.js";
import { createPlatform } from "../../platform/index.js";
import * as admin from "../admin/index.js";
import { memorySettingsFor } from "../invoices/org-sync.js";
import * as settings from "./index.js";

const png = makePng(200, 100);
const IBAN = "CH93 0076 2011 6238 5295 7";
const QR_IBAN = "CH44 3199 9123 0008 8901 2";

describe("Rechtematrix (SR-12)", () => {
  // Jede Route der Module settings und admin hat genau diese Stufe. Eine neue Route ohne Zeile schlägt fehl.
  const expected: Record<string, Access> = {
    "GET /settings/organisation": "customer",
    "PUT /settings/organisation/:section": "customer-admin",
    "PUT /settings/organisation/logo": "customer-admin",
    "DELETE /settings/organisation/logo": "customer-admin",
    "GET /settings/organisation/logo": "customer",
    "GET /settings/users": "customer-admin",
    "POST /settings/users": "customer-admin",
    "PATCH /settings/users/:id": "customer-admin",
    "DELETE /settings/users/:id": "customer-admin",
    "GET /settings/audit": "customer-admin",
    "GET /settings/audit/export": "customer-admin",
    "GET /settings/licence": "customer",
    "GET /admin/customers": "chef",
    "POST /admin/customers": "chef",
    "GET /admin/customers/:id": "chef",
    "GET /admin/customers/:id/users": "chef",
    "PATCH /admin/customers/:id": "chef",
    "POST /admin/customers/:id/suspend": "chef",
    "POST /admin/customers/:id/reactivate": "chef",
    "POST /admin/customers/:id/end-contract": "chef",
    "POST /admin/customers/:id/invitation": "chef",
    "GET /admin/rotation": "chef",
    "POST /admin/rotation": "chef",
    "GET /admin/audit": "chef",
    "GET /admin/account": "chef",
    "PATCH /admin/account": "chef",
    "GET /admin/account/security": "chef",
    "POST /admin/account/sessions/:id/end": "chef",
  };

  async function collect() {
    const found: Record<string, Access> = {};
    const app = Fastify();
    installPlatform(app, createPlatform());
    app.addHook("onRoute", (r) => {
      for (const m of [r.method].flat())
        if (m !== "HEAD") found[`${m} ${r.url}`] = r.config?.access as Access;
    });
    for (const mod of [settings, admin]) await app.register(async (s) => mod.register(s));
    await app.ready();
    return found;
  }

  it("deckt alle Routen ab", async () => {
    expect(await collect()).toEqual(expected);
  });

  it("verweigert Anonymen, falschen Rollen und Fremdkonten die Route", async () => {
    const { app } = await makeHarness();
    const wrongFor: Record<Access, (keyof typeof principals)[]> = {
      customer: ["chef"],
      "customer-admin": ["chef", "aUser"],
      chef: ["aAdmin", "aUser"],
    };
    for (const [key, access] of Object.entries(expected)) {
      const [method, route] = key.split(" ") as [string, string];
      const url = route
        .replace(":id", "33333333-3333-4333-8333-333333333333")
        .replace(":section", "master");
      const anonymous = await app.inject({ method: method as "GET", url });
      expect(anonymous.statusCode, `${key} anonym`).toBe(401);
      for (const who of wrongFor[access]) {
        const res = await app.inject({ method: method as "GET", url, headers: as(who) });
        expect(res.statusCode, `${key} als ${who}`).toBe(403);
      }
    }
  });
});

describe("Organisation", () => {
  it("liefert Startwerte und speichert pro Bereich", async () => {
    const { app } = await makeHarness();
    const first = await app.inject({
      method: "GET",
      url: "/settings/organisation",
      headers: as("aUser"),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().master.name).toBe("Verein A");
    expect(first.json().logo).toBeNull();
    expect(first.json().modules).toEqual({ sammelrechnung: false, mail: true, kalender: true });

    const put = await app.inject({
      method: "PUT",
      url: "/settings/organisation/master",
      headers: as("aAdmin"),
      payload: {
        name: "Verein A AG",
        street: "Weg 1",
        zip: "8000",
        city: "Zürich",
        uid: "CHE-123.456.789",
        email: "a@example.test",
      },
    });
    expect(put.statusCode).toBe(200);
    const after = (
      await app.inject({ method: "GET", url: "/settings/organisation", headers: as("aAdmin") })
    ).json();
    expect(after.master).toMatchObject({ name: "Verein A AG", city: "Zürich", country: "CH" });
  });

  it("speichert den Kontoinhaber im Bereich bank und liefert ihn mit Startwert zurück", async () => {
    const { app } = await makeHarness();
    const get = async () =>
      (
        await app.inject({ method: "GET", url: "/settings/organisation", headers: as("aAdmin") })
      ).json().bank;
    expect((await get()).accountHolder).toBe("");
    const put = await app.inject({
      method: "PUT",
      url: "/settings/organisation/bank",
      headers: as("aAdmin"),
      payload: { accountHolder: "Verein A", bankName: "Kantonalbank", qrIban: QR_IBAN },
    });
    expect(put.statusCode).toBe(200);
    expect(await get()).toMatchObject({ accountHolder: "Verein A", bankName: "Kantonalbank" });
    const tooLong = await app.inject({
      method: "PUT",
      url: "/settings/organisation/bank",
      headers: as("aAdmin"),
      payload: { accountHolder: "x".repeat(121) },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it("trennt Kunden: B sieht die Daten von A nicht", async () => {
    const { app } = await makeHarness();
    await app.inject({
      method: "PUT",
      url: "/settings/organisation/fiscal-year",
      headers: as("aAdmin"),
      payload: { startMonth: 7 },
    });
    const b = (
      await app.inject({ method: "GET", url: "/settings/organisation", headers: as("bAdmin") })
    ).json();
    expect(b.master.name).toBe("Verein B");
    expect(b["fiscal-year"].startMonth).toBe(1);
  });

  it("prüft IBAN, QR-IBAN, Monat und Modul-Schalter", async () => {
    const { app } = await makeHarness();
    const put = (section: string, payload: unknown) =>
      app.inject({
        method: "PUT",
        url: `/settings/organisation/${section}`,
        headers: as("aAdmin"),
        payload: payload as object,
      });
    expect(
      (await put("bank", { bankName: "Bank", iban: IBAN, qrIban: QR_IBAN, bic: "" })).statusCode,
    ).toBe(200);
    expect(
      (
        await put("bank", {
          bankName: "Bank",
          iban: "CH93 0076 2011 6238 5295 8",
          qrIban: "",
          bic: "",
        })
      ).statusCode,
    ).toBe(400);
    // Normale IBAN ist keine QR-IBAN.
    expect(
      (await put("bank", { bankName: "Bank", iban: IBAN, qrIban: IBAN, bic: "" })).statusCode,
    ).toBe(400);
    expect((await put("fiscal-year", { startMonth: 13 })).statusCode).toBe(400);
    expect(
      (await put("modules", { sammelrechnung: true, mail: true, kalender: false })).statusCode,
    ).toBe(200);
    expect((await put("modules", { sammelrechnung: "ja" })).statusCode).toBe(400);
    expect((await put("unbekannt", {})).statusCode).toBe(400);
    const bad = await put("master", { name: "X", website: "javascript:alert(1)" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.fields).toEqual({ website: "invalid_format" });
    expect(bad.body).not.toContain("javascript");
  });

  it("speichert Rechtsform, Periodenabschluss und das Konto «Gutschriften auf» (#130)", async () => {
    const { app } = await makeHarness();
    const put = (section: string, payload: object, who: "aAdmin" | "aUser" = "aAdmin") =>
      app.inject({
        method: "PUT",
        url: `/settings/organisation/${section}`,
        headers: as(who),
        payload,
      });
    const org = async () =>
      (
        await app.inject({ method: "GET", url: "/settings/organisation", headers: as("aUser") })
      ).json();

    // Startwerte: leer bzw. monatlich, nichts erfunden.
    expect((await org()).master.legalForm).toBe("");
    expect((await org()).bank.creditAccount).toBe("");
    expect((await org())["fiscal-year"].closing).toBe("monthly");

    expect(
      (await put("master", { name: "Verein A", legalForm: "genossenschaft" })).statusCode,
    ).toBe(200);
    for (const legalForm of ["verein", "stiftung", "gmbh", "ag", "einzelunternehmen", "andere"]) {
      expect((await put("master", { name: "Verein A", legalForm })).statusCode, legalForm).toBe(
        200,
      );
    }
    // Nur die feste Auswahl, auch kein anderer Schreibweise.
    for (const legalForm of ["Verein", "kollektiv", "x".repeat(200), 5]) {
      expect((await put("master", { name: "Verein A", legalForm })).statusCode).toBe(400);
    }

    expect((await put("fiscal-year", { startMonth: 7, closing: "quarterly" })).statusCode).toBe(
      200,
    );
    expect((await put("fiscal-year", { startMonth: 7, closing: "weekly" })).statusCode).toBe(400);

    // Das Konto muss ein aktives Bestandskonto im Kontenplan des Mandanten sein.
    const bank = { bankName: "Bank", iban: "", qrIban: "", bic: "" };
    expect((await put("bank", { ...bank, creditAccount: "1020" })).statusCode).toBe(200);
    expect((await put("bank", { ...bank, creditAccount: "" })).statusCode).toBe(200);
    expect((await put("bank", { ...bank, creditAccount: "9999" })).statusCode).toBe(422);
    expect((await put("bank", { ...bank, creditAccount: "3000" })).statusCode).toBe(422); // Erlöskonto
    expect((await put("bank", { ...bank, creditAccount: "10 20" })).statusCode).toBe(400);
    expect((await put("bank", { ...bank, creditAccount: "1020" }, "aUser")).statusCode).toBe(403);
    expect((await put("bank", { ...bank, creditAccount: "1020" })).statusCode).toBe(200);

    const after = await org();
    expect(after.master.legalForm).toBe("andere");
    expect(after.bank.creditAccount).toBe("1020");
    expect(after["fiscal-year"]).toEqual({ startMonth: 7, closing: "quarterly" });
  });

  it("liest ältere Dokumente ohne die neuen Felder mit Startwerten", async () => {
    const { app, platform } = await makeHarness();
    await platform.organisations.save(TENANT_A, {
      master: {
        name: "Alt",
        street: "",
        zip: "",
        city: "",
        country: "CH",
        uid: "",
        vatNumber: "",
        email: "",
        phone: "",
        website: "",
      },
      sender: { name: "", email: "", replyTo: "", footer: "" },
      bank: { accountHolder: "", bankName: "", iban: "", qrIban: "", bic: "" },
      "fiscal-year": { startMonth: 4 },
      modules: { sammelrechnung: false, mail: true, kalender: true },
    } as never);
    const res = await app.inject({
      method: "GET",
      url: "/settings/organisation",
      headers: as("aUser"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().master.legalForm).toBe("");
    expect(res.json().bank.creditAccount).toBe("");
    expect(res.json()["fiscal-year"]).toEqual({ startMonth: 4, closing: "monthly" });
  });

  it("übernimmt keine fremden Felder (SR-72)", async () => {
    const { app, platform } = await makeHarness();
    const res = await app.inject({
      method: "PUT",
      url: "/settings/organisation/fiscal-year",
      headers: as("aAdmin"),
      payload: { startMonth: 4, tenantId: TENANT_B, admin: true },
    });
    expect(res.json()).toEqual({ "fiscal-year": { startMonth: 4, closing: "monthly" } });
    expect(await platform.organisations.get(TENANT_B)).toBeUndefined();
    expect((await platform.organisations.get(TENANT_A))?.["fiscal-year"]).toEqual({
      startMonth: 4,
      closing: "monthly",
    });
  });

  it("schreibt den Bereich, aber keine Werte ins Protokoll (SR-50)", async () => {
    const { app, platform } = await makeHarness();
    await app.inject({
      method: "PUT",
      url: "/settings/organisation/bank",
      headers: as("aAdmin"),
      payload: { bankName: "Bank", iban: IBAN, qrIban: "", bic: "" },
    });
    const { items } = await platform.audit.query(TENANT_A, {}, { limit: 10, offset: 0 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      action: "organisation.update",
      target: "bank",
      actor: "person1@example.test",
    });
    expect(JSON.stringify(items)).not.toContain("0076");
  });
});

describe("Rechnungseinstellungen aus der Organisation", () => {
  const master = {
    name: "Verein A",
    street: "Weg 1",
    zip: "8000",
    city: "Zürich",
    vatNumber: "CHE-123.456.789 MWST",
    email: "info@example.test",
    phone: "044 123 45 67",
  };
  const put = (
    app: Awaited<ReturnType<typeof makeHarness>>["app"],
    section: string,
    payload: object,
  ) =>
    app.inject({
      method: "PUT",
      url: `/settings/organisation/${section}`,
      headers: as("aAdmin"),
      payload,
    });

  it("legt sie an, sobald Adresse und QR-IBAN vollständig sind, und bewahrt eigene Werte", async () => {
    const { app, platform } = await makeHarness();
    const repo = memorySettingsFor(platform);
    expect((await put(app, "master", master)).statusCode).toBe(200);
    // Noch keine IBAN: nichts angelegt.
    expect(await repo.get(TENANT_A)).toBeNull();

    expect((await put(app, "bank", { qrIban: QR_IBAN })).statusCode).toBe(200);
    const created = await repo.get(TENANT_A);
    expect(created).toMatchObject({
      creditor: {
        name: "Verein A",
        street: "Weg 1",
        postalCode: "8000",
        town: "Zürich",
        country: "CH",
      },
      iban: QR_IBAN.replace(/ /g, ""),
      vatNumber: "CHE-123.456.789 MWST",
      contactLines: ["info@example.test", "044 123 45 67"],
      numberPrefix: "RE",
      paymentTermDays: 30,
    });

    // Eigene Werte der Rechnungseinstellungen überleben eine neue Adresse.
    await repo.save({ ...created!, numberPrefix: "VA", paymentTermDays: 14, roundTo5: true });
    await put(app, "master", { ...master, city: "Bern" });
    expect(await repo.get(TENANT_A)).toMatchObject({
      creditor: { town: "Bern" },
      numberPrefix: "VA",
      paymentTermDays: 14,
      roundTo5: true,
    });
  });

  it("trennt Kunden und lässt die Organisation gültig, wenn die Angaben nicht reichen", async () => {
    const { app, platform } = await makeHarness();
    const repo = memorySettingsFor(platform);
    await put(app, "master", { ...master, country: "DE" });
    expect((await put(app, "bank", { qrIban: QR_IBAN })).statusCode).toBe(200);
    expect(await repo.get(TENANT_A)).toBeNull();
    expect(await repo.get(TENANT_B)).toBeNull();
  });
});

describe("Logo-Upload (SR-23)", () => {
  const upload = (
    app: Awaited<ReturnType<typeof makeHarness>>["app"],
    body: Buffer,
    type: string,
    who: keyof typeof principals = "aAdmin",
  ) =>
    app.inject({
      method: "PUT",
      url: "/settings/organisation/logo",
      headers: { ...as(who), "content-type": type },
      payload: body,
    });

  it("nimmt PNG und JPEG an und liefert sie mit festem Typ zurück", async () => {
    const { app } = await makeHarness();
    expect((await upload(app, png, "image/png")).statusCode).toBe(204);
    const get = await app.inject({
      method: "GET",
      url: "/settings/organisation/logo",
      headers: as("aUser"),
    });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toBe("image/png");
    expect(get.headers["x-content-type-options"]).toBe("nosniff");
    expect(get.rawPayload.equals(png)).toBe(true);
    const org = (
      await app.inject({ method: "GET", url: "/settings/organisation", headers: as("aAdmin") })
    ).json();
    expect(org.logo).toMatchObject({ mime: "image/png", size: png.length });

    expect((await upload(app, makeJpeg(300, 300), "image/jpeg")).statusCode).toBe(204);
    // Anderer Kunde sieht es nicht.
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/settings/organisation/logo",
          headers: as("bAdmin"),
        })
      ).statusCode,
    ).toBe(404);
  });

  it("lehnt SVG, falschen Typ und kaputte Dateien ab", async () => {
    const { app } = await makeHarness();
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect((await upload(app, svg, "image/svg+xml")).statusCode).toBe(415);
    expect((await upload(app, png, "application/octet-stream")).statusCode).toBe(415);
    // Header sagt PNG, Inhalt ist JPEG, Skript oder abgeschnitten.
    expect((await upload(app, makeJpeg(100, 100), "image/png")).statusCode).toBe(400);
    expect((await upload(app, svg, "image/png")).statusCode).toBe(400);
    expect((await upload(app, png.subarray(0, 30), "image/png")).statusCode).toBe(400);
    expect((await upload(app, Buffer.alloc(0), "image/png")).statusCode).toBe(400);
  });

  it("begrenzt Grösse und Bildmasse", async () => {
    const { app } = await makeHarness();
    expect(
      (await upload(app, Buffer.concat([png, Buffer.alloc(600 * 1024)]), "image/png")).statusCode,
    ).toBe(413);
    expect((await upload(app, makePng(5000, 5000), "image/png")).statusCode).toBe(400);
    expect((await upload(app, makePng(4, 4), "image/png")).statusCode).toBe(400);
  });

  it("verlangt Admin und lässt sich entfernen", async () => {
    const { app } = await makeHarness();
    expect((await upload(app, png, "image/png", "aUser")).statusCode).toBe(403);
    await upload(app, png, "image/png");
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/settings/organisation/logo",
          headers: as("aAdmin"),
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/settings/organisation/logo",
          headers: as("aAdmin"),
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe("Benutzer", () => {
  const add = (
    app: Awaited<ReturnType<typeof makeHarness>>["app"],
    payload: object,
    who: keyof typeof principals = "aAdmin",
  ) => app.inject({ method: "POST", url: "/settings/users", headers: as(who), payload });

  it("lädt ein, ohne das Token herauszugeben", async () => {
    const { app, platform, outbox } = await makeHarness();
    const res = await add(app, { email: "Neu@Example.test", name: "Neu", role: "user" });
    expect(res.statusCode).toBe(201);
    expect(Object.keys(res.json()).sort()).toEqual([
      "createdAt",
      "email",
      "id",
      "lastLoginAt",
      "name",
      "role",
      "status",
      "totpEnrolled",
    ]);
    expect(res.json()).toMatchObject({
      email: "neu@example.test",
      status: "invited",
      role: "user",
    });

    expect(outbox.sent).toHaveLength(1);
    const { token } = outbox.sent[0]!;
    expect(res.body).not.toContain(token);
    // Nur der Hash liegt im Speicher und löst genau einmal ein.
    const hash = createHash("sha256").update(token).digest("hex");
    expect((await platform.invitations.consume(hash, platform.clock()))?.email).toBe(
      "neu@example.test",
    );
    expect(await platform.invitations.consume(hash, platform.clock())).toBeUndefined();
  });

  it("liefert letzte Anmeldung und Stand des zweiten Faktors, ohne zu erfinden", async () => {
    const { app, platform } = await makeHarness();
    const base = { tenantId: TENANT_A, role: "user" as const, createdAt: "2026-01-01T00:00:00Z" };
    await platform.users.add({
      ...base,
      id: "00000000-0000-4000-8000-0000000000a1",
      email: "mit@a.test",
      name: "Mit",
      status: "active",
      lastLoginAt: "2026-11-03T09:15:00.000Z",
      totpEnrolled: true,
    });
    await platform.users.add({
      ...base,
      id: "00000000-0000-4000-8000-0000000000a2",
      email: "ohne@a.test",
      name: "Ohne",
      status: "invited",
    });
    const items = (
      await app.inject({ method: "GET", url: "/settings/users", headers: as("aAdmin") })
    ).json().items as { email: string; lastLoginAt: string | null; totpEnrolled: boolean }[];
    const by = (email: string) => items.find((u) => u.email === email);
    expect(by("mit@a.test")).toMatchObject({
      lastLoginAt: "2026-11-03T09:15:00.000Z",
      totpEnrolled: true,
    });
    expect(by("ohne@a.test")).toMatchObject({ lastLoginAt: null, totpEnrolled: false });
  });

  it("verweigert doppelte E-Mail, auch aus einem anderen Kunden", async () => {
    const { app } = await makeHarness();
    expect(
      (await add(app, { email: "person3@example.test", name: "X", role: "user" })).statusCode,
    ).toBe(409);
    expect((await add(app, { email: "kein-mail", name: "X", role: "user" })).statusCode).toBe(400);
    expect((await add(app, { email: "a@example.test", name: "X", role: "root" })).statusCode).toBe(
      400,
    );
  });

  it("listet nur den eigenen Kunden und schützt fremde Objekte (SR-11)", async () => {
    const { app } = await makeHarness();
    const list = (
      await app.inject({ method: "GET", url: "/settings/users", headers: as("aAdmin") })
    ).json();
    expect(list.items.map((u: { email: string }) => u.email).sort()).toEqual([
      "person1@example.test",
      "person2@example.test",
    ]);
    const foreign = principals.bAdmin.userId;
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/settings/users/${foreign}`,
          headers: as("aAdmin"),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/settings/users/${foreign}`,
          headers: as("aAdmin"),
          payload: { role: "user" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("ändert Rollen und entfernt Benutzer, schützt aber den letzten Admin und sich selbst", async () => {
    const { app } = await makeHarness();
    const self = principals.aAdmin.userId;
    const other = principals.aUser.userId;
    const patch = (id: string, role: string) =>
      app.inject({
        method: "PATCH",
        url: `/settings/users/${id}`,
        headers: as("aAdmin"),
        payload: { role },
      });

    expect((await patch(self, "user")).statusCode).toBe(409); // letzter Admin
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/settings/users/${self}`,
          headers: as("aAdmin"),
        })
      ).statusCode,
    ).toBe(409);
    expect((await patch(other, "admin")).statusCode).toBe(200);
    expect((await patch(self, "user")).statusCode).toBe(200); // jetzt gibt es einen zweiten Admin
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/settings/users/${other}`,
          headers: as("aUser"),
        })
      ).statusCode,
    ).toBe(403); // aUser ist laut Header weiter Benutzer
  });

  it("ein eingeladener Admin zählt nicht: der aktive Admin bleibt geschützt, der Eingeladene ist frei entfernbar", async () => {
    const { app } = await makeHarness();
    const added = await app.inject({
      method: "POST",
      url: "/settings/users",
      headers: as("aAdmin"),
      payload: { email: "neu@example.test", name: "Neu", role: "admin" },
    });
    const invited = added.json().id as string;
    const send = (method: "PATCH" | "DELETE", id: string, payload?: object) =>
      app.inject({ method, url: `/settings/users/${id}`, headers: as("aAdmin"), payload });
    expect((await send("PATCH", principals.aAdmin.userId, { role: "user" })).statusCode).toBe(409);
    expect((await send("DELETE", invited)).statusCode).toBe(204);
  });

  it("protokolliert Hinzufügen und Entfernen", async () => {
    const { app, platform } = await makeHarness();
    const created = (
      await add(app, { email: "neu@example.test", name: "Neu", role: "user" })
    ).json();
    await app.inject({
      method: "DELETE",
      url: `/settings/users/${created.id}`,
      headers: as("aAdmin"),
    });
    const { items } = await platform.audit.query(TENANT_A, {}, { limit: 10, offset: 0 });
    expect(items.map((e) => e.action)).toEqual(["user.remove", "user.add"]);
  });
});

describe("Protokoll", () => {
  async function seeded() {
    const h = await makeHarness();
    const entries = [
      ["2026-10-01T08:00:00.000Z", "alt@example.test", "user.add", "x@example.test"],
      ["2026-10-15T08:00:00.000Z", "person1@example.test", "organisation.update", "bank"],
      ["2026-11-01T08:00:00.000Z", "person1@example.test", "user.remove", "y@example.test"],
      [
        "2026-11-02T08:00:00.000Z",
        "person1@example.test",
        "audit.export",
        '=HYPERLINK("http://böse.example","Klick")',
      ],
    ] as const;
    for (const [i, [at, actor, action, target]] of entries.entries()) {
      await h.platform.audit.append(TENANT_A, {
        id: `00000000-0000-4000-8000-00000000010${i}`,
        at,
        actorId: "x",
        actor,
        action,
        target,
      });
    }
    await h.platform.audit.append(TENANT_B, {
      id: "00000000-0000-4000-8000-0000000001ff",
      at: "2026-11-03T08:00:00.000Z",
      actorId: "x",
      actor: "b@example.test",
      action: "geheim.b",
      target: "",
    });
    return h;
  }
  const list = async (h: Awaited<ReturnType<typeof makeHarness>>, query: string) =>
    (
      await h.app.inject({ method: "GET", url: `/settings/audit${query}`, headers: as("aAdmin") })
    ).json();

  it("filtert und blättert, neueste zuerst, nur eigener Kunde", async () => {
    const h = await seeded();
    const all = await list(h, "");
    expect(all.total).toBe(4);
    expect(all.items[0].action).toBe("audit.export");
    expect(JSON.stringify(all)).not.toContain("geheim.b");
    expect(Object.keys(all.items[0]).sort()).toEqual([
      "action",
      "actor",
      "at",
      "id",
      "result",
      "target",
    ]);

    expect((await list(h, "?action=user.add")).total).toBe(1);
    expect((await list(h, "?actor=ALT")).total).toBe(1);
    expect((await list(h, "?q=bank")).total).toBe(1);
    expect(
      (await list(h, "?from=2026-10-10T00:00:00.000Z&to=2026-11-01T23:59:59.000Z")).total,
    ).toBe(2);
    const page = await list(h, "?limit=2&offset=3");
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(4);
    expect(
      (
        await h.app.inject({
          method: "GET",
          url: "/settings/audit?limit=100000",
          headers: as("aAdmin"),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await h.app.inject({
          method: "GET",
          url: "/settings/audit?from=gestern",
          headers: as("aAdmin"),
        })
      ).statusCode,
    ).toBe(400);
  });

  it("exportiert CSV und neutralisiert Formeln", async () => {
    const h = await seeded();
    const res = await h.app.inject({
      method: "GET",
      url: "/settings/audit/export?action=audit.export",
      headers: as("aAdmin"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="protokoll-2026-11-04.csv"',
    );
    const lines = res.body.replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toBe("Zeitpunkt;Benutzer;Aktion;Objekt;Ergebnis");
    // Das Feld beginnt nicht mehr mit `=`, sondern mit `'`.
    expect(lines[1]).toBe(
      '2026-11-02T08:00:00.000Z;person1@example.test;audit.export;"\'=HYPERLINK(""http://böse.example"",""Klick"")";Erfolgreich',
    );
    expect(lines).toHaveLength(2);
    // Der Export selbst steht im Protokoll.
    expect((await list(h, "?action=audit.export")).total).toBe(2);
  });

  it("liefert das Ergebnis je Eintrag (Erfolg, Fehler) und exportiert es als Spalte (#130)", async () => {
    const h = await seeded();
    await h.platform.audit.append(TENANT_A, {
      id: "00000000-0000-4000-8000-0000000001aa",
      at: "2026-11-03T09:00:00.000Z",
      actorId: "x",
      actor: "person1@example.test",
      action: "login_failure",
      target: "",
      result: "failure",
    });
    const page = await list(h, "?limit=200");
    const byAction = new Map<string, string>(
      page.items.map((e: { action: string; result: string }) => [e.action, e.result]),
    );
    // Einträge ohne Angabe gelten als erfolgreich.
    expect(byAction.get("user.add")).toBe("success");
    expect(byAction.get("login_failure")).toBe("failure");

    const csv = await h.app.inject({
      method: "GET",
      url: "/settings/audit/export?action=login_failure",
      headers: as("aAdmin"),
    });
    const lines = csv.body.trim().split("\r\n");
    expect(lines[0]).toMatch(/;Ergebnis$/);
    expect(lines[1]).toBe(
      "2026-11-03T09:00:00.000Z;person1@example.test;login_failure;;Fehlgeschlagen",
    );

    const xlsx = await h.app.inject({
      method: "GET",
      url: "/settings/audit/export?action=login_failure&format=xlsx",
      headers: as("aAdmin"),
    });
    const xml = xlsx.rawPayload.toString("latin1");
    expect(xml).toContain("Ergebnis");
    expect(xml).toContain("Fehlgeschlagen");
  });

  it("exportiert .xlsx auf Wunsch, mit Filter, Protokolleintrag und ohne Formeln", async () => {
    const h = await seeded();
    const res = await h.app.inject({
      method: "GET",
      url: "/settings/audit/export?action=audit.export&format=xlsx",
      headers: as("aAdmin"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="protokoll-2026-11-04.xlsx"',
    );
    const zip = res.rawPayload;
    expect(zip.subarray(0, 4).toString("hex")).toBe("504b0304"); // ZIP
    const xml = zip.toString("latin1");
    expect(xml).toContain("xl/worksheets/sheet1.xml");
    expect(xml).toContain("person1@example.test");
    expect(xml).not.toContain("<f>");
    expect((await list(h, "?action=audit.export")).total).toBe(2);
    // Unbekanntes Format: abgelehnt statt stillschweigend CSV.
    const bad = await h.app.inject({
      method: "GET",
      url: "/settings/audit/export?format=pdf",
      headers: as("aAdmin"),
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("Lizenz", () => {
  it("zeigt den Zustand und sperrt bei Ablauf alle schreibenden Routen", async () => {
    const h = await makeHarness();
    // Eine fremde, schreibende Route (wie sie spätere Module haben) fällt unter dieselbe Prüfung.
    h.app.post("/rechnungen", () => ({ ok: true }));
    const licence = async (who: "aUser" | "aAdmin" = "aUser") =>
      (await h.app.inject({ method: "GET", url: "/settings/licence", headers: as(who) })).json();
    expect(await licence()).toEqual({
      customerId: TENANT_A,
      // Nummer vergibt die Persistenz; der Vertrag kennt hier keinen Beginn.
      licenceNumber: "L-0001",
      licenceStart: null,
      state: "active",
      validUntil: "2099-12-31",
      readOnly: false,
      blocked: false,
    });

    await h.platform.tenants.update(chef.accountId, TENANT_A, { licenceValidUntil: "2026-11-04" });
    // Letzter Gültigkeitstag zählt noch (Zeitzone Zürich).
    expect((await licence()).state).toBe("active");

    h.clock.now = new Date("2026-11-04T23:30:00Z"); // 05.11. 00:30 in Zürich
    expect(await licence()).toMatchObject({ state: "expired", readOnly: true, blocked: false });
    const write = await h.app.inject({
      method: "PUT",
      url: "/settings/organisation/fiscal-year",
      headers: as("aAdmin"),
      payload: { startMonth: 2 },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe("LICENCE_READ_ONLY");
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: "/settings/users",
          headers: as("aAdmin"),
          payload: { email: "n@example.test", name: "N", role: "user" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app.inject({
          method: "DELETE",
          url: "/settings/organisation/logo",
          headers: as("aAdmin"),
        })
      ).statusCode,
    ).toBe(403);
    // Lesen bleibt erlaubt, auch der Export.
    expect(
      (await h.app.inject({ method: "GET", url: "/settings/organisation", headers: as("aAdmin") }))
        .statusCode,
    ).toBe(200);
    expect(
      (await h.app.inject({ method: "GET", url: "/settings/audit/export", headers: as("aAdmin") }))
        .statusCode,
    ).toBe(200);
    // Andere Kunden sind nicht betroffen.
    expect(
      (
        await h.app.inject({
          method: "PUT",
          url: "/settings/organisation/fiscal-year",
          headers: as("bAdmin"),
          payload: { startMonth: 2 },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("nennt Lizenznummer und Beginn nur des eigenen Kunden (#130)", async () => {
    const h = await makeHarness();
    const own = async (who: "aUser" | "bAdmin") =>
      (await h.app.inject({ method: "GET", url: "/settings/licence", headers: as(who) })).json();
    expect(await own("aUser")).toMatchObject({ customerId: TENANT_A, licenceNumber: "L-0001" });
    expect(await own("bAdmin")).toMatchObject({ customerId: TENANT_B, licenceNumber: "L-0002" });

    const tenant = await h.platform.tenants.get(TENANT_A);
    expect(licenceOf(tenant!, h.clock.now)).toMatchObject({
      licenceNumber: "L-0001",
      licenceStart: null,
    });
    expect(licenceOf({ ...tenant!, licenceStart: "2026-01-15" }, h.clock.now).licenceStart).toBe(
      "2026-01-15",
    );
    // Auch bei gesperrtem Kunden bleibt die Anzeige vollständig.
    expect(
      licenceOf({ ...tenant!, status: "suspended", licenceStart: "2026-01-15" }, h.clock.now),
    ).toMatchObject({ state: "suspended", licenceNumber: "L-0001", licenceStart: "2026-01-15" });
  });

  it("sperrt nicht-settings Routen bei Nur-Lesen, lässt Chef-Admin und Anonyme durch", async () => {
    const h = await makeHarness();
    h.app.post("/rechnungen", () => ({ ok: true }));
    h.app.get("/rechnungen", () => ({ ok: true }));
    await h.platform.tenants.update(chef.accountId, TENANT_A, { licenceValidUntil: "2020-01-01" });
    expect(
      (await h.app.inject({ method: "POST", url: "/rechnungen", headers: as("aAdmin") }))
        .statusCode,
    ).toBe(403);
    expect(
      (await h.app.inject({ method: "GET", url: "/rechnungen", headers: as("aAdmin") })).statusCode,
    ).toBe(200);
    expect(
      (await h.app.inject({ method: "POST", url: "/rechnungen", headers: as("chef") })).statusCode,
    ).toBe(200);
    expect((await h.app.inject({ method: "POST", url: "/rechnungen" })).statusCode).toBe(200);
  });

  it("sperrt bei Vertragsende schreibend und bei Sperre vollständig", async () => {
    const h = await makeHarness();
    await h.platform.tenants.update(chef.accountId, TENANT_A, { status: "ended" });
    const get = () =>
      h.app.inject({ method: "GET", url: "/settings/organisation", headers: as("aAdmin") });
    expect((await get()).statusCode).toBe(200);
    expect(
      (
        await h.app.inject({
          method: "PUT",
          url: "/settings/organisation/modules",
          headers: as("aAdmin"),
          payload: { sammelrechnung: true, mail: true, kalender: true },
        })
      ).statusCode,
    ).toBe(403);

    await h.platform.tenants.update(chef.accountId, TENANT_A, { status: "suspended" });
    expect((await get()).statusCode).toBe(403);
    const licence = await h.app.inject({
      method: "GET",
      url: "/settings/licence",
      headers: as("aAdmin"),
    });
    expect(licence.json()).toMatchObject({ state: "suspended", blocked: true });
  });

  it("verweigert, wenn der Kunde zur Session nicht existiert (fail secure)", async () => {
    const h = await makeHarness();
    h.platform.principal = async () => ({
      kind: "customer",
      userId: "u",
      tenantId: "99999999-9999-4999-8999-999999999999",
      email: "x@example.test",
      role: "admin",
    });
    expect((await h.app.inject({ method: "GET", url: "/settings/organisation" })).statusCode).toBe(
      403,
    );
  });

  it("gibt bei Ausfall des Resolvers 500 statt Zugriff (SR-54)", async () => {
    const h = await makeHarness();
    h.platform.principal = async () => {
      throw new Error("Session-Speicher nicht erreichbar");
    };
    const res = await h.app.inject({ method: "GET", url: "/settings/organisation" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("Session-Speicher");
  });
});
