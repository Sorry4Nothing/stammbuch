import { describe, expect, it } from "vitest";
import { isValidQrReference, isValidScorReference, normalizeReference } from "./reference.js";

describe("QR-Referenz (Modulo 10)", () => {
  it("akzeptiert die Beispielreferenz der SIX-Dokumentation", () => {
    expect(isValidQrReference("210000000003139471430009017")).toBe(true);
  });
  it("lehnt falsche Prüfziffer, falsche Länge und Nichtziffern ab", () => {
    expect(isValidQrReference("210000000003139471430009018")).toBe(false);
    expect(isValidQrReference("21000000000313947143000901")).toBe(false);
    expect(isValidQrReference("2100000000031394714300090170")).toBe(false);
    expect(isValidQrReference("21000000000313947143000901X")).toBe(false);
    expect(isValidQrReference("")).toBe(false);
  });
  it("erkennt jede Einzelstellen-Änderung", () => {
    const ok = "210000000003139471430009017";
    for (let i = 0; i < ok.length; i++) {
      const d = (Number(ok[i]) + 1) % 10;
      expect(isValidQrReference(ok.slice(0, i) + d + ok.slice(i + 1))).toBe(false);
    }
  });
});

describe("Creditor Reference (SCOR, ISO 11649)", () => {
  it("prüft Mod 97", () => {
    expect(isValidScorReference("RF18539007547034")).toBe(true);
    expect(isValidScorReference("RF19539007547034")).toBe(false);
    expect(isValidScorReference("RF18")).toBe(false);
    expect(isValidScorReference("XX18539007547034")).toBe(false);
  });
});

describe("normalizeReference", () => {
  it("entfernt Leerzeichen und Zeilenumbrüche", () => {
    expect(normalizeReference("21 00000 00003\n13947")).toBe("21000000000313947");
  });
});
