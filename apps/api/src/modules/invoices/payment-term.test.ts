import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../lib/errors.js";
import { type Actor, PERMISSIONS, type Permission, createInvoicesModule } from "./index.js";
import {
  MemoryInvoiceRepository,
  MemoryReminderRepository,
  MemorySettingsRepository,
} from "./memory.js";
import { OTHER_TENANT, TENANT, settingsInput } from "./test-fixtures.js";

// Zahlungsfrist aus den Organisations-Einstellungen (#130): dasselbe Feld `paymentTermDays` wie in den Rechnungseinstellungen.
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
  const put = await app.inject({
    method: "PUT",
    url: "/invoices/settings",
    headers: as(TENANT),
    payload: settingsInput(),
  });
  expect(put.statusCode).toBe(200);
  return app;
}

const term = (
  app: Awaited<ReturnType<typeof makeApp>>,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
) => app.inject({ method: "PUT", url: "/invoices/settings/payment-term", headers, payload });

describe("PUT /invoices/settings/payment-term", () => {
  it("ändert nur die Zahlungsfrist und lässt die übrigen Einstellungen unberührt", async () => {
    const app = await makeApp();
    const before = (
      await app.inject({ method: "GET", url: "/invoices/settings", headers: as(TENANT) })
    ).json();
    const res = await term(app, as(TENANT), { paymentTermDays: 14 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...before, paymentTermDays: 14 });
    expect(res.body).not.toContain(TENANT);
    const after = (
      await app.inject({ method: "GET", url: "/invoices/settings", headers: as(TENANT) })
    ).json();
    expect(after.paymentTermDays).toBe(14);
    expect(after.iban).toBe(before.iban);
  });

  it("nimmt 0 bis 365 Tage und weist alles andere ab", async () => {
    const app = await makeApp();
    for (const days of [0, 365]) {
      expect((await term(app, as(TENANT), { paymentTermDays: days })).statusCode).toBe(200);
    }
    const invalid: Record<string, unknown>[] = [
      { paymentTermDays: -1 },
      { paymentTermDays: 366 },
      { paymentTermDays: 1.5 },
      { paymentTermDays: "30" },
      { paymentTermDays: null },
      {},
      { paymentTermDays: 30, iban: "x" },
    ];
    for (const payload of invalid) {
      expect((await term(app, as(TENANT), payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("verlangt Anmeldung und die Berechtigung für Einstellungen", async () => {
    const app = await makeApp();
    expect((await term(app, {}, { paymentTermDays: 14 })).statusCode).toBe(401);
    expect((await term(app, as(TENANT, "invoices:read"), { paymentTermDays: 14 })).statusCode).toBe(
      403,
    );
  });

  it("trennt Mandanten: ein Mandant ohne Einstellungen kann nichts anlegen, der andere bleibt unverändert", async () => {
    const app = await makeApp();
    const res = await term(app, as(OTHER_TENANT), { paymentTermDays: 7 });
    expect(res.statusCode).toBe(422);
    const own = (
      await app.inject({ method: "GET", url: "/invoices/settings", headers: as(TENANT) })
    ).json();
    expect(own.paymentTermDays).toBe(settingsInput().paymentTermDays);
  });
});
