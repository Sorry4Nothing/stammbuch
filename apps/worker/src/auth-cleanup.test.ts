import { describe, expect, it, vi } from "vitest";
import { createAuthCleanupJob } from "./auth-cleanup.js";

describe("Auth-Aufräumjob", () => {
  it("läuft sofort, danach höchstens einmal pro Intervall", async () => {
    let t = new Date("2026-11-04T10:00:00Z");
    const db = {
      raeumeAuthAuf: vi.fn().mockResolvedValue({ sitzungen: 2, sperren: 1, ereignisse: 0 }),
    };
    const onResult = vi.fn();
    const tick = createAuthCleanupJob({ db, intervalMs: 3_600_000, onResult, now: () => t });

    await tick();
    await tick();
    expect(db.raeumeAuthAuf).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith({ sitzungen: 2, sperren: 1, ereignisse: 0 });

    t = new Date(t.getTime() + 3_600_000);
    await tick();
    expect(db.raeumeAuthAuf).toHaveBeenCalledTimes(2);
    expect(db.raeumeAuthAuf).toHaveBeenLastCalledWith(t);
  });

  it("wiederholt nach einem Fehler beim nächsten Tick", async () => {
    const db = {
      raeumeAuthAuf: vi
        .fn()
        .mockRejectedValueOnce(new Error("db down"))
        .mockResolvedValue({ sitzungen: 0, sperren: 0, ereignisse: 0 }),
    };
    const tick = createAuthCleanupJob({ db, intervalMs: 3_600_000, onResult: () => {} });
    await expect(tick()).rejects.toThrow("db down");
    await tick();
    expect(db.raeumeAuthAuf).toHaveBeenCalledTimes(2);
  });
});
