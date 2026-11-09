import type { AuditEntryResponse, CustomerResponse } from "@stammbuch/shared";
import {
  ApiError,
  UnsupportedError,
  type AuditRow,
  type ChefAdminService,
  type Customer,
} from "./model";

interface Options {
  /** CSRF-Token der Sitzung für schreibende Anfragen. */
  csrfToken: () => string | null;
  /** Wird bei 401 aufgerufen (Sitzung abgelaufen). */
  onUnauthorized: () => void;
  fetchFn?: typeof fetch;
}

/** Die API lässt höchstens 200 Kunden je Anfrage zu. shortcut: mehr als 200 Kunden bräuchten Seiten vom Server, dann `offset` durchreichen. */
const MAX_CUSTOMERS = 200;

interface List<T> {
  items: T[];
  total: number;
}

function toCustomer(c: CustomerResponse): Customer {
  return {
    id: c.id,
    // Eine Kunden-ID im Format K-0042 gibt es in der API nicht; die Kennung ist stabil und eindeutig.
    ref: c.slug ?? c.id.slice(0, 8),
    name: c.name,
    status: c.status,
    licenceUntil: c.licenceValidUntil,
    licenceNumber: null,
    licenceStart: null,
    contact: c.invitation?.email ?? null,
    userCount: null,
    modules: null,
  };
}

/**
 * `ChefAdminService` gegen die Chef-Admin-Routen der API (`/admin/*`). Gleiche Origin, Cookie-Sitzung,
 * `X-CSRF-Token` bei Schreibzugriffen. Es werden keine Inhalte von Antworten oder Anfragen protokolliert.
 */
export function createHttpChefAdminService({
  csrfToken,
  onUnauthorized,
  fetchFn = (...args) => fetch(...args),
}: Options): ChefAdminService {
  /** Die Antworten stammen von der eigenen API (gleiche Origin) und sind dort mit denselben Schemas geprüft. */
  async function call<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: object,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    const token = csrfToken();
    if (method !== "GET" && token) headers["X-CSRF-Token"] = token;
    const res = await fetchFn(path, {
      method,
      headers,
      credentials: "same-origin",
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    if (res.status === 401) onUnauthorized();
    if (!res.ok) throw new ApiError(res.status);
    if (res.status === 204) return undefined as T;
    const data: unknown = await res.json().catch(() => null);
    if (typeof data !== "object" || data === null) {
      throw new Error(`Unerwartete Antwort der Anbieter-API (${method} ${path.split("?")[0]})`);
    }
    return data as T;
  }

  const customer = async (
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: object,
    signal?: AbortSignal,
  ) => toCustomer(await call<CustomerResponse>(method, path, body, signal));

  return {
    async listCustomers(filter, signal) {
      const params = new URLSearchParams({ limit: String(MAX_CUSTOMERS) });
      if (filter.q) params.set("q", filter.q);
      if (filter.status) params.set("status", filter.status);
      const page = await call<List<CustomerResponse>>(
        "GET",
        `/admin/customers?${params}`,
        undefined,
        signal,
      );
      return { items: page.items.map(toCustomer), total: page.total };
    },

    getCustomer: (id, signal) =>
      customer("GET", `/admin/customers/${encodeURIComponent(id)}`, undefined, signal),

    // Beginn der Lizenz und Module kennt die API beim Anlegen nicht: nur Ende, Name und erste Person.
    createCustomer: (input) =>
      customer("POST", "/admin/customers", {
        name: input.name,
        contactEmail: input.email,
        contactName: `${input.firstName} ${input.lastName}`.trim(),
        licenceValidUntil: input.licenceUntil,
      }),

    extendLicence: (id, licenceUntil) =>
      customer("PATCH", `/admin/customers/${encodeURIComponent(id)}`, {
        licenceValidUntil: licenceUntil,
      }),

    changeStatus: (id, action) =>
      customer("POST", `/admin/customers/${encodeURIComponent(id)}/${action}`),

    // Der Anbieter sieht keine Benutzer der Kunden; die API hat dafür (noch) keine Route.
    customerUsers: async () => null,
    resetTwoFactor: () => Promise.reject(new UnsupportedError()),

    endSession: () => Promise.reject(new UnsupportedError()),

    async audit({ q, limit }, signal) {
      const params = new URLSearchParams({ limit: String(limit) });
      if (q) params.set("q", q);
      const page = await call<List<AuditEntryResponse>>(
        "GET",
        `/admin/audit?${params}`,
        undefined,
        signal,
      );
      return page.items.map((e): AuditRow => ({
        id: e.id,
        at: e.at,
        actor: e.actor,
        action: e.action,
        target: e.target,
      }));
    },

    async account(signal) {
      const a = await call<{ email: string; displayName: string }>(
        "GET",
        "/admin/account",
        undefined,
        signal,
      );
      return {
        email: a.email,
        displayName: a.displayName,
        passwordChangedAt: null,
        totpSetUpAt: null,
        recoveryCodes: null,
        sessions: null,
        logins: null,
      };
    },
  };
}
