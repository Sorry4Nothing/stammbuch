import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { errorHandler, notFoundHandler } from "../../lib/errors.js";
import { ORIGIN, setup } from "../auth/auth.testkit.js";
import { MEMORY_TENANT } from "../auth/memory.js";
import { createTasksModule } from "./index.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const UNKNOWN = "99999999-9999-4999-8999-999999999999";
// 2026-11-04 11:00 in Zürich (Winterzeit)
const NOW = new Date("2026-11-04T10:00:00Z");

/** Testnutzer kommen über den Header x-user (Mandant). Nur im Test, nie in Produktion. */
async function makeApp(audit?: (action: string, target: string, tenant: string) => void) {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  await app.register(rateLimit, { max: 1000, timeWindow: "1 minute" });
  const mod = createTasksModule({
    now: () => NOW,
    ...(audit
      ? {
          audit: async (who, action, target) => {
            audit(action, target, who.tenantId);
          },
        }
      : {}),
    authenticate: async (req) => {
      const h = req.headers["x-user"];
      return typeof h === "string" ? { userId: `user-${h}`, tenantId: h } : null;
    },
  });
  await app.register(async (scope) => mod.register(scope));
  return app;
}
type App = Awaited<ReturnType<typeof makeApp>>;

const as = (tenant: string) => ({ "x-user": tenant });
const create = (app: App, tenant: string, title: string, due: string) =>
  app.inject({ method: "POST", url: "/tasks", headers: as(tenant), payload: { title, due } });

