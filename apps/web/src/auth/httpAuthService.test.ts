import { describe, expect, it, vi } from "vitest";
import { createHttpAuthService } from "./httpAuthService";

type Call = { path: string; method: string; headers: Record<string, string>; body: unknown };

/** Antwortet der Reihe nach; hält die Aufrufe fest. */
function setup(replies: { status: number; body?: unknown; headers?: Record<string, string> }[]) {
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
        headers: reply.headers,
      }),
    );
  });
  return { calls, service: createHttpAuthService(fetchFn as unknown as typeof fetch, () => 1000) };
}

const user = { id: "u1", email: "sabine@example.ch", role: "user" };

describe("HTTP-AuthService", () => {
  it("meldet an: Passwort, dann Code mit dem CSRF-Token der Antwort", async () => {
    const { calls, service } = setup([
      { status: 200, body: { status: "mfa_required", csrfToken: "tok1" } },
      { status: 200, body: { user, csrfToken: "tok2", remainingRecoveryCodes: 8 } },
    ]);
    expect(await service.signIn("sabine@example.ch", "geheim-geheim-1")).toEqual({
      status: "otp_required",
    });
    const result = await service.verifyCode("123456");
    expect(result).toEqual({
      status: "ok",
      session: {
        name: user.email,
        email: user.email,
        organization: "",
        startedAt: 1000,
      },
    });
    expect(calls[0]).toMatchObject({ path: "/auth/login", method: "POST" });
    expect(calls[0]?.body).toEqual({ email: "sabine@example.ch", password: "geheim-geheim-1" });
    expect(calls[1]).toMatchObject({ path: "/auth/2fa", body: { code: "123456" } });
    expect(calls[1]?.headers["X-CSRF-Token"]).toBe("tok1");
  });

  it("leitet bei mfa_setup_required zur Einrichtung weiter", async () => {
    const { service } = setup([
      { status: 200, body: { status: "mfa_setup_required", csrfToken: "t" } },
    ]);
    expect(await service.signIn("a@example.ch", "x")).toEqual({ status: "mfa_setup_required" });
  });

  it("unterscheidet falsche Zugangsdaten und Sperre, ohne Restzahl zu erfinden", async () => {
    const { service } = setup([
      { status: 401, body: { error: { code: "INVALID_CREDENTIALS", message: "geheim" } } },
      { status: 429, headers: { "Retry-After": "90" }, body: { error: { code: "RATE_LIMITED" } } },
    ]);
    expect(await service.signIn("a@example.ch", "x")).toEqual({ status: "invalid" });
    expect(await service.signIn("a@example.ch", "x")).toEqual({
      status: "locked",
      lock: { email: "a@example.ch", until: 1000 + 90_000, cause: "password" },
    });
  });

  it("wertet falsche Codes und Sperre beim zweiten Faktor aus", async () => {
    const { service } = setup([
      { status: 401, body: { error: { code: "INVALID_CODE" } } },
      { status: 429, headers: { "Retry-After": "60" } },
    ]);
    expect(await service.verifyCode("000000")).toEqual({ status: "invalid" });
    expect(await service.verifyRecovery("AAAA-BBBB-CCCC-DDDD")).toMatchObject({
      status: "locked",
      lock: { cause: "code" },
    });
  });

  it("löst die Einladung ein und richtet danach den zweiten Faktor ein", async () => {
    const { calls, service } = setup([
      { status: 200, body: { status: "mfa_setup_required", csrfToken: "t1" } },
      { status: 200, body: { secret: "ABCDEFGH", otpauthUri: "otpauth://totp/x?secret=ABCDEFGH" } },
      {
        status: 200,
        body: { user, csrfToken: "t2", recoveryCodes: ["AAAA-BBBB-CCCC-DDDD"] },
      },
    ]);
    expect(await service.redeemInvitation("tok", "ein-langes-passwort")).toEqual({ status: "ok" });
    expect(await service.beginTotpSetup()).toEqual({
      secret: "ABCDEFGH",
      otpauthUri: "otpauth://totp/x?secret=ABCDEFGH",
    });
    const done = await service.confirmTotpSetup("123456");
    expect(done).toMatchObject({ status: "ok", recoveryCodes: ["AAAA-BBBB-CCCC-DDDD"] });
    expect(calls[0]?.path).toBe("/auth/invitations/redeem");
    expect(calls[1]?.headers["X-CSRF-Token"]).toBe("t1");
    expect(calls[2]?.headers["X-CSRF-Token"]).toBe("t1");
  });

  it("meldet ungültige und schwache Einladungen unterscheidbar, aber ohne Grund", async () => {
    const { service } = setup([
      { status: 400, body: { error: { code: "INVALID_INVITATION", message: "egal" } } },
      { status: 400, body: { error: { code: "WEAK_PASSWORD", message: "Zu kurz." } } },
    ]);
    expect(await service.redeemInvitation("tok", "x")).toEqual({ status: "invalid" });
    expect(await service.redeemInvitation("tok", "x")).toEqual({
      status: "weak",
      message: "Zu kurz.",
    });
  });

  it("wirft bei unerwarteten Antworten, ohne Inhalt der Antwort in der Meldung", async () => {
    const { service } = setup([
      {
        status: 500,
        body: { error: { code: "INTERNAL", message: "Stacktrace password=hunter2" } },
      },
    ]);
    const error = await service.signIn("a@example.ch", "x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("hunter2");
  });

  it("stellt die Sitzung beim Neuladen aus /auth/me wieder her", async () => {
    const authed = setup([
      { status: 200, body: { state: "authenticated", user, csrfToken: "t" } },
      { status: 204 },
    ]);
    expect(await authed.service.restoreSession?.()).toMatchObject({ email: user.email });
    await authed.service.signOut();
    expect(authed.calls[1]).toMatchObject({ path: "/auth/logout", method: "POST" });
    expect(authed.calls[1]?.headers["X-CSRF-Token"]).toBe("t");

    const pending = setup([{ status: 200, body: { state: "pending", csrfToken: "t" } }]);
    expect(await pending.service.restoreSession?.()).toBeNull();
    const none = setup([{ status: 401, body: { error: { code: "UNAUTHENTICATED" } } }]);
    expect(await none.service.restoreSession?.()).toBeNull();
  });

  it("meldet erneut an mit der Adresse der Sitzung", async () => {
    const { calls, service } = setup([
      { status: 200, body: { state: "authenticated", user, csrfToken: "t" } },
      { status: 200, body: { status: "mfa_required", csrfToken: "t2" } },
      { status: 200, body: { user, csrfToken: "t3" } },
    ]);
    await service.restoreSession?.();
    const result = await service.reauthenticate("passwort", "123456");
    expect(result.status).toBe("ok");
    expect(calls[1]?.body).toEqual({ email: user.email, password: "passwort" });
  });

  it("fordert den Link an und setzt das Passwort zurück", async () => {
    const { calls, service } = setup([{ status: 204 }, { status: 204 }, { status: 204 }]);
    await service.requestPasswordReset("a@example.ch");
    expect(calls[0]).toMatchObject({
      path: "/auth/password-reset/request",
      method: "POST",
      body: { email: "a@example.ch" },
    });
    expect(await service.resetPassword("tok", "ein-langes-passwort-42", "123456")).toEqual({
      status: "ok",
    });
    expect(calls[1]?.body).toEqual({
      token: "tok",
      password: "ein-langes-passwort-42",
      code: "123456",
    });
    await service.resetPassword("tok", "ein-langes-passwort-42", "");
    expect(calls[2]?.body).toEqual({ token: "tok", password: "ein-langes-passwort-42" });
  });

  it("unterscheidet beim Zurücksetzen gesperrt, schwach und ungültig", async () => {
    const { service } = setup([
      { status: 429, body: { error: { code: "RATE_LIMITED" } }, headers: { "Retry-After": "60" } },
      { status: 400, body: { error: { code: "WEAK_PASSWORD", message: "Zu einfach." } } },
      { status: 400, body: { error: { code: "INVALID_RESET", message: "x" } } },
      { status: 500 },
    ]);
    expect(await service.resetPassword("t", "p", "")).toEqual({ status: "locked" });
    expect(await service.resetPassword("t", "p", "")).toEqual({
      status: "weak",
      message: "Zu einfach.",
    });
    expect(await service.resetPassword("t", "p", "")).toEqual({ status: "invalid" });
    await expect(service.resetPassword("t", "p", "")).rejects.toThrow();
  });

  it("ändert den Namen mit CSRF-Token und übernimmt den Namen der Sitzung", async () => {
    const { calls, service } = setup([
      {
        status: 200,
        body: { state: "authenticated", user: { ...user, name: "Sabine" }, csrfToken: "t" },
      },
      { status: 200, body: { user: { ...user, name: "Sabine Neu" }, csrfToken: "t" } },
      { status: 400, body: { error: { code: "VALIDATION" } } },
    ]);
    expect(await service.restoreSession?.()).toMatchObject({ name: "Sabine" });
    expect(await service.updateName("Sabine Neu")).toBe("Sabine Neu");
    expect(calls[1]).toMatchObject({
      path: "/auth/me",
      method: "PATCH",
      body: { name: "Sabine Neu" },
    });
    expect(calls[1]?.headers["X-CSRF-Token"]).toBe("t");
    await expect(service.updateName("")).rejects.toThrow();
  });
});
