import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { MemoryChefs, MemoryInvitationOutbox } from "./memory.js";
import { createPlatform } from "./index.js";
import type { ChefPrincipal, CustomerPrincipal, Tenant } from "./types.js";

// Gemeinsame Testumgebung: zwei Kunden, je Admin und Benutzer, ein Chef-Admin.
// Die Identität kommt im Test aus dem Header `x-test-principal` (ersetzt das Auth-Modul).

export const TENANT_A = "11111111-1111-4111-8111-111111111111";
export const TENANT_B = "22222222-2222-4222-8222-222222222222";

const customer = (n: number, tenantId: string, role: "admin" | "user"): CustomerPrincipal => ({
  kind: "customer",
  userId: `00000000-0000-4000-8000-00000000000${n}`,
  tenantId,
  email: `person${n}@example.test`,
  role,
});
export const principals = {
  aAdmin: customer(1, TENANT_A, "admin"),
  aUser: customer(2, TENANT_A, "user"),
  bAdmin: customer(3, TENANT_B, "admin"),
  chef: {
    kind: "chef" as const,
    accountId: "00000000-0000-4000-8000-0000000000c1",
    email: "chef@example.test",
  },
};
export const chef: ChefPrincipal = principals.chef;

export const as = (who: keyof typeof principals) => ({ "x-test-principal": who });

const tenant = (id: string, name: string): Tenant => ({
  id,
  name,
  status: "active",
  licenceValidUntil: "2099-12-31",
  createdAt: "2026-01-01T00:00:00.000Z",
  endedAt: null,
});

export async function makeHarness() {
  const clock = { now: new Date("2026-11-04T10:00:00Z") };
  const outbox = new MemoryInvitationOutbox();
  const platform = createPlatform({
    clock: () => clock.now,
    invitationSender: outbox,
    chefs: new MemoryChefs([{ id: chef.accountId, email: chef.email, displayName: "Chef" }]),
    principal: async (request) => {
      const key = request.headers["x-test-principal"];
      return (
        (typeof key === "string" && key in principals
          ? principals[key as keyof typeof principals]
          : null) ?? null
      );
    },
  });
  await platform.tenants.create(tenant(TENANT_A, "Verein A"));
  await platform.tenants.create(tenant(TENANT_B, "Verein B"));
  for (const [key, p] of Object.entries(principals)) {
    if (p.kind !== "customer") continue;
    await platform.users.add({
      id: p.userId,
      tenantId: p.tenantId,
      email: p.email,
      name: key,
      role: p.role,
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  }
  const app = await buildApp(
    loadConfig({ LOG_LEVEL: "silent", RATE_LIMIT_MAX: "10000" }),
    undefined,
    { platform },
  );
  return { app, platform, clock, outbox };
}

// Minimale gültige Bilddateien (Aufbau reicht für die serverseitige Prüfung, kein echtes Bild).
export function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ihdr,
    Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  ]);
}
export function makeJpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]),
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}
