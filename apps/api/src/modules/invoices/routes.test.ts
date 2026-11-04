import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { errorHandler } from "../../lib/errors.js";
import { type Actor, PERMISSIONS, type Permission, createInvoicesModule } from "./index.js";
import {
  MemoryInvoiceRepository,
  MemoryReminderRepository,
  MemorySettingsRepository,
} from "./memory.js";
import { OTHER_TENANT, TENANT, invoiceInput, settingsInput } from "./test-fixtures.js";

/** Testnutzer kommen über die Header x-user (Mandant:Rechte). Nur im Test, nie in Produktion. */
function authenticate(req: { headers: Record<string, unknown> }): Promise<Actor | null> {
  const h = req.headers["x-test-actor"];
  if (typeof h !== "string") return Promise.resolve(null);
  const [tenantId, perms] = h.split("|");
  const permissions = new Set(
    (perms === "*" ? [...PERMISSIONS] : (perms ?? "").split(",")) as Permission[],
  );
  return Promise.resolve({ userId: "u1", tenantId: tenantId ?? "", permissions });
}

async function makeApp() {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  const mod = createInvoicesModule({
    invoices: new MemoryInvoiceRepository(),
    reminders: new MemoryReminderRepository(),
    settings: new MemorySettingsRepository(),
    authenticate,
    now: () => new Date("2026-11-04T10:00:00Z"),
  });
  await app.register(async (scope) => mod.register(scope));
  return app;
}

const as = (tenant: string, perms = "*") => ({ "x-test-actor": `${tenant}|${perms}` });

async function withSettings(app: Awaited<ReturnType<typeof makeApp>>, tenant = TENANT) {
  const res = await app.inject({
    method: "PUT",
    url: "/invoices/settings",
    headers: as(tenant),
    payload: settingsInput(),
  });
  expect(res.statusCode).toBe(200);
}

