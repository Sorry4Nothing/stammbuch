import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TENANT_A, as, makeHarness } from "../../platform/platform.testkit.js";

type Harness = Awaited<ReturnType<typeof makeHarness>>;
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
    expect(Object.keys(body).sort()).toEqual([
      "createdAt",
      "endedAt",
      "id",
      "invitation",
      "licenceValidUntil",
      "name",
      "status",
    ]);
    expect(body).toMatchObject({
      name: "Neuer Verein",
      status: "active",
      invitation: { email: "kontakt@example.test", status: "pending" },
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
    await h.platform.tenants.update(TENANT_A, { status: "suspended" });
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
      bank: { bankName: "", iban: "", qrIban: "", bic: "" },
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
      expect(Object.keys(item).sort()).toEqual([
        "createdAt",
        "endedAt",
        "id",
        "invitation",
        "licenceValidUntil",
        "name",
        "status",
      ]);
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
