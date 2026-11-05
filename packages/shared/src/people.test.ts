import { describe, expect, it } from "vitest";
import {
  addressSchema,
  firmaCreateSchema,
  memberCreateSchema,
  memberListQuerySchema,
  normalizePhone,
  parseUid,
  uidSchema,
} from "./index.js";

const adresse = { strasse: "Bahnhofstrasse", hausnr: "1", plz: "8001", ort: "Zürich" };

describe("Schweizer Adressen", () => {
  it("akzeptiert gültige PLZ und setzt Land CH", () => {
    expect(addressSchema.parse(adresse).land).toBe("CH");
  });

  it.each(["0999", "9659", "123", "12345", "abcd"])("lehnt PLZ %s für CH ab", (plz) => {
    expect(addressSchema.safeParse({ ...adresse, plz }).success).toBe(false);
  });

  it("prüft PLZ für Liechtenstein und lässt fremde Länder locker", () => {
    expect(addressSchema.safeParse({ ...adresse, land: "LI", plz: "9490" }).success).toBe(true);
    expect(addressSchema.safeParse({ ...adresse, land: "LI", plz: "8001" }).success).toBe(false);
    expect(addressSchema.safeParse({ ...adresse, land: "DE", plz: "10115" }).success).toBe(true);
  });
});

describe("Telefon", () => {
  it.each([
    ["079 123 45 67", "+41791234567"],
    ["+41 79 123 45 67", "+41791234567"],
    ["0041791234567", "+41791234567"],
    ["+41 (0)79 123 45 67", "+41791234567"],
    ["044 123 45 67", "+41441234567"],
    ["+49 30 123456", "+4930123456"],
  ])("normalisiert %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(["", "abc", "079 123 45", "0791234567890", "+41 79 123", "12345"])(
    "lehnt %j ab",
    (input) => {
      expect(normalizePhone(input)).toBeNull();
    },
  );
});

describe("UID", () => {
  it("prüft die Prüfziffer und normalisiert", () => {
    expect(uidSchema.parse("CHE123456788")).toBe("CHE-123.456.788");
    expect(uidSchema.safeParse("CHE-123.456.789").success).toBe(false);
    expect(parseUid("che-123.456.788 mwst")).toEqual({ digits: "123456788", suffix: true });
  });

  it("verlangt für die MwSt-Nummer den Zusatz", () => {
    const base = { name: "Muster AG", adresse };
    expect(firmaCreateSchema.parse({ ...base, mwstNr: "CHE-123.456.788 MWST" }).mwstNr).toBe(
      "CHE-123.456.788 MWST",
    );
    expect(firmaCreateSchema.safeParse({ ...base, mwstNr: "CHE-123.456.788" }).success).toBe(false);
  });
});

describe("Mitglied-Schemas", () => {
  it("verlangt für Firmenmitglieder eine Firma", () => {
    const base = { vorname: "Anna", nachname: "Muster" };
    expect(memberCreateSchema.safeParse({ typ: "firma", ...base }).success).toBe(false);
    expect(memberCreateSchema.safeParse({ typ: "einzel", ...base }).success).toBe(true);
  });

  it("entfernt unbekannte Felder (keine Massenzuweisung, SR-72)", () => {
    const r = memberCreateSchema.parse({
      typ: "einzel",
      vorname: "Anna",
      nachname: "Muster",
      kundeId: "x",
      status: "archiviert",
    });
    expect(r).not.toHaveProperty("kundeId");
    expect(r).not.toHaveProperty("status");
  });

  it("lehnt Formelanfang und Steuerzeichen in Namen ab", () => {
    for (const vorname of ["=1+1", "@SUM(A1)", "A\u0000nna", "  "]) {
      expect(
        memberCreateSchema.safeParse({ typ: "einzel", vorname, nachname: "Muster" }).success,
      ).toBe(false);
    }
  });

  it("begrenzt die Listenabfrage", () => {
    expect(memberListQuerySchema.parse({}).limit).toBe(50);
    expect(memberListQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
    expect(memberListQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
  });
});
