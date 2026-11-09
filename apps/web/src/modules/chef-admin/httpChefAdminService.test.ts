import { describe, expect, it, vi } from "vitest";
import { createHttpChefAdminService } from "./httpChefAdminService";
import { ApiError, CodeRejectedError } from "./model";

type Call = { path: string; method: string; headers: Record<string, string>; body: unknown };

const customer = {
  id: "5b0b9d2e-6c1f-4a53-9a0a-1d2b3c4d5e6f",
  name: "Verein Beispiel",
  slug: "verein-beispiel",
  status: "active",
  licenceValidUntil: "2026-12-31",
  createdAt: "2026-01-01T00:00:00Z",
  endedAt: null,
  invitation: { email: "sabine.muster@example.ch", status: "pending" },
  licenceNumber: "L-0042",
  licenceStart: "2026-01-01",
  modules: ["mail", "kalender"],
  userCount: 3,
};

function setup(replies: { status: number; body?: unknown }[]) {
  const calls: Call[] = [];
  const onUnauthorized = vi.fn();
  const fetchFn = vi.fn((path: string, init: RequestInit) => {
    const reply = replies.shift();
    if (!reply) throw new Error("keine Antwort vorbereitet");
    calls.push({
      path,
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Promise.resolve(
      new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
      }),
    );
  });
  const service = createHttpChefAdminService({
    csrfToken: () => "csrf-1",
    onUnauthorized,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { calls, service, onUnauthorized };
}

describe("HTTP-Dienst der Anbieter-Verwaltung", () => {
  it("liest die Kundenliste mit Lizenznummer, Beginn, Modulen und Benutzerzahl", async () => {
    const { calls, service } = setup([{ status: 200, body: { items: [customer], total: 1 } }]);
    const page = await service.listCustomers({ q: "bei", status: "active" });
    expect(calls[0]?.path).toBe("/admin/customers?limit=200&q=bei&status=active");
    expect(calls[0]?.headers["X-CSRF-Token"]).toBeUndefined();
    expect(page).toEqual({
      total: 1,
      items: [
        {
          id: customer.id,
          ref: "verein-beispiel",
          name: "Verein Beispiel",
          status: "active",
          licenceUntil: "2026-12-31",
          licenceNumber: "L-0042",
          licenceStart: "2026-01-01",
          contact: "sabine.muster@example.ch",
          userCount: 3,
          modules: ["mail", "kalender"],
        },
      ],
    });
  });

  it("legt einen Kunden an: mit Lizenzbeginn und Modulen, mit CSRF-Token", async () => {
    const { calls, service } = setup([{ status: 201, body: customer }]);
    await service.createCustomer({
      name: "Verein Beispiel",
      firstName: "Sabine",
      lastName: "Muster",
      email: "sabine.muster@example.ch",
      licenceStart: "2026-01-01",
      licenceUntil: "2026-12-31",
      modules: ["mail"],
    });
    expect(calls[0]).toMatchObject({ path: "/admin/customers", method: "POST" });
    expect(calls[0]?.headers["X-CSRF-Token"]).toBe("csrf-1");
    expect(calls[0]?.body).toEqual({
      name: "Verein Beispiel",
      contactEmail: "sabine.muster@example.ch",
      contactName: "Sabine Muster",
      licenceValidUntil: "2026-12-31",
      licenceStart: "2026-01-01",
      modules: ["mail"],
    });
  });

  it("zeigt Altkunden ohne Lizenzdaten mit leeren Feldern", async () => {
    const { service } = setup([
      {
        status: 200,
        body: {
          ...customer,
          invitation: null,
          licenceNumber: null,
          licenceStart: null,
          modules: null,
          userCount: 0,
        },
      },
    ]);
    expect(await service.getCustomer(customer.id)).toMatchObject({
      licenceNumber: null,
      licenceStart: null,
      modules: null,
      contact: null,
      userCount: 0,
    });
  });

  it("ändert Status und Lizenz über die Routen des Chef-Admins", async () => {
    const { calls, service } = setup([
      { status: 200, body: { ...customer, status: "suspended" } },
      { status: 200, body: customer },
    ]);
    expect((await service.changeStatus(customer.id, "suspend")).status).toBe("suspended");
    await service.extendLicence(customer.id, "2027-12-31");
    expect(calls[0]).toMatchObject({
      path: `/admin/customers/${customer.id}/suspend`,
      method: "POST",
    });
    expect(calls[1]).toMatchObject({
      path: `/admin/customers/${customer.id}`,
      method: "PATCH",
      body: { licenceValidUntil: "2027-12-31" },
    });
  });

  it("meldet nur den Status eines Fehlers, nie dessen Inhalt", async () => {
    const { service } = setup([{ status: 409, body: { error: { message: "geheim" } } }]);
    const error = await service.changeStatus(customer.id, "suspend").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).message).not.toContain("geheim");
  });

  it("meldet abgelaufene Sitzungen", async () => {
    const { service, onUnauthorized } = setup([{ status: 401 }]);
    await expect(service.getCustomer(customer.id)).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalled();
  });

  it("holt das Protokoll", async () => {
    const { calls, service } = setup([
      {
        status: 200,
        body: {
          items: [
            {
              id: "a1",
              at: "2026-01-01T00:00:00Z",
              actor: "Chef-Admin",
              action: "customer.create",
              target: "Verein Beispiel",
            },
          ],
          total: 1,
        },
      },
    ]);
    expect(await service.audit({ q: "Verein", limit: 5 })).toHaveLength(1);
    expect(calls[0]?.path).toBe("/admin/audit?limit=5&q=Verein");
  });

  it("liest die Benutzer eines Kunden", async () => {
    const user = {
      id: "6b0b9d2e-6c1f-4a53-9a0a-1d2b3c4d5e6f",
      name: "Claudia Test",
      email: "claudia.test@example.ch",
      totp: "missing",
      lastLogin: null,
    };
    const { calls, service } = setup([{ status: 200, body: { items: [user], total: 1 } }]);
    expect(await service.customerUsers(customer.id)).toEqual([user]);
    expect(calls[0]).toMatchObject({
      path: `/admin/customers/${customer.id}/users`,
      method: "GET",
    });
  });

  it("setzt die 2FA über die Anmelde-API zurück: Code, Grund und Rückruf, mit CSRF-Token", async () => {
    const { calls, service } = setup([{ status: 204 }]);
    await service.resetTwoFactor(customer.id, "u1", {
      code: "123456",
      reason: "Handy verloren",
      calledBack: true,
    });
    expect(calls[0]).toMatchObject({
      path: "/auth/admin/users/u1/2fa-reset",
      method: "POST",
      body: { code: "123456", reason: "Handy verloren", calledBack: true },
    });
    expect(calls[0]?.headers["X-CSRF-Token"]).toBe("csrf-1");
  });

  it("ein falscher Einmalcode meldet nicht ab, eine verlorene Sitzung schon", async () => {
    const input = { code: "123456", reason: "x", calledBack: true };
    const { service, onUnauthorized } = setup([
      { status: 401, body: { error: { code: "INVALID_CODE" } } },
      { status: 401, body: { error: { code: "UNAUTHENTICATED" } } },
      { status: 429 },
    ]);
    await expect(service.resetTwoFactor(customer.id, "u1", input)).rejects.toBeInstanceOf(
      CodeRejectedError,
    );
    expect(onUnauthorized).not.toHaveBeenCalled();
    await expect(service.resetTwoFactor(customer.id, "u1", input)).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    const error = await service.resetTwoFactor(customer.id, "u1", input).catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(429);
  });

  it("liest das Konto mit Sicherheitsstand und beendet eine Sitzung", async () => {
    const security = {
      passwordChangedAt: null,
      totpSetUpAt: "2026-09-01T09:00:00Z",
      recoveryCodes: { unused: 8, total: 10 },
      sessions: [
        { id: "s1", since: "2026-11-04T08:00:00Z", current: true, device: "Firefox auf Windows" },
        { id: "s2", since: "2026-11-03T08:00:00Z", current: false, device: null },
      ],
      logins: [{ id: "7", at: "2026-11-04T08:00:00Z", method: "totp", success: true }],
    };
    const { calls, service } = setup([
      { status: 200, body: { id: "c1", email: "admin@example.ch", displayName: "Chef" } },
      { status: 200, body: security },
      { status: 204 },
    ]);
    expect(await service.account()).toEqual({
      email: "admin@example.ch",
      displayName: "Chef",
      passwordChangedAt: null,
      totpSetUpAt: "2026-09-01T09:00:00Z",
      recoveryCodes: { unused: 8, total: 10 },
      sessions: [
        { id: "s1", device: "Firefox auf Windows", since: "2026-11-04T08:00:00Z", current: true },
        { id: "s2", device: null, since: "2026-11-03T08:00:00Z", current: false },
      ],
      logins: security.logins,
    });
    expect(calls.map((c) => c.path).sort()).toEqual(["/admin/account", "/admin/account/security"]);
    await service.endSession("s2");
    expect(calls[2]).toMatchObject({ path: "/admin/account/sessions/s2/end", method: "POST" });
    expect(calls[2]?.headers["X-CSRF-Token"]).toBe("csrf-1");
  });
});
