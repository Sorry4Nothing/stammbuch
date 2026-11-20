import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../lib/errors.js";
import { type Actor, PERMISSIONS, createInvoicesModule } from "./index.js";
import {
  MemoryInvoiceRepository,
  MemoryReminderRepository,
  MemorySettingsRepository,
} from "./memory.js";
import { deriveBillingSettings } from "./org-sync.js";
import { ORG_QR_IBAN, OTHER_TENANT, TENANT, orgFixture } from "./test-fixtures.js";

describe("deriveBillingSettings", () => {
  it("braucht Name, PLZ, Ort und eine CH/LI-IBAN", () => {
    expect(deriveBillingSettings(TENANT, orgFixture(), null)).toMatchObject({ iban: ORG_QR_IBAN });
    expect(deriveBillingSettings(TENANT, orgFixture({ zip: "" }), null)).toBeNull();
    expect(deriveBillingSettings(TENANT, orgFixture({ city: "" }), null)).toBeNull();
    expect(deriveBillingSettings(TENANT, orgFixture(), null)?.contactLines).toEqual([]);
    expect(deriveBillingSettings(TENANT, orgFixture({}, ""), null)).toBeNull();
    expect(deriveBillingSettings(TENANT, orgFixture({ country: "DE" }), null)).toBeNull();
    // Name länger als im QR-Zahlteil erlaubt: kein Zahlteil ableitbar.
    expect(deriveBillingSettings(TENANT, orgFixture({ name: "x".repeat(80) }), null)).toBeNull();
  });
});

describe("GET /invoices/settings holt fehlende Einstellungen aus der Organisation", () => {
  const authenticate = (req: { headers: Record<string, unknown> }): Promise<Actor | null> => {
    const tenant = req.headers["x-tenant"];
    return Promise.resolve(
      typeof tenant === "string"
        ? { userId: "u1", tenantId: tenant, permissions: new Set(PERMISSIONS) }
        : null,
    );
  };

  async function makeApp(org = orgFixture()) {
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    const mod = createInvoicesModule({
      invoices: new MemoryInvoiceRepository(),
      reminders: new MemoryReminderRepository(),
      settings: new MemorySettingsRepository(),
      organisation: async (id) => (id === TENANT ? org : undefined),
      authenticate,
    });
    await app.register(async (scope) => mod.register(scope));
    return app;
  }

  it("legt sie einmalig an; ein anderer Mandant bekommt 404", async () => {
    const app = await makeApp();
    const mine = await app.inject({
      method: "GET",
      url: "/invoices/settings",
      headers: { "x-tenant": TENANT },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({ creditor: { name: "Verein A" }, iban: ORG_QR_IBAN });
    expect(mine.json().tenantId).toBeUndefined();
    expect(mine.json()).toMatchObject({ vatLiable: true, defaultVatMode: "exclusive" });
    const other = await app.inject({
      method: "GET",
      url: "/invoices/settings",
      headers: { "x-tenant": OTHER_TENANT },
    });
    expect(other.statusCode).toBe(404);
  });

  it("meldet einen nicht mehrwertsteuerpflichtigen Mandanten ohne MwSt-Nummer (#205)", async () => {
    const app = await makeApp(orgFixture({ vatLiable: false, vatNumber: "CHE-123.456.789 MWST" }));
    const res = await app.inject({
      method: "GET",
      url: "/invoices/settings",
      headers: { "x-tenant": TENANT },
    });
    expect(res.json()).toMatchObject({ vatLiable: false, defaultVatMode: "none", vatNumber: null });
  });
});
