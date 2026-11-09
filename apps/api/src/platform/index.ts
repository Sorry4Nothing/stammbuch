import {
  MemoryAudit,
  MemoryChefs,
  MemoryInvitationOutbox,
  MemoryInvitations,
  MemoryLogos,
  MemoryOrganisations,
  MemoryOversight,
  MemoryTenants,
  MemoryUsers,
  noRotation,
} from "./memory.js";
import type { Platform } from "./types.js";

export * from "./access.js";
export * from "./helpers.js";
export * from "./licence.js";
export type * from "./types.js";

/**
 * Baut die Persistenz-Schnittstellen. Standard sind In-Memory-Implementierungen und ein
 * Resolver, der niemanden anmeldet (alles bleibt 401, fail secure). Das Auth-Modul (#4)
 * setzt `principal`, die Datenbankschicht (#3) ersetzt die Repositories.
 */
export function createPlatform(overrides: Partial<Platform> = {}): Platform {
  const users = overrides.users ?? new MemoryUsers();
  return {
    tenants: new MemoryTenants(users),
    invitations: new MemoryInvitations(),
    invitationSender: new MemoryInvitationOutbox(),
    users,
    oversight: new MemoryOversight(),
    organisations: new MemoryOrganisations(),
    logos: new MemoryLogos(),
    audit: new MemoryAudit(),
    platformAudit: new MemoryAudit(),
    chefs: new MemoryChefs(),
    rotation: noRotation,
    principal: async () => null,
    clock: () => new Date(),
    ...overrides,
  };
}
