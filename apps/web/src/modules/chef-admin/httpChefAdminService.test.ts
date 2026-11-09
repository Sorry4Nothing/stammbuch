import { describe, expect, it, vi } from "vitest";
import { createHttpChefAdminService } from "./httpChefAdminService";
import { ApiError, UnsupportedError } from "./model";

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
  it("liest die Kundenliste und zeigt Vertragsdaten, fehlende Felder bleiben leer", async () => {
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
          licenceNumber: null,
          licenceStart: null,
          contact: "sabine.muster@example.ch",
          userCount: null,
          modules: null,
        },
      ],
    });
  });

  it("legt einen Kunden an: nur Felder, die die API kennt, mit CSRF-Token", async () => {
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

  it("holt Protokoll und Konto; Benutzer und 2FA-Reset gibt es für den Anbieter nicht", async () => {
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
      { status: 200, body: { id: "c1", email: "admin@example.ch", displayName: "Chef" } },
    ]);
    expect(await service.audit({ q: "Verein", limit: 5 })).toHaveLength(1);
    expect(calls[0]?.path).toBe("/admin/audit?limit=5&q=Verein");
    expect((await service.account()).email).toBe("admin@example.ch");
    expect(await service.customerUsers(customer.id)).toBeNull();
    await expect(
      service.resetTwoFactor(customer.id, "u1", { reason: "x", calledBack: true }),
    ).rejects.toBeInstanceOf(UnsupportedError);
  });
});
