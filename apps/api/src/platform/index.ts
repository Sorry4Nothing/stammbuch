import {
  MemoryAudit,
  MemoryChefs,
  MemoryInvitationOutbox,
  MemoryInvitations,
  MemoryLogos,
  MemoryOrganisations,
  MemoryTenants,
  MemoryUsers,
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
  return {
    tenants: new MemoryTenants(),
    invitations: new MemoryInvitations(),
    invitationSender: new MemoryInvitationOutbox(),
    users: new MemoryUsers(),
    organisations: new MemoryOrganisations(),
    logos: new MemoryLogos(),
    audit: new MemoryAudit(),
    platformAudit: new MemoryAudit(),
    chefs: new MemoryChefs(),
    principal: async () => null,
    clock: () => new Date(),
    ...overrides,
  };
}
