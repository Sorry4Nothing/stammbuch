import { describe, expect, it } from "vitest";
import { apiErrorSchema, healthResponseSchema } from "./api.js";

describe("API-Schemas", () => {
  it("akzeptiert eine gültige Health-Antwort", () => {
    expect(healthResponseSchema.parse({ status: "ok" })).toEqual({ status: "ok" });
  });

  it("lehnt unbekannte Statuswerte ab", () => {
    expect(healthResponseSchema.safeParse({ status: "kaputt" }).success).toBe(false);
  });

  it("akzeptiert nur bekannte Fehlercodes", () => {
    const ok = { error: { code: "INTERNAL", message: "Interner Fehler" } };
    expect(apiErrorSchema.safeParse(ok).success).toBe(true);
    expect(apiErrorSchema.safeParse({ error: { code: "X", message: "m" } }).success).toBe(false);
  });
});
