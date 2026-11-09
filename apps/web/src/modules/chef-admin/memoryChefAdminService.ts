import {
  ApiError,
  type AccountOverview,
  type AuditRow,
  type ChefAdminService,
  type Customer,
  type CustomerUser,
} from "./model";

export interface MemoryData {
  customers: Customer[];
  /** Benutzer je Kunden-ID (technische ID). Fehlt der Eintrag, liefert der Dienst `null`. */
  users?: Record<string, CustomerUser[]>;
  audit?: AuditRow[];
  account: AccountOverview;
}

export interface MemoryOptions {
  /** Wird vor jeder Anfrage aufgerufen; wirft, um einen Serverfehler zu simulieren. */
  beforeRequest?: (name: string) => void;
  now?: () => Date;
}

/** In-Memory-Datenquelle für Tests und Entwicklung. Gespeichert wird nur im Speicher. */
export function memoryChefAdminService(
  data: MemoryData,
  options: MemoryOptions = {},
): ChefAdminService & { resets: { userId: string; reason: string; calledBack: boolean }[] } {
  const customers = structuredClone(data.customers);
  const account = structuredClone(data.account);
  const audit = structuredClone(data.audit ?? []);
  const resets: { userId: string; reason: string; calledBack: boolean }[] = [];
  const now = options.now ?? (() => new Date());
  const guard = (name: string) => options.beforeRequest?.(name);
  const find = (id: string) => {
    const c = customers.find((x) => x.id === id);
    if (!c) throw new ApiError(404);
    return c;
  };
  const log = (action: string, target: string) =>
    audit.unshift({
      id: `a${audit.length + 1}`,
      at: now().toISOString(),
      actor: "Chef-Admin",
      action,
      target,
    });

  return {
    resets,

    async listCustomers(filter) {
      guard("listCustomers");
      const q = filter.q?.toLowerCase();
      const items = customers.filter(
        (c) =>
          (!filter.status || c.status === filter.status) &&
          (!q ||
            c.name.toLowerCase().includes(q) ||
            c.ref.toLowerCase().includes(q) ||
            (c.contact ?? "").toLowerCase().includes(q)),
      );
      return { items: structuredClone(items), total: items.length };
    },

    async getCustomer(id) {
      guard("getCustomer");
      return structuredClone(find(id));
    },

    async createCustomer(input) {
      guard("createCustomer");
      const customer: Customer = {
        id: `00000000-0000-4000-8000-${String(customers.length + 1).padStart(12, "0")}`,
        ref: `K-${String(customers.length + 1).padStart(4, "0")}`,
        name: input.name,
        status: "active",
        licenceUntil: input.licenceUntil,
        licenceNumber: null,
        licenceStart: input.licenceStart,
        contact: input.email,
        userCount: 1,
        modules: input.modules,
      };
      customers.unshift(customer);
      log("customer.create", input.name);
      log("customer.invite", input.name);
      return structuredClone(customer);
    },

    async extendLicence(id, licenceUntil) {
      guard("extendLicence");
      const c = find(id);
      c.licenceUntil = licenceUntil;
      log("customer.update", c.name);
      return structuredClone(c);
    },

    async changeStatus(id, action) {
      guard("changeStatus");
      const c = find(id);
      const next = { suspend: "suspended", reactivate: "active", "end-contract": "ended" } as const;
      const from = {
        suspend: ["active"],
        reactivate: ["suspended"],
        "end-contract": ["active", "suspended"],
      };
      if (!from[action].includes(c.status)) throw new ApiError(409);
      c.status = next[action];
      log(`customer.${action}`, c.name);
      return structuredClone(c);
    },

    async customerUsers(id) {
      guard("customerUsers");
      const users = data.users?.[id];
      return users ? structuredClone(users) : null;
    },

    async resetTwoFactor(_customerId, userId, input) {
      guard("resetTwoFactor");
      resets.push({ userId, ...input });
    },

    async audit({ q, limit }) {
      guard("audit");
      const needle = q?.toLowerCase();
      return structuredClone(
        audit.filter((e) => !needle || e.target.toLowerCase().includes(needle)).slice(0, limit),
      );
    },

    async account() {
      guard("account");
      return structuredClone(account);
    },

    async endSession(id) {
      guard("endSession");
      if (account.sessions) account.sessions = account.sessions.filter((x) => x.id !== id);
    },
  };
}
