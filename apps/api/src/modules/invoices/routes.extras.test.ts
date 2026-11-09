import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../lib/errors.js";
import { createMemoryStore as createPeople } from "../people/memory.js";
import { MemoryGroupFeeStore, createCollectiveSource } from "./collective.js";
import { type Actor, PERMISSIONS, type Permission, createInvoicesModule } from "./index.js";
import type { InvoiceMail, InvoiceMailPort } from "./mail-port.js";
import {
  MemoryInvoiceRepository,
  MemoryReminderRepository,
  MemorySettingsRepository,
} from "./memory.js";
import { OTHER_TENANT, TENANT, invoiceInput, settingsInput } from "./test-fixtures.js";

// Routen aus #109: Anmeldung, Rechte, Mandantentrennung, Eingaben und Ablauf über HTTP. CSRF und Origin prüft
// `app.authenticateRequest` zentral für alle schreibenden Routen (siehe app.ts); die Routen hier hängen am selben
// `onRequest`-Hook wie die übrigen, ohne Anmeldung antwortet jede mit 401.
function authenticate(req: { headers: Record<string, unknown> }): Promise<Actor | null> {
  const h = req.headers["x-test-actor"];
  if (typeof h !== "string") return Promise.resolve(null);
  const [tenantId, perms] = h.split("|");
  const permissions = new Set(
    (perms === "*" ? [...PERMISSIONS] : (perms ?? "").split(",")) as Permission[],
  );
  return Promise.resolve({ userId: "u1", tenantId: tenantId ?? "", permissions });
}

const as = (tenant: string, perms = "*") => ({ "x-test-actor": `${tenant}|${perms}` });
const ID = "00000000-0000-4000-8000-000000000001";
const GROUP = "00000000-0000-4000-8000-0000000000a1";

async function makeApp(options: { withMail?: boolean } = {}) {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  const sent: InvoiceMail[] = [];
  const mail: InvoiceMailPort = {
    send: async (_from, m) => {
      sent.push(m);
    },
  };
  const people = createPeople();
  await people.gruppen.insert({
    id: GROUP,
    kundeId: TENANT,
    name: "Aktive",
    beschreibung: null,
    erstelltAm: new Date(0),
    geaendertAm: new Date(0),
  });
  const mod = createInvoicesModule({
    invoices: new MemoryInvoiceRepository(),
    reminders: new MemoryReminderRepository(),
    settings: new MemorySettingsRepository(),
    collective: createCollectiveSource(people, new MemoryGroupFeeStore()),
    ...(options.withMail === false ? {} : { mail }),
    authenticate,
    now: () => new Date("2026-11-04T10:00:00Z"),
  });
  await app.register(async (scope) => mod.register(scope));
  const settings = await app.inject({
    method: "PUT",
    url: "/invoices/settings",
    headers: as(TENANT),
    payload: settingsInput(),
  });
  expect(settings.statusCode).toBe(200);
  return { app, sent };
}

async function sentInvoice(app: Awaited<ReturnType<typeof makeApp>>["app"]) {
  const d = (
    await app.inject({
      method: "POST",
      url: "/invoices",
      headers: as(TENANT),
      payload: invoiceInput({ customerId: "K1" }),
    })
  ).json();
  return (
    await app.inject({ method: "POST", url: `/invoices/${d.id}/send`, headers: as(TENANT) })
  ).json();
}

const config = {
  year: 2027,
  issueDate: "2026-12-01",
  termDays: 30,
  text: "Mitgliederbeitrag 2027",
  delivery: "print",
  skipLeft: true,
  skipNoFee: true,
  groupIds: [GROUP],
};
const email = { to: "erika@example.test", subject: "Rechnung", message: "Guten Tag" };

const NEW_ROUTES = [
  ["POST", `/invoices/${ID}/email`],
  ["POST", `/invoices/${ID}/reminders/1/email`],
  ["GET", `/invoices/${ID}/bookings`],
  ["POST", "/invoices/export"],
  ["PUT", "/invoices/settings/dunning"],
  ["GET", "/invoices/collective/setup"],
  ["PUT", `/invoices/collective/groups/${GROUP}/fee`],
  ["POST", "/invoices/collective/preview"],
  ["POST", "/invoices/collective/run"],
] as const;

