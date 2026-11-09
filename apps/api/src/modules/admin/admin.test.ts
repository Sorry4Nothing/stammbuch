import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { errorHandler, notFoundHandler } from "../../lib/errors.js";
import { createMemoryStore } from "../people/memory.js";
import { createPeopleModule } from "../people/routes.js";
import { TENANT_A, TENANT_B, as, chef, makeHarness } from "../../platform/platform.testkit.js";
import type { MemoryOversight } from "../../platform/memory.js";
import type { RotationControl, RotationKind, RotationOutcome } from "../../platform/types.js";

type Harness = Awaited<ReturnType<typeof makeHarness>>;
/** Genau diese Felder verlassen die API pro Kunde: Vertragsdaten und Zahlen, nie Kundendaten. */
const CUSTOMER_KEYS = [
  "createdAt",
  "endedAt",
  "id",
  "invitation",
  "licenceNumber",
  "licenceStart",
  "licenceValidUntil",
  "modules",
  "name",
  "slug",
  "status",
  "userCount",
];
const create = (
  h: Harness,
  payload: object = {
    name: "Neuer Verein",
    contactEmail: "Kontakt@Example.test",
    licenceValidUntil: "2027-06-30",
  },
) => h.app.inject({ method: "POST", url: "/admin/customers", headers: as("chef"), payload });

