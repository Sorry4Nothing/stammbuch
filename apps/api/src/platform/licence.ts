import type { LicenceResponse } from "@stammbuch/shared";
import type { Tenant } from "./types.js";

/** Heutiges Datum (YYYY-MM-DD) in der Schweiz. Die Lizenz gilt bis einschliesslich ihres letzten Tags. */
export function zurichDate(now: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(now);
}

/**
 * Lizenzzustand eines Kunden.
 * - active: voller Zugriff
 * - expired (Lizenz abgelaufen) und ended (Vertragsende): Nur-Lesen, alle schreibenden Routen gesperrt
 * - suspended (gesperrt): jeder Zugriff gesperrt, nur die Lizenzanzeige bleibt erreichbar
 */
export function licenceOf(tenant: Tenant, now: Date): LicenceResponse {
  const base = { customerId: tenant.id, validUntil: tenant.licenceValidUntil };
  if (tenant.status === "suspended")
    return { ...base, state: "suspended", readOnly: true, blocked: true };
  if (tenant.status === "ended") return { ...base, state: "ended", readOnly: true, blocked: false };
  if (zurichDate(now) > tenant.licenceValidUntil) {
    return { ...base, state: "expired", readOnly: true, blocked: false };
  }
  return { ...base, state: "active", readOnly: false, blocked: false };
}
