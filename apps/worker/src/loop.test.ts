import { describe, expect, it, vi } from "vitest";
import { runLoop } from "./loop.js";

describe("runLoop", () => {
  it("beendet sich bei Abbruch, auch während der Pause", async () => {
    const controller = new AbortController();
    const tick = vi.fn(async () => {});
    const done = runLoop(controller.signal, { intervalMs: 60_000, tick, onError: () => {} });
    await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(done).resolves.toBeUndefined();
  });

  it("meldet Fehler und läuft weiter", async () => {
    const controller = new AbortController();
    const onError = vi.fn();
    let calls = 0;
    const tick = async () => {
      calls++;
      if (calls === 1) throw new Error("kaputt");
      controller.abort();
    };
    await runLoop(controller.signal, { intervalMs: 1, tick, onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });
});