describe("Zugriffsschutz der neuen Routen (SR-10, SR-11, SR-12)", () => {
  it("ohne Anmeldung 401 auf jeder Route", async () => {
    const { app } = await makeApp();
    for (const [method, url] of NEW_ROUTES) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("ohne die Funktionsrechte 403", async () => {
    const { app } = await makeApp();
    // Nur lesen: weder mailen noch Mahnstufen ändern noch Sammelrechnung
    const readOnly = as(TENANT, "invoices:read");
    for (const [method, url] of NEW_ROUTES.filter(
      ([m, u]) => !(m === "POST" && u === "/invoices/export") && !u.endsWith("/bookings"),
    )) {
      const res = await app.inject({ method, url, headers: readOnly, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    // Der Lauf bucht Rechnungen: das Sammelrecht allein reicht nicht
    const run = await app.inject({
      method: "POST",
      url: "/invoices/collective/run",
      headers: as(TENANT, "invoices:collective"),
      payload: { runId: ID, config },
    });
    expect(run.statusCode).toBe(403);
  });

  it("fremder Mandant: 404 statt Daten, Export leer", async () => {
    const { app, sent } = await makeApp();
    const inv = await sentInvoice(app);
    const other = as(OTHER_TENANT);
    for (const [method, url, payload] of [
      ["POST", `/invoices/${inv.id}/email`, email],
      ["GET", `/invoices/${inv.id}/bookings`, undefined],
    ] as const) {
      const res = await app.inject({ method, url, headers: other, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(sent).toHaveLength(0);
    const xlsx = await app.inject({
      method: "POST",
      url: "/invoices/export",
      headers: other,
      payload: { ids: [inv.id] },
    });
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.rawPayload.length).toBeGreaterThan(0);
  });
});

describe("Eingaben", () => {
  it("lehnt unbekannte Felder, ungültige Adressen und Beträge ab", async () => {
    const { app } = await makeApp();
    const inv = await sentInvoice(app);
    const h = as(TENANT);
    const post = (url: string, payload: object, method: "POST" | "PUT" = "POST") =>
      app.inject({ method, url, headers: h, payload });
    expect(
      (await post(`/invoices/${inv.id}/email`, { ...email, to: "keine-adresse" })).statusCode,
    ).toBe(400);
    expect(
      (await post(`/invoices/${inv.id}/email`, { ...email, bcc: "x@example.test" })).statusCode,
    ).toBe(400);
    expect((await post(`/invoices/${inv.id}/email`, { ...email, subject: "" })).statusCode).toBe(
      400,
    );
    expect((await post(`/invoices/${inv.id}/cancel`, { reason: "x", extra: 1 })).statusCode).toBe(
      400,
    );
    expect((await post("/invoices/export", { ids: ["kaputt"] })).statusCode).toBe(400);
    expect((await post("/invoices/settings/dunning", { levels: [] }, "PUT")).statusCode).toBe(400);
    expect(
      (await post(`/invoices/collective/groups/${GROUP}/fee`, { feeCents: 0 }, "PUT")).statusCode,
    ).toBe(400);
    expect(
      (await post(`/invoices/collective/groups/${GROUP}/fee`, { feeCents: 1.5 }, "PUT")).statusCode,
    ).toBe(400);
    expect((await post("/invoices/collective/preview", { ...config, year: 1 })).statusCode).toBe(
      400,
    );
    expect(
      (await post("/invoices/collective/preview", { ...config, tenantId: TENANT })).statusCode,
    ).toBe(400);
    expect((await post("/invoices/collective/run", { runId: "nein", config })).statusCode).toBe(
      400,
    );
  });
});

describe("Ablauf über HTTP", () => {
  it("versendet Rechnung und Mahnung per E-Mail mit PDF, Antwort 202 ohne Mandanten-ID", async () => {
    const { app, sent } = await makeApp();
    const inv = await sentInvoice(app);
    const h = as(TENANT);
    const res = await app.inject({
      method: "POST",
      url: `/invoices/${inv.id}/email`,
      headers: h,
      payload: email,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ queued: true });
    expect(sent[0]?.attachment.filename).toBe("RE-2026-0001.pdf");

    await app.inject({
      method: "POST",
      url: `/invoices/${inv.id}/reminders`,
      headers: h,
      payload: { asOf: "2026-12-15" },
    });
    const rem = await app.inject({
      method: "POST",
      url: `/invoices/${inv.id}/reminders/1/email`,
      headers: h,
      payload: email,
    });
    expect(rem.statusCode).toBe(202);
    expect(sent[1]?.attachment.filename).toBe("mahnung-1-RE-2026-0001.pdf");
  });

  it("ohne Mail-Anbindung eine feste Meldung (422), ohne Interna", async () => {
    const { app } = await makeApp({ withMail: false });
    const inv = await sentInvoice(app);
    const res = await app.inject({
      method: "POST",
      url: `/invoices/${inv.id}/email`,
      headers: as(TENANT),
      payload: email,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toEqual({
      code: "UNPROCESSABLE",
      message: "Der E-Mail-Versand ist nicht eingerichtet.",
    });
  });

  it("storniert mit Grund und Bemerkung; ohne Body wie bisher", async () => {
    const { app } = await makeApp();
    const a = await sentInvoice(app);
    const h = as(TENANT);
    const res = await app.inject({
      method: "POST",
      url: `/invoices/${a.id}/cancel`,
      headers: h,
      payload: { reason: "Doppelt erstellt", remark: "Siehe RE-2026-0002" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("cancelled");
    const b = await sentInvoice(app);
    expect(
      (await app.inject({ method: "POST", url: `/invoices/${b.id}/cancel`, headers: h }))
        .statusCode,
    ).toBe(200);
  });

  it("liefert die Rechnungsliste als XLSX und die Mahnstufen speichern sich", async () => {
    const { app } = await makeApp();
    await sentInvoice(app);
    const h = as(TENANT);
    const x = await app.inject({
      method: "POST",
      url: "/invoices/export",
      headers: h,
      payload: {},
    });
    expect(x.statusCode).toBe(200);
    expect(x.headers["content-type"]).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(x.headers["content-disposition"]).toBe('attachment; filename="rechnungen.xlsx"');
    expect(x.headers["cache-control"]).toBe("no-store");
    expect(x.rawPayload.subarray(0, 2).toString()).toBe("PK");

    const levels = [{ level: 1, title: "Erinnerung", waitDays: 3, graceDays: 7, feeCents: 0 }];
    const put = await app.inject({
      method: "PUT",
      url: "/invoices/settings/dunning",
      headers: h,
      payload: { levels },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().dunning.levels).toEqual(levels);
    expect(put.body).not.toContain(TENANT);
    const bad = await app.inject({
      method: "PUT",
      url: "/invoices/settings/dunning",
      headers: h,
      payload: { levels: [{ ...levels[0], level: 2 }] },
    });
    expect(bad.statusCode).toBe(422);
  });

  it("zeigt Buchungen (leer ohne Buchhaltung)", async () => {
    const { app } = await makeApp();
    const inv = await sentInvoice(app);
    const res = await app.inject({
      method: "GET",
      url: `/invoices/${inv.id}/bookings`,
      headers: as(TENANT),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });

  it("Sammelrechnung nach Gruppen: erst nach Freischaltung, dann Beitrag, Vorschau", async () => {
    const { app } = await makeApp();
    const h = as(TENANT);
    expect(
      (await app.inject({ method: "GET", url: "/invoices/collective/setup", headers: h }))
        .statusCode,
    ).toBe(403);
    await app.inject({
      method: "PUT",
      url: "/invoices/settings/features",
      headers: h,
      payload: { collectiveInvoicing: true },
    });
    const fee = await app.inject({
      method: "PUT",
      url: `/invoices/collective/groups/${GROUP}/fee`,
      headers: h,
      payload: { feeCents: 12000 },
    });
    expect(fee.json()).toEqual({ id: GROUP, feeCents: 12000 });
    const setup = (
      await app.inject({ method: "GET", url: "/invoices/collective/setup", headers: h })
    ).json();
    expect(setup.groups).toEqual([{ id: GROUP, name: "Aktive", feeCents: 12000, persons: 0 }]);
    const preview = await app.inject({
      method: "POST",
      url: "/invoices/collective/preview",
      headers: h,
      payload: config,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ count: 0, dueDate: "2026-12-31" });
    const run = await app.inject({
      method: "POST",
      url: "/invoices/collective/run",
      headers: h,
      payload: { runId: ID, config },
    });
    expect(run.statusCode).toBe(422); // niemand zu verrechnen
    const unknown = await app.inject({
      method: "PUT",
      url: "/invoices/collective/groups/00000000-0000-4000-8000-0000000000ff/fee",
      headers: h,
      payload: { feeCents: 100 },
    });
    expect(unknown.statusCode).toBe(404);
  });
});