describe("Kunden", () => {
  it("legt einen Kunden mit Einladung an, ohne das Token herauszugeben", async () => {
    const h = await makeHarness();
    const res = await create(h);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(CUSTOMER_KEYS);
    expect(body).toMatchObject({
      name: "Neuer Verein",
      status: "active",
      invitation: { email: "kontakt@example.test", status: "pending" },
      // Fortlaufende Nummer (die zwei Kunden des Testaufbaus haben L-0001 und L-0002), Beginn heute, keine Module.
      licenceNumber: "L-0003",
      licenceStart: "2026-11-04",
      modules: [],
      userCount: 0,
    });

    expect(h.outbox.sent).toHaveLength(1);
    const { token, to } = h.outbox.sent[0]!;
    expect(to).toBe("kontakt@example.test");
    expect(res.body).not.toContain(token);
    const stored = await h.platform.invitations.latestForTenant(body.id);
    expect(stored).toMatchObject({
      role: "admin",
      userId: null,
      tokenHash: createHash("sha256").update(token).digest("hex"),
    });
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("validiert Eingaben", async () => {
    const h = await makeHarness();
    expect(
      (
        await create(h, {
          name: "",
          contactEmail: "a@example.test",
          licenceValidUntil: "2027-06-30",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await create(h, { name: "X", contactEmail: "keine-mail", licenceValidUntil: "2027-06-30" }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await create(h, {
          name: "X",
          contactEmail: "a@example.test",
          licenceValidUntil: "30.06.2027",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await create(h, {
          name: "X",
          contactEmail: "a@example.test",
          licenceValidUntil: "2027-06-30",
          status: "ended",
        })
      ).json().status,
    ).toBe("active");
  });

  it("listet mit Filter und Seiten, zeigt nur Vertragsdaten", async () => {
    const h = await makeHarness();
    await create(h);
    const list = async (q: string) =>
      (
        await h.app.inject({ method: "GET", url: `/admin/customers${q}`, headers: as("chef") })
      ).json();
    expect((await list("")).total).toBe(3);
    expect((await list("?q=neuer")).items.map((c: { name: string }) => c.name)).toEqual([
      "Neuer Verein",
    ]);
    expect((await list("?limit=1&offset=1")).items).toHaveLength(1);
    expect((await list("?status=ended")).total).toBe(0);
    expect(
      (await h.app.inject({ method: "GET", url: "/admin/customers?limit=0", headers: as("chef") }))
        .statusCode,
    ).toBe(400);
    const detail = await h.app.inject({
      method: "GET",
      url: `/admin/customers/${TENANT_A}`,
      headers: as("chef"),
    });
    expect(detail.json()).toMatchObject({ id: TENANT_A, name: "Verein A", invitation: null });
    expect(
      (
        await h.app.inject({
          method: "GET",
          url: "/admin/customers/33333333-3333-4333-8333-333333333333",
          headers: as("chef"),
        })
      ).statusCode,
    ).toBe(404);
  });

  it("ändert Vertragsdaten, sperrt, reaktiviert und beendet mit gültigen Übergängen", async () => {
    const h = await makeHarness();
    const post = (action: string) =>
      h.app.inject({
        method: "POST",
        url: `/admin/customers/${TENANT_A}/${action}`,
        headers: as("chef"),
      });

    const patched = await h.app.inject({
      method: "PATCH",
      url: `/admin/customers/${TENANT_A}`,
      headers: as("chef"),
      payload: { licenceValidUntil: "2030-01-31" },
    });
    expect(patched.json().licenceValidUntil).toBe("2030-01-31");
    expect(
      (
        await h.app.inject({
          method: "PATCH",
          url: `/admin/customers/${TENANT_A}`,
          headers: as("chef"),
          payload: {},
        })
      ).statusCode,
    ).toBe(400);

    expect((await post("reactivate")).statusCode).toBe(409); // nicht gesperrt
    expect((await post("suspend")).json().status).toBe("suspended");
    expect((await post("suspend")).statusCode).toBe(409);
    // Gesperrter Kunde kommt nicht mehr an seine Daten.
    expect(
      (await h.app.inject({ method: "GET", url: "/settings/organisation", headers: as("aAdmin") }))
        .statusCode,
    ).toBe(403);
    expect((await post("reactivate")).json().status).toBe("active");
    expect(
      (await h.app.inject({ method: "GET", url: "/settings/organisation", headers: as("aAdmin") }))
        .statusCode,
    ).toBe(200);

    const ended = (await post("end-contract")).json();
    expect(ended).toMatchObject({ status: "ended", endedAt: "2026-11-04T10:00:00.000Z" });
    expect((await post("reactivate")).statusCode).toBe(409);
    expect((await post("end-contract")).statusCode).toBe(409);
    // Vertragsende heisst Nur-Lesen.
    expect(
      (
        await h.app.inject({
          method: "PUT",
          url: "/settings/organisation/fiscal-year",
          headers: as("aAdmin"),
          payload: { startMonth: 2 },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("sendet die Einladung erneut, aber nur für aktive Kunden", async () => {
    const h = await makeHarness();
    const url = `/admin/customers/${TENANT_A}/invitation`;
    const send = () =>
      h.app.inject({
        method: "POST",
        url,
        headers: as("chef"),
        payload: { contactEmail: "neu@example.test" },
      });
    expect((await send()).statusCode).toBe(204);
    expect(h.outbox.sent.at(-1)?.to).toBe("neu@example.test");
    await h.platform.tenants.update(chef.accountId, TENANT_A, { status: "suspended" });
    expect((await send()).statusCode).toBe(409);
  });

  it("zeigt abgelaufene und angenommene Einladungen", async () => {
    const h = await makeHarness();
    const { id } = (await create(h)).json();
    h.clock.now = new Date("2026-12-01T00:00:00Z");
    const detail = async () =>
      (
        await h.app.inject({ method: "GET", url: `/admin/customers/${id}`, headers: as("chef") })
      ).json();
    expect((await detail()).invitation.status).toBe("expired");
    h.clock.now = new Date("2026-11-05T00:00:00Z");
    const hash = createHash("sha256").update(h.outbox.sent[0]!.token).digest("hex");
    await h.platform.invitations.consume(hash, h.clock.now);
    expect((await detail()).invitation.status).toBe("accepted");
  });
});

describe("Kunden-Slug", () => {
  const payload = (name: string, extra: object = {}) => ({
    name,
    contactEmail: "kontakt@example.test",
    licenceValidUntil: "2027-06-30",
    ...extra,
  });
  const all = async (h: Harness) =>
    (await h.platform.tenants.list(chef.accountId, {}, { limit: 100, offset: 0 })).items;
  const patch = (h: Harness, id: string, body: object, who: "chef" | "aAdmin" = "chef") =>
    h.app.inject({
      method: "PATCH",
      url: `/admin/customers/${id}`,
      headers: as(who),
      payload: body,
    });

  it("kommt beim Anlegen automatisch aus dem Namen", async () => {
    const h = await makeHarness();
    const res = await create(h, payload("Männerchor Zürich-Höngg 1887 & Co."));
    expect(res.statusCode).toBe(201);
    expect(res.json().slug).toBe("maennerchor-zuerich-hoengg-1887-co");
  });

  it("hängt bei Kollision eine Zahl an, auch mit gleichem Namen und bei Grossschreibung", async () => {
    const h = await makeHarness();
    const got: string[] = [];
    for (const name of ["Turnverein", "Turnverein", "TURNVEREIN", "Turnverein!"]) {
      got.push((await create(h, payload(name))).json().slug);
    }
    expect(got).toEqual(["turnverein", "turnverein-2", "turnverein-3", "turnverein-4"]);
  });

  it("hält die Länge ein, auch mit Suffix, und fällt bei leerem Namen auf «kunde» zurück", async () => {
    const h = await makeHarness();
    const lang = "a".repeat(100);
    expect((await create(h, payload(lang))).json().slug).toBe("a".repeat(63));
    expect((await create(h, payload(lang))).json().slug).toBe(`${"a".repeat(61)}-2`);
    expect((await create(h, payload("!!! ???"))).json().slug).toBe("kunde");
    expect((await create(h, payload("日本語"))).json().slug).toBe("kunde-2");
  });

  it("überspringt reservierte Slugs", async () => {
    const h = await makeHarness();
    expect((await create(h, payload("Admin"))).json().slug).toBe("admin-2");
  });

  it("der Chef-Admin überschreibt den Vorschlag; ein vergebener oder ungültiger Slug wird abgelehnt", async () => {
    const h = await makeHarness();
    const res = await create(h, payload("Irgendein Name", { slug: "mein-verein" }));
    expect(res.json().slug).toBe("mein-verein");
    expect((await create(h, payload("Anderer", { slug: "mein-verein" }))).statusCode).toBe(409);
    for (const slug of ["Gross", "mit leer", "-start", "x".repeat(64), "api", "ä"]) {
      expect((await create(h, payload("Anderer", { slug }))).statusCode, slug).toBe(400);
    }
    // Kein halb angelegter Kunde und keine zweite Einladung nach den Fehlschlägen.
    expect((await all(h)).map((t) => t.slug).sort()).toEqual([
      "mein-verein",
      "verein-a",
      "verein-b",
    ]);
    expect(h.outbox.sent).toHaveLength(1);
  });

  it("der Chef-Admin ändert den Slug später; Duplikat und Format scheitern", async () => {
    const h = await makeHarness();
    const ok = await patch(h, TENANT_A, { slug: "turnverein-a" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().slug).toBe("turnverein-a");
    expect((await patch(h, TENANT_A, { slug: "verein-b" })).statusCode).toBe(409);
    expect((await patch(h, TENANT_A, { slug: "turnverein-a" })).statusCode).toBe(200); // eigener Slug
    expect((await patch(h, TENANT_A, { slug: "Verein A" })).statusCode).toBe(400);
    expect((await patch(h, TENANT_A, { slug: "public" })).statusCode).toBe(400);
    expect((await patch(h, TENANT_A, { name: "Neuer Name" })).json().slug).toBe("turnverein-a");
  });

  it("verweigert Kundenadmins das Anlegen und Ändern, auch mit Slug", async () => {
    const h = await makeHarness();
    const res = await h.app.inject({
      method: "POST",
      url: "/admin/customers",
      headers: as("aAdmin"),
      payload: payload("Y", { slug: "y" }),
    });
    expect(res.statusCode).toBe(403);
    expect((await patch(h, TENANT_A, { slug: "gekapert" }, "aAdmin")).statusCode).toBe(403);
    expect((await all(h)).map((t) => t.slug).sort()).toEqual(["verein-a", "verein-b"]);
  });

  it("ein neuer Kunde ist sofort unter /public/<slug>/… erreichbar", async () => {
    const h = await makeHarness();
    const slug = (await create(h, payload("Frauenverein Bülach"))).json().slug;
    expect(slug).toBe("frauenverein-buelach");
    const pub = Fastify();
    pub.setErrorHandler(errorHandler);
    pub.setNotFoundHandler(notFoundHandler);
    await pub.register(async (scope) =>
      createPeopleModule({
        store: createMemoryStore(),
        resolveContext: async () => undefined,
        resolveTenant: async (s) => (await all(h)).find((t) => t.slug === s)?.id,
        mailer: { send: async () => undefined },
        formSecret: Buffer.alloc(32, 7),
      }).register(scope),
    );
    const hit = await pub.inject({ method: "GET", url: `/public/${slug}/registrierung/formular` });
    expect(hit.statusCode).toBe(200);
    const miss = await pub.inject({
      method: "GET",
      url: "/public/gibt-es-nicht/registrierung/formular",
    });
    expect(miss.statusCode).toBe(404);
  });
});

describe("Protokoll und eigenes Konto", () => {
  it("protokolliert Chef-Aktionen getrennt vom Kundenprotokoll", async () => {
    const h = await makeHarness();
    await create(h);
    await h.app.inject({
      method: "POST",
      url: `/admin/customers/${TENANT_A}/suspend`,
      headers: as("chef"),
    });
    const audit = (
      await h.app.inject({ method: "GET", url: "/admin/audit", headers: as("chef") })
    ).json();
    expect(audit.items.map((e: { action: string }) => e.action)).toEqual([
      "customer.suspend",
      "customer.create",
    ]);
    expect(audit.items[0]).toMatchObject({ actor: "chef@example.test", target: "Verein A" });
    expect((await h.platform.audit.query(TENANT_A, {}, { limit: 10, offset: 0 })).total).toBe(0);
  });

  it("zeigt und ändert das eigene Konto", async () => {
    const h = await makeHarness();
    const get = () => h.app.inject({ method: "GET", url: "/admin/account", headers: as("chef") });
    expect((await get()).json()).toMatchObject({ email: "chef@example.test", displayName: "Chef" });
    const patch = await h.app.inject({
      method: "PATCH",
      url: "/admin/account",
      headers: as("chef"),
      payload: { displayName: "Robin", email: "x@example.test" },
    });
    expect(patch.json()).toMatchObject({ displayName: "Robin", email: "chef@example.test" });
    expect(
      (
        await h.app.inject({
          method: "PATCH",
          url: "/admin/account",
          headers: as("chef"),
          payload: { displayName: "" },
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe("Chef-Admin sieht keine Kundendaten", () => {
  it("bekommt auf jede Kundenroute 403 ohne Inhalt", async () => {
    const h = await makeHarness();
    await h.platform.organisations.save(TENANT_A, {
      master: {
        name: "GEHEIM-NAME",
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
      "fiscal-year": { startMonth: 1 },
      modules: { sammelrechnung: false, mail: true, kalender: true },
    });
    for (const url of [
      "/settings/organisation",
      "/settings/organisation/logo",
      "/settings/users",
      "/settings/audit",
      "/settings/audit/export",
    ]) {
      const res = await h.app.inject({ method: "GET", url, headers: as("chef") });
      expect(res.statusCode, url).toBe(403);
      expect(res.body).not.toContain("GEHEIM");
      expect(res.json().error.code).toBe("FORBIDDEN");
    }
  });

  it("antwortet in der Kundenliste nur mit Vertragsfeldern, auch wenn der Kunde Daten hat", async () => {
    const h = await makeHarness();
    await h.app.inject({
      method: "PUT",
      url: "/settings/organisation/master",
      headers: as("aAdmin"),
      payload: { name: "Verein A", email: "intern@example.test" },
    });
    const res = await h.app.inject({ method: "GET", url: "/admin/customers", headers: as("chef") });
    expect(res.body).not.toContain("intern@example.test");
    for (const item of res.json().items) {
      expect(Object.keys(item).sort()).toEqual(CUSTOMER_KEYS);
    }
  });

  it("greift im Quelltext nie auf Kundenspeicher oder das Settings-Modul zu", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const code = readFileSync(join(dir, file), "utf8");
      expect(code, file).not.toMatch(/settings/);
      expect(code, file).not.toMatch(/\.(users|organisations|logos|audit)\b/);
    }
  });
});

describe("Schlüsselrotation durch den Chef-Admin", () => {
  const ID = "44444444-4444-4444-8444-444444444444";
  /** Zeichnet Akteur und Art auf und liefert festgelegte Ergebnisse; `null` = Art nicht konfiguriert. */
  function fake(results: Partial<Record<RotationKind, RotationOutcome | null>>) {
    const calls: { actor: string; kind: RotationKind }[] = [];
    const rotation: RotationControl = {
      run: async (actor, kind) => {
        calls.push({ actor, kind });
        return results[kind] ?? undefined;
      },
      status: async () => ({
        mail: { configured: true, lastRunAt: "2026-11-05T10:00:00.000Z", unreadable: [ID] },
        totp: { configured: false, lastRunAt: null, unreadable: [] },
      }),
    };
    return { rotation, calls };
  }
  const post = (h: Awaited<ReturnType<typeof makeHarness>>, who: "chef" | "aAdmin" = "chef") =>
    h.app.inject({ method: "POST", url: "/admin/rotation", headers: as(who) });

  it("löst beide Rotationen sofort aus, gibt Zähler und IDs zurück und protokolliert jede mit dem Chef-Admin", async () => {
    const { rotation, calls } = fake({
      mail: { rotated: 3, failed: [ID], aborted: false },
      totp: { rotated: 2, failed: [], aborted: false },
    });
    const h = await makeHarness({ rotation });
    const res = await post(h);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      mail: { rotated: 3, failed: [ID], aborted: false },
      totp: { rotated: 2, failed: [], aborted: false },
    });
    // Der Akteur ist der Chef-Admin der Sitzung, nie etwas aus der Anfrage.
    expect(calls).toEqual([
      { actor: chef.accountId, kind: "mail" },
      { actor: chef.accountId, kind: "totp" },
    ]);
    const log = await h.platform.platformAudit.query("platform", {}, { limit: 10, offset: 0 });
    expect(
      log.items.map((e) => [e.actor, e.action, e.target]).sort((a, b) => (a[1]! < b[1]! ? -1 : 1)),
    ).toEqual([
      ["chef@example.test", "auth.rotate-totp", "umgeschlüsselt 2, fehlgeschlagen 0"],
      ["chef@example.test", "mail.rotate-secrets", "umgeschlüsselt 3, fehlgeschlagen 1"],
    ]);
  });

  it("ignoriert Akteur und Art aus Body, Query und Header (SR-13, SR-72)", async () => {
    const { rotation, calls } = fake({ mail: { rotated: 0, failed: [], aborted: false } });
    const h = await makeHarness({ rotation });
    const res = await h.app.inject({
      method: "POST",
      url: `/admin/rotation?actor=${ID}&kind=totp`,
      headers: { ...as("chef"), "x-actor": ID },
      payload: { actor: ID, kind: "totp", tenantId: ID },
    });
    expect(res.statusCode).toBe(200);
    expect(calls.every((c) => c.actor === chef.accountId)).toBe(true);
  });

  it("meldet nicht konfigurierte Arten als null und schreibt dafür kein Protokoll", async () => {
    const { rotation } = fake({});
    const h = await makeHarness({ rotation });
    expect((await post(h)).json()).toEqual({ mail: null, totp: null });
    expect(
      (await h.platform.platformAudit.query("platform", {}, { limit: 10, offset: 0 })).total,
    ).toBe(0);
  });

  it("ein Fehler der Rotation wird zum 500 ohne Details, der Lauf steht trotzdem im Protokoll (SR-51, SR-52, SR-54)", async () => {
    const rotation: RotationControl = {
      run: async () => {
        throw new Error("Verbindung zu geheim-db.intern weg");
      },
      status: async () => {
        throw new Error("x");
      },
    };
    const h = await makeHarness({ rotation });
    const res = await post(h);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("geheim-db");
    // Der angestossene Lauf bleibt nachvollziehbar, ohne den Fehlertext.
    const log = await h.platform.platformAudit.query("platform", {}, { limit: 10, offset: 0 });
    expect(log.items.map((e) => [e.actor, e.action, e.target])).toEqual([
      ["chef@example.test", "mail.rotate-secrets", "Fehler"],
    ]);
  });

  it("zeigt dem Chef-Admin den Stand mit den unlesbaren IDs", async () => {
    const h = await makeHarness({ rotation: fake({}).rotation });
    const res = await h.app.inject({ method: "GET", url: "/admin/rotation", headers: as("chef") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      mail: { configured: true, lastRunAt: "2026-11-05T10:00:00.000Z", unreadable: [ID] },
      totp: { configured: false, lastRunAt: null, unreadable: [] },
    });
  });

  it("verweigert Kundenadmins und Anonymen Auslösen und Stand, ohne etwas zu rotieren", async () => {
    const { rotation, calls } = fake({ mail: { rotated: 1, failed: [], aborted: false } });
    const h = await makeHarness({ rotation });
    expect((await post(h, "aAdmin")).statusCode).toBe(403);
    expect(
      (await h.app.inject({ method: "GET", url: "/admin/rotation", headers: as("aAdmin") }))
        .statusCode,
    ).toBe(403);
    expect((await h.app.inject({ method: "POST", url: "/admin/rotation" })).statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it("ohne Datenbank ist keine Art konfiguriert (Standard)", async () => {
    const h = await makeHarness();
    expect((await post(h)).json()).toEqual({ mail: null, totp: null });
    const res = await h.app.inject({ method: "GET", url: "/admin/rotation", headers: as("chef") });
    expect(res.json().mail.configured).toBe(false);
  });

  it("begrenzt die Häufigkeit (teurer Lauf)", async () => {
    const h = await makeHarness({ rotation: fake({}).rotation });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await post(h)).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });
});

describe("Lizenzdaten", () => {
  const base = { name: "Lizenz-Verein", contactEmail: "a@example.test" };
  it("legt Lizenzbeginn und Module an und liefert sie in Detail und Liste", async () => {
    const h = await makeHarness();
    const res = await create(h, {
      ...base,
      licenceValidUntil: "2027-06-30",
      licenceStart: "2026-07-01",
      modules: ["mail", "kalender"],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      licenceStart: "2026-07-01",
      modules: ["mail", "kalender"],
      licenceNumber: "L-0003",
    });
    const id = res.json().id;
    const detail = (
      await h.app.inject({ method: "GET", url: `/admin/customers/${id}`, headers: as("chef") })
    ).json();
    expect(detail).toMatchObject({ licenceStart: "2026-07-01", modules: ["mail", "kalender"] });
    const list = (
      await h.app.inject({ method: "GET", url: "/admin/customers?q=lizenz", headers: as("chef") })
    ).json();
    expect(list.items[0]).toMatchObject({ licenceNumber: "L-0003", modules: ["mail", "kalender"] });
  });

  it("vergibt fortlaufende Nummern und zählt aktive Benutzer als Zahl", async () => {
    const h = await makeHarness();
    const numbers = [];
    for (let i = 0; i < 2; i++) {
      numbers.push(
        (await create(h, { ...base, name: `Verein ${i}`, licenceValidUntil: "2027-06-30" })).json()
          .licenceNumber,
      );
    }
    expect(numbers).toEqual(["L-0003", "L-0004"]);
    const detail = (
      await h.app.inject({
        method: "GET",
        url: `/admin/customers/${TENANT_A}`,
        headers: as("chef"),
      })
    ).json();
    // Der Testaufbau legt in Verein A einen Admin und einen Benutzer an.
    expect(detail.userCount).toBe(2);
  });

  it("lehnt ungültige Angaben ab und ignoriert eine mitgeschickte Nummer (SR-72)", async () => {
    const h = await makeHarness();
    const bad = [
      { licenceStart: "2027-07-01" }, // nach dem Ende
      { modules: ["personen"] },
      { modules: ["mail", "mail"] },
      { licenceStart: "1.7.2026" },
    ];
    for (const extra of bad) {
      expect(
        (await create(h, { ...base, licenceValidUntil: "2027-06-30", ...extra })).statusCode,
        JSON.stringify(extra),
      ).toBe(400);
    }
    const ok = await create(h, {
      ...base,
      licenceValidUntil: "2027-06-30",
      licenceNumber: "L-9999",
      userCount: 99,
    });
    expect(ok.json()).toMatchObject({ licenceNumber: "L-0003", userCount: 0 });
  });

  it("Kundenadmins können weder anlegen noch Lizenzfelder setzen", async () => {
    const h = await makeHarness();
    const res = await h.app.inject({
      method: "POST",
      url: "/admin/customers",
      headers: as("aAdmin"),
      payload: { ...base, licenceValidUntil: "2027-06-30", modules: ["mail"] },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("Benutzer eines Kunden (Chef-Sicht)", () => {
  const seed = (h: Harness) => {
    const oversight = h.platform.oversight as MemoryOversight;
    oversight.seedUsers(TENANT_A, [
      {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Anna Muster",
        email: "anna@example.test",
        totp: "set",
        lastLoginAt: "2026-11-03T08:00:00.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        name: "Ben Beispiel",
        email: "ben@example.test",
        totp: "missing",
        lastLoginAt: null,
      },
    ]);
    oversight.seedUsers(TENANT_B, [
      {
        id: "00000000-0000-4000-8000-000000000003",
        name: "Fremde Person",
        email: "fremd@example.test",
        totp: "set",
        lastLoginAt: null,
      },
    ]);
  };
  const get = (h: Harness, id: string, who: "chef" | "aAdmin" | "bAdmin" = "chef") =>
    h.app.inject({ method: "GET", url: `/admin/customers/${id}/users`, headers: as(who) });

  it("liefert je Benutzer genau fünf Felder und nur die des gewünschten Kunden", async () => {
    const h = await makeHarness();
    seed(h);
    const res = await get(h, TENANT_A);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.items.map((u: { name: string }) => u.name)).toEqual([
      "Anna Muster",
      "Ben Beispiel",
    ]);
    for (const u of body.items) {
      expect(Object.keys(u).sort()).toEqual(["email", "id", "lastLogin", "name", "totp"]);
    }
    expect(body.items[0]).toMatchObject({ totp: "set", lastLogin: "2026-11-03T08:00:00.000Z" });
    expect(body.items[1]).toMatchObject({ totp: "missing", lastLogin: null });
    expect(res.body).not.toContain("fremd@example.test");
  });

  it("verweigert Kundenbenutzer (auch des eigenen Kunden) und Anonyme, unbekannte Kunden sind 404", async () => {
    const h = await makeHarness();
    seed(h);
    expect((await get(h, TENANT_A, "aAdmin")).statusCode).toBe(403);
    expect((await get(h, TENANT_A, "bAdmin")).statusCode).toBe(403);
    expect(
      (await h.app.inject({ method: "GET", url: `/admin/customers/${TENANT_A}/users` })).statusCode,
    ).toBe(401);
    expect((await get(h, "33333333-3333-4333-8333-333333333333")).statusCode).toBe(404);
    expect((await get(h, "keine-uuid")).statusCode).toBe(400);
  });
});

describe("Sicherheit des eigenen Kontos", () => {
  const S1 = "55555555-5555-4555-8555-555555555551";
  const S2 = "55555555-5555-4555-8555-555555555552";
  const CURRENT_HASH = createHash("sha256").update("mein-token").digest("hex");
  const seed = (h: Harness) =>
    (h.platform.oversight as MemoryOversight).seedSecurity(
      chef.accountId,
      {
        passwordChangedAt: "2026-10-01T09:00:00.000Z",
        totpSetUpAt: "2026-09-01T09:00:00.000Z",
        unusedRecoveryCodes: 8,
        sessions: [
          {
            id: S1,
            since: "2026-11-04T08:00:00.000Z",
            current: false,
            device: "Firefox auf Windows",
          },
          { id: S2, since: "2026-11-03T08:00:00.000Z", current: false, device: null },
        ],
        logins: [
          { id: "7", at: "2026-11-04T08:00:00.000Z", method: "totp", success: true },
          { id: "6", at: "2026-11-03T08:00:00.000Z", method: "password_failed", success: false },
        ],
      },
      { [S1]: CURRENT_HASH },
    );
  const security = (h: Harness, headers: Record<string, string> = as("chef")) =>
    h.app.inject({ method: "GET", url: "/admin/account/security", headers });
  const end = (h: Harness, id: string, headers: Record<string, string> = as("chef")) =>
    h.app.inject({ method: "POST", url: `/admin/account/sessions/${id}/end`, headers });
  const withCookie = { ...as("chef"), cookie: "__Host-sid=mein-token" };

  it("zeigt Zeitpunkte, Zahl unbenutzter Codes, Sitzungen und Anmeldungen, ohne Geheimnisse", async () => {
    const h = await makeHarness();
    seed(h);
    const res = await security(h);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      passwordChangedAt: "2026-10-01T09:00:00.000Z",
      totpSetUpAt: "2026-09-01T09:00:00.000Z",
      recoveryCodes: { unused: 8, total: 10 },
      sessions: [
        {
          id: S1,
          since: "2026-11-04T08:00:00.000Z",
          current: false,
          device: "Firefox auf Windows",
        },
        { id: S2, since: "2026-11-03T08:00:00.000Z", current: false, device: null },
      ],
      logins: [
        { id: "7", at: "2026-11-04T08:00:00.000Z", method: "totp", success: true },
        { id: "6", at: "2026-11-03T08:00:00.000Z", method: "password_failed", success: false },
      ],
    });
  });

  it("erkennt die Sitzung der Anfrage am Cookie und beendet sie nicht", async () => {
    const h = await makeHarness();
    seed(h);
    const res = await security(h, withCookie);
    expect(res.json().sessions.map((s: { current: boolean }) => s.current)).toEqual([true, false]);
    expect((await end(h, S1, withCookie)).statusCode).toBe(404);
    expect((await security(h, withCookie)).json().sessions).toHaveLength(2);
  });

  it("beendet eine andere Sitzung, protokolliert es und kennt fremde oder unbekannte IDs nicht", async () => {
    const h = await makeHarness();
    seed(h);
    expect((await end(h, S2, withCookie)).statusCode).toBe(204);
    const left = (await security(h, withCookie)).json().sessions;
    expect(left.map((s: { id: string }) => s.id)).toEqual([S1]);
    expect((await end(h, S2, withCookie)).statusCode).toBe(404);
    expect((await end(h, "66666666-6666-4666-8666-666666666666", withCookie)).statusCode).toBe(404);
    expect((await end(h, "keine-uuid", withCookie)).statusCode).toBe(400);
    const log = await h.platform.platformAudit.query("platform", {}, { limit: 10, offset: 0 });
    expect(log.items.map((e) => [e.actor, e.action])).toEqual([
      ["chef@example.test", "account.end-session"],
    ]);
  });

  it("ist nur für den Chef-Admin da", async () => {
    const h = await makeHarness();
    seed(h);
    expect((await security(h, as("aAdmin"))).statusCode).toBe(403);
    expect((await security(h, {})).statusCode).toBe(401);
    expect((await end(h, S2, as("aAdmin"))).statusCode).toBe(403);
    expect((await end(h, S2, {})).statusCode).toBe(401);
    // Nichts wurde beendet.
    expect((await security(h)).json().sessions).toHaveLength(2);
  });

  it("ein Konto ohne Sicherheitsdaten ist 404", async () => {
    const h = await makeHarness();
    expect((await security(h)).statusCode).toBe(404);
  });
});
