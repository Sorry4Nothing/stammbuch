import type {
  AuditEntryResponse,
  ChefSecurityResponse,
  CustomerResponse,
  CustomerUserResponse,
} from "@stammbuch/shared";
import {
  ApiError,
  CodeRejectedError,
  type AuditRow,
  type ChefAdminService,
  type Customer,
  type CustomerUser,
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
    licenceNumber: c.licenceNumber,
    licenceStart: c.licenceStart,
    contact: c.invitation?.email ?? null,
    userCount: c.userCount,
    modules: c.modules,
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
  function send(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: object,
    signal?: AbortSignal,
  ) {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    const token = csrfToken();
    if (method !== "GET" && token) headers["X-CSRF-Token"] = token;
    return fetchFn(path, {
      method,
      headers,
      credentials: "same-origin",
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  /** Die Antworten stammen von der eigenen API (gleiche Origin) und sind dort mit denselben Schemas geprüft. */
  async function call<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: object,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await send(method, path, body, signal);
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

    createCustomer: (input) =>
      customer("POST", "/admin/customers", {
        name: input.name,
        contactEmail: input.email,
        contactName: `${input.firstName} ${input.lastName}`.trim(),
        licenceValidUntil: input.licenceUntil,
        licenceStart: input.licenceStart,
        modules: input.modules,
      }),

    extendLicence: (id, licenceUntil) =>
      customer("PATCH", `/admin/customers/${encodeURIComponent(id)}`, {
        licenceValidUntil: licenceUntil,
      }),

    changeStatus: (id, action) =>
      customer("POST", `/admin/customers/${encodeURIComponent(id)}/${action}`),

    async customerUsers(id, signal) {
      const page = await call<List<CustomerUserResponse>>(
        "GET",
        `/admin/customers/${encodeURIComponent(id)}/users`,
        undefined,
        signal,
      );
      return page.items.map((u): CustomerUser => ({
        id: u.id,
        name: u.name,
        email: u.email,
        totp: u.totp,
        lastLogin: u.lastLogin,
      }));
    },

    // Der Kunde steht nicht im Pfad: das Ziel bestimmt die API aus dem Benutzer.
    async resetTwoFactor(_customerId, userId, { code, reason, calledBack }) {
      const res = await send("POST", `/auth/admin/users/${encodeURIComponent(userId)}/2fa-reset`, {
        code,
        reason,
        calledBack,
      });
      if (res.status === 401) {
        // 401 heisst hier auch «falscher Code»; nur eine verlorene Sitzung meldet sich ab.
        const data: unknown = await res.json().catch(() => null);
        const error = (data as { error?: { code?: unknown } } | null)?.error;
        if (error?.code === "INVALID_CODE") throw new CodeRejectedError();
        onUnauthorized();
      }
      if (!res.ok) throw new ApiError(res.status);
    },

    endSession: async (id) => {
      await call("POST", `/admin/account/sessions/${encodeURIComponent(id)}/end`);
    },

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
      const [a, s] = await Promise.all([
        call<{ email: string; displayName: string }>("GET", "/admin/account", undefined, signal),
        call<ChefSecurityResponse>("GET", "/admin/account/security", undefined, signal),
      ]);
      return {
        email: a.email,
        displayName: a.displayName,
        passwordChangedAt: s.passwordChangedAt,
        totpSetUpAt: s.totpSetUpAt,
        recoveryCodes: s.recoveryCodes,
        // Das Gerät erfasst die API nicht (es wäre ein Personendatum ohne Nutzen): die Sitzung zeigt ihren Beginn.
        sessions: s.sessions.map((x) => ({
          id: x.id,
          device: null,
          since: x.since,
          current: x.current,
        })),
        logins: s.logins,
      };
    },
  };
}
