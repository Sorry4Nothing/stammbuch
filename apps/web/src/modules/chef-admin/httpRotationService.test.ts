import { describe, expect, it, vi } from "vitest";
import { createHttpRotationService } from "./httpRotationService";
import { ApiError, CodeRejectedError } from "./model";
import { RotationLimitError, RotationLockedError } from "./rotationModel";

const ID = "44444444-4444-4444-8444-444444444444";

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Call = { path: string; init: RequestInit };

function setup(replies: Reply[]) {
  const calls: Call[] = [];
  const onUnauthorized = vi.fn();
  const fetchFn = vi.fn((path: string, init: RequestInit) => {
    const reply = replies.shift();
    if (!reply) throw new Error("keine Antwort vorbereitet");
    calls.push({ path, init });
    return Promise.resolve(
      new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
        ...(reply.headers ? { headers: reply.headers } : {}),
      }),
    );
  });
  const service = createHttpRotationService({
    csrfToken: () => "csrf-1",
    onUnauthorized,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { calls, service, onUnauthorized };
}

describe("HTTP-Dienst der Schlüsselrotation", () => {
  it("liest den Stand ohne CSRF-Token und ohne Angaben in der URL", async () => {
    const { calls, service } = setup([
      {
        status: 200,
        body: {
          mail: { configured: true, lastRunAt: "2026-11-05T10:00:00.000Z", unreadable: [ID] },
          totp: { configured: false, lastRunAt: null, unreadable: [] },
        },
      },
    ]);
    expect(await service.status()).toEqual({
      mail: { configured: true, lastRunAt: "2026-11-05T10:00:00.000Z", unreadable: [ID] },
      totp: { configured: false, lastRunAt: null, unreadable: [] },
    });
    expect(calls[0]?.path).toBe("/admin/rotation");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.credentials).toBe("same-origin");
    expect(JSON.stringify(calls[0]?.init.headers)).not.toContain("csrf-1");
  });

  it("startet mit Einmalcode im Body und CSRF-Token, nie in der URL", async () => {
    const { calls, service } = setup([
      {
        status: 200,
        body: {
          mail: { rotated: 3, failed: [ID], aborted: false },
          totp: null,
        },
      },
    ]);
    expect(await service.run("123456")).toEqual({
      mail: { rotated: 3, failed: [ID], aborted: false },
      totp: null,
    });
    const call = calls[0]!;
    expect(call.path).toBe("/admin/rotation");
    expect(call.init.method).toBe("POST");
    expect(call.init.body).toBe(JSON.stringify({ code: "123456" }));
    expect((call.init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("csrf-1");
  });

  it("meldet einen abgelehnten Code, ohne die Sitzung zu beenden", async () => {
    const { service, onUnauthorized } = setup([
      { status: 401, body: { error: { code: "INVALID_CODE", message: "Code ungültig." } } },
    ]);
    await expect(service.run("123456")).rejects.toBeInstanceOf(CodeRejectedError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("beendet die Sitzung bei jedem anderen 401", async () => {
    const { service, onUnauthorized } = setup([
      { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "Nicht angemeldet." } } },
    ]);
    await expect(service.run("123456")).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("unterscheidet die Sperre (423) vom Limit der Läufe (429 mit Wartezeit)", async () => {
    const { service } = setup([
      { status: 423, headers: { "Retry-After": "30" } },
      { status: 429, headers: { "Retry-After": "42" } },
      { status: 429 },
      { status: 409 },
    ]);
    await expect(service.run("123456")).rejects.toBeInstanceOf(RotationLockedError);
    await expect(service.run("123456")).rejects.toMatchObject({ retryAfterSeconds: 42 });
    await expect(service.run("123456")).rejects.toBeInstanceOf(RotationLimitError);
    await expect(service.run("123456")).rejects.toMatchObject({ status: 409 });
  });

  it("meldet Serverfehler nur mit dem Status", async () => {
    const { service } = setup([{ status: 500, body: { error: { message: "geheim" } } }]);
    const error = await service.run("123456").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(String((error as Error).message)).not.toContain("geheim");
  });
});