describe("Aufgaben", () => {
  it("ohne Anmeldung 401 auf jeder Route; die Standardverdrahtung lehnt alles ab (SR-10, SR-54)", async () => {
    const app = await makeApp();
    for (const [method, url] of [
      ["GET", "/tasks"],
      ["POST", "/tasks"],
      ["POST", `/tasks/${UNKNOWN}/done`],
      ["POST", `/tasks/${UNKNOWN}/reopen`],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHENTICATED");
    }

    const closed = Fastify();
    closed.setErrorHandler(errorHandler);
    await closed.register(async (scope) => createTasksModule().register(scope));
    expect((await closed.inject({ method: "GET", url: "/tasks" })).statusCode).toBe(401);
  });

  it("legt an, listet offene nach Fälligkeit und zählt die fälligen", async () => {
    const app = await makeApp();
    const later = await create(app, A, "Periode abschliessen", "2026-11-30");
    expect(later.statusCode).toBe(201);
    expect(later.json()).toEqual({
      id: expect.any(String),
      title: "Periode abschliessen",
      due: "2026-11-30",
    });
    await create(app, A, "Mahnung versenden", "2026-11-04"); // heute
    await create(app, A, "Duplikate prüfen", "2026-11-01"); // überfällig

    const res = await app.inject({ method: "GET", url: "/tasks", headers: as(A) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toMatchObject({ total: 3, dueCount: 2 });
    expect(res.json().items.map((t: { title: string }) => t.title)).toEqual([
      "Duplikate prüfen",
      "Mahnung versenden",
      "Periode abschliessen",
    ]);
    expect(res.body).not.toContain(A);

    const limited = await app.inject({ method: "GET", url: "/tasks?limit=1", headers: as(A) });
    expect(limited.json()).toMatchObject({ total: 3, dueCount: 2 });
    expect(limited.json().items).toHaveLength(1);
  });

  it("erledigt: verschwindet aus der Liste, ein zweites Mal ist 404", async () => {
    const app = await makeApp();
    const id = (await create(app, A, "Aufgabe", "2026-11-04")).json().id as string;
    const done = await app.inject({ method: "POST", url: `/tasks/${id}/done`, headers: as(A) });
    expect(done.statusCode).toBe(204);
    const list = await app.inject({ method: "GET", url: "/tasks", headers: as(A) });
    expect(list.json()).toEqual({ items: [], total: 0, dueCount: 0 });
    const again = await app.inject({ method: "POST", url: `/tasks/${id}/done`, headers: as(A) });
    expect(again.statusCode).toBe(404);
  });

  it("Rückgängig: eine erledigte Aufgabe wird wieder offen, nur im eigenen Mandanten, protokolliert", async () => {
    const log: string[] = [];
    const app = await makeApp((action, target, tenant) =>
      log.push(`${tenant}|${action}|${target}`),
    );
    const id = (await create(app, A, "Aufgabe", "2026-11-04")).json().id as string;
    const reopen = (tenant: string) =>
      app.inject({ method: "POST", url: `/tasks/${id}/reopen`, headers: as(tenant) });
    expect((await reopen(A)).statusCode).toBe(404); // noch offen
    await app.inject({ method: "POST", url: `/tasks/${id}/done`, headers: as(A) });
    expect((await reopen(B)).statusCode).toBe(404); // fremd
    expect((await reopen(A)).statusCode).toBe(204);
    expect((await reopen(A)).statusCode).toBe(404); // schon wieder offen
    const list = await app.inject({ method: "GET", url: "/tasks", headers: as(A) });
    expect(list.json().total).toBe(1);
    expect(log).toContain(`${A}|aufgabe.wiederoeffnen|${id}`);
    const bad = await app.inject({
      method: "POST",
      url: "/tasks/kein-uuid/reopen",
      headers: as(A),
    });
    expect(bad.statusCode).toBe(400);
  });

  it("listet erledigte Aufgaben, neueste zuerst, nur des eigenen Mandanten", async () => {
    const app = await makeApp();
    const first = (await create(app, A, "Erste", "2026-11-01")).json().id as string;
    const second = (await create(app, A, "Zweite", "2026-11-02")).json().id as string;
    await create(app, A, "Bleibt offen", "2026-11-03");
    const other = (await create(app, B, "Fremde", "2026-11-01")).json().id as string;
    for (const [tenant, id] of [
      [A, first],
      [A, second],
      [B, other],
    ] as const) {
      await app.inject({ method: "POST", url: `/tasks/${id}/done`, headers: as(tenant) });
    }
    const res = await app.inject({ method: "GET", url: "/tasks?status=done", headers: as(A) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as { items: { title: string; doneAt: string }[]; total: number };
    expect(body.total).toBe(2);
    expect(body.items.map((t) => t.title).sort()).toEqual(["Erste", "Zweite"]);
    expect(body.items[0]?.doneAt).toBe(NOW.toISOString());
    expect(res.body).not.toMatch(/Fremde|tenant|createdBy/);
    expect(
      (await app.inject({ method: "GET", url: "/tasks?status=gestern", headers: as(A) }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({ method: "GET", url: "/tasks?status=done&limit=1", headers: as(A) })
      ).json().items,
    ).toHaveLength(1);
  });

  it("protokolliert Anlegen und Erledigen mit der ID, nie mit dem Titel (SR-50, SR-52)", async () => {
    const log: string[] = [];
    const app = await makeApp((action, target, tenant) =>
      log.push(`${tenant}|${action}|${target}`),
    );
    const id = (await create(app, A, "Vertrauliche Sache", "2026-11-04")).json().id as string;
    await create(app, A, "", "2026-11-04"); // ungültig: kein Eintrag
    await app.inject({ method: "POST", url: `/tasks/${id}/done`, headers: as(A) });
    await app.inject({ method: "POST", url: `/tasks/${id}/done`, headers: as(A) }); // 404: kein Eintrag
    await app.inject({ method: "POST", url: `/tasks/${id}/done`, headers: as(B) }); // fremd: kein Eintrag
    expect(log).toEqual([`${A}|aufgabe.anlegen|${id}`, `${A}|aufgabe.erledigen|${id}`]);
    expect(log.join()).not.toContain("Vertrauliche");
  });

  it("fremder Mandant sieht und erledigt nichts (SR-11)", async () => {
    const app = await makeApp();
    const id = (await create(app, A, "Nur für A", "2026-11-04")).json().id as string;
    const other = await app.inject({ method: "GET", url: "/tasks", headers: as(B) });
    expect(other.json()).toEqual({ items: [], total: 0, dueCount: 0 });
    const foreign = await app.inject({ method: "POST", url: `/tasks/${id}/done`, headers: as(B) });
    expect(foreign.statusCode).toBe(404);
    const still = await app.inject({ method: "GET", url: "/tasks", headers: as(A) });
    expect(still.json().total).toBe(1);
  });

  it("lehnt ungültige Eingaben ab und übernimmt keine fremden Felder (SR-20, SR-72)", async () => {
    const app = await makeApp();
    for (const payload of [
      {},
      { title: "", due: "2026-11-04" },
      { title: "   ", due: "2026-11-04" },
      { title: "x".repeat(201), due: "2026-11-04" },
      { title: "Zeile\nzwei", due: "2026-11-04" },
      { title: "Ok", due: "04.11.2026" },
      { title: "Ok", due: "2026-02-30" },
      { title: "Ok", due: "2026-11-04", tenantId: B },
      { title: "Ok", due: "2026-11-04", id: UNKNOWN },
    ]) {
      const res = await app.inject({ method: "POST", url: "/tasks", headers: as(A), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    for (const url of ["/tasks/kein-uuid/done", "/tasks/123/done"]) {
      const res = await app.inject({ method: "POST", url, headers: as(A) });
      expect(res.statusCode, url).toBe(400);
    }
    for (const q of ["limit=0", "limit=201", "limit=x"]) {
      const res = await app.inject({ method: "GET", url: `/tasks?${q}`, headers: as(A) });
      expect(res.statusCode, q).toBe(400);
    }
    expect((await app.inject({ method: "GET", url: "/tasks", headers: as(A) })).json().total).toBe(
      0,
    );
  });

  it("Zählung der Fälligkeit folgt der Schweizer Ortszeit", async () => {
    // 23:30 UTC am 4.11. ist 00:30 am 5.11. in Zürich.
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    const mod = createTasksModule({
      now: () => new Date("2026-11-04T23:30:00Z"),
      authenticate: async () => ({ userId: "u", tenantId: A }),
    });
    await app.register(async (scope) => mod.register(scope));
    await app.inject({
      method: "POST",
      url: "/tasks",
      payload: { title: "Heute", due: "2026-11-05" },
    });
    const res = await app.inject({ method: "GET", url: "/tasks" });
    expect(res.json().dueCount).toBe(1);
  });
});

describe("Aufgaben mit echter Anmeldung (Sitzung und CSRF, SR-02, SR-70)", () => {
  it("verlangt volle Sitzung, CSRF-Token und eigene Origin für schreibende Anfragen", async () => {
    const t = await setup();
    try {
      await t.addUser("anna@verein.test");
      const none = await t.req("GET", "/tasks");
      expect(none.statusCode).toBe(401);

      const e = await t.enroll("anna@verein.test");
      const body = { title: "Aufgabe", due: "2026-11-04" };
      const okHeaders = { origin: ORIGIN };

      expect((await t.req("GET", "/tasks", e.c)).statusCode).toBe(200);
      // Ohne oder mit falschem CSRF-Token, mit fremder Origin: abgelehnt, nichts angelegt.
      expect(
        (await t.req("POST", "/tasks", { cookie: e.c.cookie, csrf: undefined }, body, okHeaders))
          .statusCode,
      ).toBe(401);
      expect(
        (await t.req("POST", "/tasks", { cookie: e.c.cookie, csrf: "falsch" }, body, okHeaders))
          .statusCode,
      ).toBe(401);
      expect(
        (await t.req("POST", "/tasks", e.c, body, { origin: "https://boese.example" })).statusCode,
      ).toBe(401);
      expect((await t.req("GET", "/tasks", e.c)).json().total).toBe(0);

      const created = await t.req("POST", "/tasks", e.c, body, okHeaders);
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;
      expect((await t.req("POST", `/tasks/${id}/done`, e.c, undefined, okHeaders)).statusCode).toBe(
        204,
      );
      // Das Protokoll des Kunden hält beide Schritte fest: Akteur und Aufgaben-ID, kein Titel.
      const entries = (await t.platform.audit.query(MEMORY_TENANT, {}, { limit: 50, offset: 0 }))
        .items;
      const mine = entries.filter((x) => x.action.startsWith("aufgabe."));
      expect(mine.map((x) => [x.action, x.target]).sort()).toEqual([
        ["aufgabe.anlegen", id],
        ["aufgabe.erledigen", id],
      ]);
      expect(JSON.stringify(mine)).not.toContain('Aufgabe"');
    } finally {
      await t.app.close();
    }
  });
});
