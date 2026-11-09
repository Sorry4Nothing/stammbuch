import { describe, expect, it } from "vitest";
import type { AuditEntry } from "../../platform/index.js";
import { resolveTargets } from "./audit-targets.js";

const UUID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const entry = (action: string, target: string): AuditEntry => ({
  id: "1",
  at: "2026-11-09T10:00:00.000Z",
  actorId: "u1",
  actor: "admin@example.test",
  action,
  target,
});

describe("Objekt im Protokoll (SR-50)", () => {
  it("zeigt nie eine rohe UUID, auch ohne Datenbank", async () => {
    const out = await resolveTargets(undefined, "t1", [
      entry("aufgabe.anlegen", UUID),
      entry("mail.send", UUID),
    ]);
    expect(out.map((e) => e.target)).toEqual(["", ""]);
  });

  it("lässt lesbare Ziele unverändert", async () => {
    const out = await resolveTargets(undefined, "t1", [
      entry("organisation.update", "master"),
      entry("user.add", "person@example.test"),
      entry("mail.delete", "INBOX (3)"),
      entry("login_success", ""),
    ]);
    expect(out.map((e) => e.target)).toEqual(["master", "person@example.test", "INBOX (3)", ""]);
  });
});
