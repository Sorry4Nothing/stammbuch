import { describe, expect, it, vi } from "vitest";
import { createHttpTasksService } from "./httpTasksService";
import { TasksApiError } from "./model";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function setup(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(String(url), init ?? {});
  }) as unknown as typeof fetch;
  const onUnauthorized = vi.fn();
  const service = createHttpTasksService({ csrfToken: () => "tok", onUnauthorized, fetchFn });
  return { service, calls, onUnauthorized };
}

describe("createHttpTasksService", () => {
  it("liest offene und erledigte Aufgaben mit Status und Limit", async () => {
    const { service, calls } = setup((url) =>
      url.includes("status=done")
        ? json({
            items: [
              { id: "1", title: "Alt", due: "2026-11-01", doneAt: "2026-11-03T09:00:00.000Z" },
            ],
            total: 7,
          })
        : json({ items: [{ id: "2", title: "Neu", due: "2026-11-05" }], total: 1, dueCount: 0 }),
    );
    expect(await service.list("open")).toEqual({
      items: [{ id: "2", title: "Neu", due: "2026-11-05" }],
      total: 1,
    });
    expect(await service.list("done")).toEqual({
      items: [{ id: "1", title: "Alt", due: "2026-11-01", doneAt: "2026-11-03T09:00:00.000Z" }],
      total: 7,
    });
    expect(calls.map((c) => c.url)).toEqual([
      "/tasks?status=open&limit=200",
      "/tasks?status=done&limit=200",
    ]);
    expect(calls[0]?.init.headers).not.toHaveProperty("X-CSRF-Token");
  });

  it("legt an und erledigt mit CSRF-Token und gleicher Origin", async () => {
    const { service, calls } = setup((url) =>
      url === "/tasks"
        ? json({ id: "n1", title: "Neu", due: "2026-11-05" }, 201)
        : new Response(null, { status: 204 }),
    );
    expect(await service.create({ title: "Neu", due: "2026-11-05" })).toEqual({
      id: "n1",
      title: "Neu",
      due: "2026-11-05",
    });
    await service.complete("n1");
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({ title: "Neu", due: "2026-11-05" }),
    });
    expect(calls[0]?.init.headers).toMatchObject({ "X-CSRF-Token": "tok" });
    expect(calls[1]?.url).toBe("/tasks/n1/done");
    expect(calls[1]?.init.headers).toMatchObject({ "X-CSRF-Token": "tok" });
  });

  it("meldet Fehler nur mit Status, ohne Text der API, und 401 als abgelaufene Sitzung", async () => {
    const { service, onUnauthorized } = setup((url) =>
      url.startsWith("/tasks?") ? json({ error: { message: "intern" } }, 401) : json({}, 400),
    );
    const err = await service.list("open").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TasksApiError);
    expect(err).toMatchObject({ status: 401 });
    expect(String((err as Error).message)).not.toContain("intern");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await expect(service.create({ title: "x", due: "2026-11-05" })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("meldet Netzwerkfehler und unbrauchbare Antworten als Fehler", async () => {
    const offline = createHttpTasksService({
      csrfToken: () => null,
      onUnauthorized: () => undefined,
      fetchFn: (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch,
    });
    await expect(offline.list("open")).rejects.toMatchObject({ status: 0 });
    const { service } = setup(() => json({ unerwartet: true }));
    await expect(service.list("open")).rejects.toBeInstanceOf(TasksApiError);
    await expect(service.create({ title: "x", due: "2026-11-05" })).rejects.toBeInstanceOf(
      TasksApiError,
    );
  });
});