describe("Zugriffsschutz (SR-10, SR-11, SR-12)", () => {
  it("ohne Anmeldung 401 auf jeder Route", async () => {
    const app = await makeApp();
    for (const [method, url] of [
      ["GET", "/invoices"],
      ["POST", "/invoices"],
      ["GET", "/invoices/settings"],
      ["GET", "/invoices/dunning/due"],
      ["POST", "/invoices/collective"],
      ["GET", "/invoices/00000000-0000-4000-8000-000000000001/pdf"],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("Standardverdrahtung der API lehnt alles ab, bis Auth angebunden ist", async () => {
    const app = await buildApp(loadConfig({ LOG_LEVEL: "silent" }));
    expect((await app.inject({ method: "GET", url: "/invoices" })).statusCode).toBe(401);
    await app.close();
  });

  it("Funktionsrechte: fehlende Berechtigung ergibt 403", async () => {
    const app = await makeApp();
    await withSettings(app);
    const readOnly = as(TENANT, "invoices:read");
    expect(
      (await app.inject({ method: "GET", url: "/invoices", headers: readOnly })).statusCode,
    ).toBe(200);
    for (const [method, url, payload] of [
      ["POST", "/invoices", invoiceInput()],
      ["PUT", "/invoices/settings", settingsInput()],
      ["PUT", "/invoices/settings/features", { collectiveInvoicing: true }],
      ["GET", "/invoices/dunning/due", undefined],
    ] as const) {
      const res = await app.inject({ method, url, headers: readOnly, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("fremder Mandant sieht nichts: 404 statt Daten", async () => {
    const app = await makeApp();
    await withSettings(app);
    await withSettings(app, OTHER_TENANT);
    const created = await app.inject({
      method: "POST",
      url: "/invoices",
      headers: as(TENANT),
      payload: invoiceInput(),
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    for (const [method, url] of [
      ["GET", `/invoices/${id}`],
      ["GET", `/invoices/${id}/pdf`],
      ["POST", `/invoices/${id}/send`],
      ["DELETE", `/invoices/${id}`],
    ] as const) {
      const res = await app.inject({ method, url, headers: as(OTHER_TENANT) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    const list = await app.inject({ method: "GET", url: "/invoices", headers: as(OTHER_TENANT) });
    expect(list.json().total).toBe(0);
  });
});

describe("Eingaben (SR-20, SR-72, SR-74)", () => {
  it("lehnt unbekannte Felder, falsche Typen und ungültige IDs ab", async () => {
    const app = await makeApp();
    await withSettings(app);
    const post = (payload: unknown) =>
      app.inject({
        method: "POST",
        url: "/invoices",
        headers: as(TENANT),
        payload: payload as object,
      });
    expect((await post({ ...invoiceInput(), status: "paid" })).statusCode).toBe(400);
    expect((await post({ ...invoiceInput(), tenantId: OTHER_TENANT })).statusCode).toBe(400);
    expect((await post({ ...invoiceInput(), lines: [] })).statusCode).toBe(400);
    expect(
      (
        await post({
          ...invoiceInput(),
          lines: [{ description: "x", quantityMilli: 1, unitCents: 1.5 }],
        })
      ).statusCode,
    ).toBe(400);
    const bad = await app.inject({
      method: "GET",
      url: "/invoices/nicht-eine-uuid",
      headers: as(TENANT),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toBe("Ungültige Anfrage.");
  });

  it("gibt keine Mandanten-ID aus und beschränkt die Seitengrösse", async () => {
    const app = await makeApp();
    await withSettings(app);
    const created = await app.inject({
      method: "POST",
      url: "/invoices",
      headers: as(TENANT),
      payload: invoiceInput(),
    });
    expect(created.body).not.toContain(TENANT);
    expect(created.json().openCents).toBe(0); // Entwurf: noch nichts offen
    const big = await app.inject({
      method: "GET",
      url: "/invoices?limit=1000",
      headers: as(TENANT),
    });
    expect(big.statusCode).toBe(400);
  });
});

describe("Ablauf über HTTP", () => {
  it("Entwurf, versenden, PDF, Zahlung, Gutschrift, Mahnung", async () => {
    const app = await makeApp();
    await withSettings(app);
    const h = as(TENANT);
    const d = (
      await app.inject({ method: "POST", url: "/invoices", headers: h, payload: invoiceInput() })
    ).json();
    const upd = await app.inject({
      method: "PUT",
      url: `/invoices/${d.id}`,
      headers: h,
      payload: { ...invoiceInput({ subject: "Geändert" }), version: d.version },
    });
    expect(upd.statusCode).toBe(200);
    const sent = await app.inject({ method: "POST", url: `/invoices/${d.id}/send`, headers: h });
    expect(sent.json()).toMatchObject({ status: "sent", number: "RE-2026-0001", openCents: 26594 });
    // Gebuchtes lässt sich nicht mehr ändern oder löschen
    const again = await app.inject({
      method: "PUT",
      url: `/invoices/${d.id}`,
      headers: h,
      payload: { ...invoiceInput(), version: 3 },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("CONFLICT");
    expect(
      (await app.inject({ method: "DELETE", url: `/invoices/${d.id}`, headers: h })).statusCode,
    ).toBe(409);

    const pdf = await app.inject({ method: "GET", url: `/invoices/${d.id}/pdf`, headers: h });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["content-disposition"]).toBe('attachment; filename="RE-2026-0001.pdf"');
    expect(pdf.headers["cache-control"]).toBe("no-store");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");

    const due = await app.inject({
      method: "GET",
      url: "/invoices/dunning/due?asOf=2026-12-15",
      headers: h,
    });
    expect(due.json().items).toHaveLength(1);
    const rem = await app.inject({
      method: "POST",
      url: `/invoices/${d.id}/reminders`,
      headers: h,
      payload: { asOf: "2026-12-15" },
    });
    expect(rem.statusCode).toBe(201);
    expect(rem.body).not.toContain(TENANT);
    const remPdf = await app.inject({
      method: "GET",
      url: `/invoices/${d.id}/reminders/1/pdf`,
      headers: h,
    });
    expect(remPdf.statusCode).toBe(200);

    const credit = await app.inject({
      method: "POST",
      url: `/invoices/${d.id}/credit-notes`,
      headers: h,
      payload: {
        lines: [{ description: "Rabatt", quantityMilli: 1000, unitCents: 1000, vatRateBp: 0 }],
      },
    });
    expect(credit.statusCode).toBe(201);
    expect(credit.json().creditedCents).toBe(1000);

    const pay = await app.inject({
      method: "POST",
      url: `/invoices/${d.id}/payments`,
      headers: h,
      payload: { amountCents: 25594, paidOn: "2026-12-16" },
    });
    expect(pay.json().status).toBe("paid");
  });

  it("Sammelrechnung nur nach Freischaltung durch die Lizenzverwaltung", async () => {
    const app = await makeApp();
    await withSettings(app);
    const payload = {
      runId: "33333333-3333-4333-8333-333333333333",
      period: "2027",
      items: [
        {
          memberId: "m1",
          payerKey: "p1",
          payer: invoiceInput().debtor,
          description: "Beitrag",
          amountCents: 5000,
        },
      ],
    };
    const post = (perms: string) =>
      app.inject({
        method: "POST",
        url: "/invoices/collective",
        headers: as(TENANT, perms),
        payload,
      });
    expect((await post("invoices:collective")).statusCode).toBe(403);
    // Ein Mandanten-Admin ohne invoices:features kann das Modul nicht selbst einschalten.
    const self = await app.inject({
      method: "PUT",
      url: "/invoices/settings/features",
      headers: as(TENANT, "invoices:settings,invoices:collective"),
      payload: { collectiveInvoicing: true },
    });
    expect(self.statusCode).toBe(403);
    const on = await app.inject({
      method: "PUT",
      url: "/invoices/settings/features",
      headers: as(TENANT, "invoices:features"),
      payload: { collectiveInvoicing: true },
    });
    expect(on.statusCode).toBe(200);
    const ok = await post("invoices:collective");
    expect(ok.statusCode).toBe(201);
    expect(ok.json().created).toHaveLength(1);
  });
});
