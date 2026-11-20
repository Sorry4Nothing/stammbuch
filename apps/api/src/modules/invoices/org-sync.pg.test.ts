import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncBillingSettings } from "./org-sync.js";
import { ORG_QR_IBAN, OTHER_TENANT, TENANT, orgFixture } from "./test-fixtures.js";
import { PgTestServer } from "./test-pg.js";

// Rechnungseinstellungen aus der Organisation gegen echtes PostgreSQL (RLS, Mandantentrennung).
let server: PgTestServer;
beforeAll(async () => {
  server = await PgTestServer.start();
}, 120_000);
afterAll(() => server?.stop());

describe("syncBillingSettings (PostgreSQL)", () => {
  it("legt die Einstellungen an, bewahrt eigene Werte und trennt Mandanten", async () => {
    const { repos } = await server.newContext();
    expect(await syncBillingSettings(repos.settings, TENANT, orgFixture())).toBe(true);
    const created = await repos.settings.get(TENANT);
    expect(created).toMatchObject({
      creditor: { name: "Verein A", postalCode: "8000", town: "Zürich", country: "CH" },
      iban: ORG_QR_IBAN,
      numberPrefix: "RE",
      paymentTermDays: 30,
    });

    await repos.settings.save({ ...created!, numberPrefix: "VA", paymentTermDays: 14 });
    await syncBillingSettings(repos.settings, TENANT, orgFixture({ city: "Bern" }));
    expect(await repos.settings.get(TENANT)).toMatchObject({
      creditor: { town: "Bern" },
      numberPrefix: "VA",
      paymentTermDays: 14,
    });

    expect(await repos.settings.get(OTHER_TENANT)).toBeNull();
    expect(await syncBillingSettings(repos.settings, OTHER_TENANT, orgFixture({ zip: "" }))).toBe(
      false,
    );
    expect(await repos.settings.get(OTHER_TENANT)).toBeNull();
  });

  it("speichert die Steuerpflicht je Mandant und stellt «exklusiv» beim Rückwechsel wieder her (#205)", async () => {
    const { repos } = await server.newContext();
    const sync = (org = orgFixture()) => syncBillingSettings(repos.settings, TENANT, org);
    await sync();
    expect(await repos.settings.get(TENANT)).toMatchObject({
      vatLiable: true,
      defaultVatMode: "exclusive",
    });

    await sync(orgFixture({ vatLiable: false, vatNumber: "CHE-123.456.789 MWST" }));
    expect(await repos.settings.get(TENANT)).toMatchObject({
      vatLiable: false,
      defaultVatMode: "none",
      vatNumber: null,
    });
    // Anderer Mandant: Standard pflichtig, nichts übernommen.
    expect(await repos.settings.get(OTHER_TENANT)).toBeNull();

    await sync(orgFixture({ vatNumber: "CHE-123.456.789 MWST" }));
    expect(await repos.settings.get(TENANT)).toMatchObject({
      vatLiable: true,
      defaultVatMode: "exclusive",
      vatNumber: "CHE-123.456.789 MWST",
    });
  });
});
