import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../lib/errors.js";
import { type Actor, PERMISSIONS, createInvoicesModule } from "./index.js";
import {
  MemoryInvoiceRepository,
  MemoryReminderRepository,
  MemorySettingsRepository,
} from "./memory.js";
import { TENANT, invoiceInput, settingsInput } from "./test-fixtures.js";

const actor: Actor = { userId: "u1", tenantId: TENANT, permissions: new Set(PERMISSIONS) };

async function makeApp(audit: (action: string, target?: string) => Promise<void>) {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  const mod = createInvoicesModule({
    invoices: new MemoryInvoiceRepository(),
    reminders: new MemoryReminderRepository(),
    settings: new MemorySettingsRepository(),
    authenticate: async () => actor,
    now: () => new Date("2026-11-04T10:00:00Z"),
    audit: async (who, action, target) => {
      expect(who).toMatchObject({ tenantId: TENANT, userId: "u1" });
      await audit(action, target);
    },
  });
  await app.register(async (scope) => mod.register(scope));
  return app;
}

describe("Kundenprotokoll der Rechnungen (SR-52, SR-50)", () => {
  it("protokolliert Anlegen, Buchen und Stornieren mit der Rechnungs-ID, ohne Inhalt", async () => {
    const entries: [string, string | undefined][] = [];
    const app = await makeApp(async (action, target) => void entries.push([action, target]));
    await app.inject({ method: "PUT", url: "/invoices/settings", payload: settingsInput() });
    const created = await app.inject({ method: "POST", url: "/invoices", payload: invoiceInput() });
    const id = created.json().id as string;
    await app.inject({ method: "POST", url: `/invoices/${id}/send` });
    await app.inject({ method: "POST", url: `/invoices/${id}/cancel`, payload: {} });
    expect(entries).toEqual([
      ["invoice.settings", undefined],
      ["invoice.create", id],
      ["invoice.send", id],
      ["invoice.cancel", id],
    ]);
  });

  it("ein Ausfall des Protokolls bricht die Rechnungsaktion nicht ab", async () => {
    const app = await makeApp(async () => {
      throw new Error("Protokoll nicht erreichbar");
    });
    await app.inject({ method: "PUT", url: "/invoices/settings", payload: settingsInput() });
    const created = await app.inject({ method: "POST", url: "/invoices", payload: invoiceInput() });
    expect(created.statusCode).toBe(201);
  });

  it("protokolliert abgelehnte Aktionen nicht", async () => {
    const entries: string[] = [];
    const app = await makeApp(async (action) => void entries.push(action));
    const res = await app.inject({
      method: "POST",
      url: "/invoices/00000000-0000-4000-8000-000000000001/send",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(entries).toEqual([]);
  });
});
