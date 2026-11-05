import { describe, expect, it, vi } from "vitest";
import { createRotationJob } from "./rotation-job.js";

const signal = new AbortController().signal;
type Result = { rotated: number; failed: string[]; aborted: boolean };

/** `changed`: was der Stand meldet (geänderte Menge unlesbarer Objekte oder ein Tag seit der letzten Meldung). */
function setup(results: Result[], changed: boolean[] = []) {
  let t = 0;
  const rotate = vi.fn(async () => results.shift() ?? { rotated: 0, failed: [], aborted: false });
  const record = vi.fn(async () => changed.shift() ?? false);
  const audit = vi.fn(async () => undefined);
  const log = { info: vi.fn(), error: vi.fn() };
  const tick = createRotationJob({
    rotate,
    record,
    audit,
    log,
    label: "Schlüsselrotation Test",
    intervalMs: 1000,
    now: () => new Date(t),
  });
  return { tick, rotate, record, audit, log, at: (ms: number) => (t = ms) };
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
    expect(s.log.error).not.toHaveBeenCalled();
  });

  it("protokolliert und loggt nur Zähler und IDs, wenn sich die unlesbaren Objekte geändert haben", async () => {
    const s = setup([{ rotated: 3, failed: ["acc-1"], aborted: false }], [true]);
    await s.tick(signal);
    expect(s.record).toHaveBeenCalledWith(new Date(0), ["acc-1"]);
    expect(s.log.error).toHaveBeenCalledWith(
      { rotated: 3, failed: 1, aborted: false, failedIds: ["acc-1"] },
      "Schlüsselrotation Test",
    );
    expect(s.audit).toHaveBeenCalledWith(new Date(0), "umgeschlüsselt 3, fehlgeschlagen 1");
  });

  it("ein dauerhaft unlesbares Konto erzeugt keine stündliche Wiederholung", async () => {
    const s = setup(
      [
        { rotated: 0, failed: ["acc-1"], aborted: false },
        { rotated: 0, failed: ["acc-1"], aborted: false },
        { rotated: 0, failed: ["acc-1"], aborted: false },
      ],
      [true, false, false],
    );
    await s.tick(signal);
    s.at(1000);
    await s.tick(signal);
    s.at(2000);
    await s.tick(signal);
    expect(s.log.error).toHaveBeenCalledTimes(1);
    expect(s.audit).toHaveBeenCalledTimes(1);
    expect(s.record).toHaveBeenCalledTimes(3);
  });

  it("neue Arbeit wird gemeldet, ohne die unlesbaren IDs zu wiederholen", async () => {
    const s = setup([{ rotated: 2, failed: ["acc-1"], aborted: false }], [false]);
    await s.tick(signal);
    expect(s.log.error).not.toHaveBeenCalled();
    expect(s.log.info).toHaveBeenCalledWith(
      { rotated: 2, failed: 1, aborted: false },
      "Schlüsselrotation Test",
    );
    expect(s.audit).toHaveBeenCalledWith(new Date(0), "umgeschlüsselt 2, fehlgeschlagen 1");
  });

  it("die Behebung (keine unlesbaren Objekte mehr) wird einmal gemeldet", async () => {
    const s = setup([{ rotated: 0, failed: [], aborted: false }], [true]);
    await s.tick(signal);
    expect(s.log.info).toHaveBeenCalledWith(
      { rotated: 0, failed: 0, aborted: false },
      "Schlüsselrotation Test",
    );
    expect(s.audit).toHaveBeenCalledWith(new Date(0), "umgeschlüsselt 0, fehlgeschlagen 0");
  });

  it("ein abgebrochener Lauf lässt den Stand unangetastet", async () => {
    const s = setup([{ rotated: 2, failed: ["acc-1"], aborted: true }], [true]);
    await s.tick(signal);
    expect(s.record).not.toHaveBeenCalled();
    expect(s.log.info).toHaveBeenCalledWith(
      { rotated: 2, failed: 1, aborted: true },
      "Schlüsselrotation Test",
    );
    expect(s.audit).toHaveBeenCalledWith(
      new Date(0),
      "umgeschlüsselt 2, fehlgeschlagen 1, abgebrochen",
    );
  });

  it("ein Lauf ohne Fehler geht als Info ins Log", async () => {
    const s = setup([{ rotated: 2, failed: [], aborted: false }]);
    await s.tick(signal);
    expect(s.log.info).toHaveBeenCalledWith(
      { rotated: 2, failed: 0, aborted: false },
      "Schlüsselrotation Test",
    );
    expect(s.audit).toHaveBeenCalledWith(new Date(0), "umgeschlüsselt 2, fehlgeschlagen 0");
  });
});
