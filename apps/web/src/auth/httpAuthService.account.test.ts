import { describe, expect, it, vi } from "vitest";
import { createHttpAuthService } from "./httpAuthService";

type Call = { path: string; method: string; headers: Record<string, string>; body: unknown };

function setup(replies: { status: number; body?: unknown }[]) {
  const calls: Call[] = [];
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
  return { calls, service: createHttpAuthService(fetchFn as unknown as typeof fetch, () => 1000) };
}

const chef = { id: "c1", email: "admin@example.ch", name: "Chef", role: "chief_admin" };

describe("HTTP-AuthService: Rolle, Passwort, Wiederherstellungscodes", () => {
  it("übernimmt die Rolle des Chef-Admins in die Sitzung, die eines Kundenbenutzers nicht", async () => {
    const chefReply = setup([
      { status: 200, body: { state: "authenticated", user: chef, csrfToken: "t" } },
    ]);
    expect((await chefReply.service.restoreSession?.())?.role).toBe("chief_admin");
    const userReply = setup([
      {
        status: 200,
        body: { state: "authenticated", user: { ...chef, role: "user" }, csrfToken: "t" },
      },
    ]);
    expect((await userReply.service.restoreSession?.())?.role).toBeUndefined();
  });

  it("gibt das CSRF-Token der Sitzung heraus", async () => {
    const { service } = setup([
      { status: 200, body: { state: "authenticated", user: chef, csrfToken: "tok" } },
    ]);
    expect(service.csrfToken?.()).toBeNull();
    await service.restoreSession?.();
    expect(service.csrfToken?.()).toBe("tok");
  });

  it("ändert das Passwort und übernimmt das neue CSRF-Token", async () => {
    const { calls, service } = setup([
      { status: 200, body: { state: "authenticated", user: chef, csrfToken: "alt" } },
      { status: 200, body: { user: chef, csrfToken: "neu" } },
    ]);
    await service.restoreSession?.();
    expect(await service.changePassword?.("aktuell", "neues-passwort-123")).toEqual({
      status: "ok",
    });
    expect(calls[1]).toMatchObject({
      path: "/auth/password",
      method: "POST",
      body: { currentPassword: "aktuell", newPassword: "neues-passwort-123" },
    });
    expect(calls[1]?.headers["X-CSRF-Token"]).toBe("alt");
    expect(service.csrfToken?.()).toBe("neu");
  });

  it("unterscheidet falsches Passwort, schwaches Passwort und Sperre", async () => {
    const { service } = setup([
      { status: 401, body: { error: { code: "INVALID_CREDENTIALS" } } },
      { status: 400, body: { error: { code: "WEAK_PASSWORD", message: "Zu kurz." } } },
      { status: 429, body: { error: { code: "RATE_LIMITED" } } },
    ]);
    expect(await service.changePassword?.("a", "b")).toEqual({ status: "invalid" });
    expect(await service.changePassword?.("a", "b")).toEqual({
      status: "weak",
      message: "Zu kurz.",
    });
    expect(await service.changePassword?.("a", "b")).toEqual({ status: "locked" });
  });

  it("richtet den Einmalcode neu ein und bestätigt ihn", async () => {
    const { calls, service } = setup([
      { status: 200, body: { secret: "ABCD", otpauthUri: "otpauth://totp/x" } },
      { status: 401, body: { error: { code: "INVALID_CODE" } } },
      { status: 204 },
      { status: 429, body: { error: { code: "RATE_LIMITED" } } },
    ]);
    expect(await service.beginTotpRenewal?.("123456")).toEqual({
      status: "ok",
      secret: "ABCD",
      otpauthUri: "otpauth://totp/x",
    });
    expect(calls[0]).toMatchObject({ path: "/auth/2fa/renew", body: { code: "123456" } });
    expect(await service.beginTotpRenewal?.("000000")).toEqual({ status: "invalid" });
    expect(await service.confirmTotpRenewal?.("654321")).toEqual({ status: "ok" });
    expect(calls[2]).toMatchObject({ path: "/auth/2fa/renew/confirm", body: { code: "654321" } });
    expect(await service.confirmTotpRenewal?.("654321")).toEqual({ status: "locked" });
  });

  it("erzeugt neue Wiederherstellungscodes", async () => {
    const { calls, service } = setup([
      { status: 200, body: { recoveryCodes: ["AAAA-1111"], remainingRecoveryCodes: 1 } },
      { status: 401, body: { error: { code: "INVALID_CODE" } } },
    ]);
    expect(await service.renewRecoveryCodes?.("123456")).toEqual({
      status: "ok",
      recoveryCodes: ["AAAA-1111"],
    });
    expect(calls[0]).toMatchObject({
      path: "/auth/recovery-codes/renew",
      body: { code: "123456" },
    });
    expect(await service.renewRecoveryCodes?.("000000")).toEqual({ status: "invalid" });
  });
});
