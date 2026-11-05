import { describe, expect, it, vi } from "vitest";
import { createRotationJob } from "./rotation-job.js";

const signal = new AbortController().signal;

function setup(results: { rotated: number; failed: string[]; aborted: boolean }[]) {
  let t = 0;
  const rotate = vi.fn(async () => results.shift() ?? { rotated: 0, failed: [], aborted: false });
  const audit = vi.fn(async () => undefined);
  const log = { info: vi.fn(), error: vi.fn() };
  const tick = createRotationJob({
    rotate,
    audit,
    log,
    intervalMs: 1000,
    now: () => new Date(t),
  });
  return { tick, rotate, audit, log, at: (ms: number) => (t = ms) };
}

describe("Rotationsjob im Worker", () => {
  it("läuft höchstens einmal pro Intervall und bleibt ohne Arbeit still", async () => {
    const s = setup([]);
    await s.tick(signal);
    await s.tick(signal);
    expect(s.rotate).toHaveBeenCalledTimes(1);
    s.at(1000);
    await s.tick(signal);
    expect(s.rotate).toHaveBeenCalledTimes(2);
    expect(s.audit).not.toHaveBeenCalled();
    expect(s.log.info).not.toHaveBeenCalled();
  });

  it("protokolliert und loggt nur Zähler und Konto-IDs", async () => {
    const s = setup([{ rotated: 3, failed: ["acc-1"], aborted: true }]);
    await s.tick(signal);
    expect(s.log.error).toHaveBeenCalledWith(
      { rotated: 3, failed: 1, aborted: true, failedAccounts: ["acc-1"] },
      "Schlüsselrotation",
    );
    expect(s.audit).toHaveBeenCalledWith(
      new Date(0),
      "umgeschlüsselt 3, fehlgeschlagen 1, abgebrochen",
    );
  });

  it("ein Lauf ohne Fehler geht als Info ins Log", async () => {
    const s = setup([{ rotated: 2, failed: [], aborted: false }]);
    await s.tick(signal);
    expect(s.log.info).toHaveBeenCalledWith(
      { rotated: 2, failed: 0, aborted: false },
      "Schlüsselrotation",
    );
    expect(s.audit).toHaveBeenCalledWith(new Date(0), "umgeschlüsselt 2, fehlgeschlagen 0");
  });
});
