import { describe, expect, it } from "vitest";
import { SLUG_PATTERN, customerCreateSchema, slugCandidate, slugFromName } from "./admin.js";

describe("slugFromName", () => {
  it.each([
    ["Männerchor Höngg", "maennerchor-hoengg"],
    ["Grüezi Übung ß", "grueezi-uebung-ss"],
    ["Café Zürich", "cafe-zuerich"],
    ["  Turnverein -- 1887 & Co.  ", "turnverein-1887-co"],
    ["ÄÖÜ", "aeoeue"],
    ["", "kunde"],
    ["!!!", "kunde"],
    ["日本", "kunde"],
  ])("%s -> %s", (name, slug) => {
    expect(slugFromName(name)).toBe(slug);
  });

  it("kürzt auf 63 Zeichen ohne Bindestrich am Ende, und das Ergebnis passt zum Muster", () => {
    expect(slugFromName(`${"a".repeat(62)} bbb`)).toBe("a".repeat(62));
    for (const name of ["x", "a".repeat(200), "1. FC", "Ä".repeat(50)]) {
      expect(slugFromName(name)).toMatch(SLUG_PATTERN);
    }
  });
});

describe("slugCandidate", () => {
  it("hängt ab dem zweiten Versuch eine Zahl an und bleibt höchstens 63 Zeichen lang", () => {
    expect(slugCandidate("abc", 1)).toBe("abc");
    expect(slugCandidate("abc", 2)).toBe("abc-2");
    expect(slugCandidate("a".repeat(63), 10)).toBe(`${"a".repeat(60)}-10`);
    expect(slugCandidate("a".repeat(63), 10)).toHaveLength(63);
    expect(slugCandidate(`${"a".repeat(60)}-bc`, 12)).toMatch(SLUG_PATTERN);
  });
});

describe("customerCreateSchema.slug", () => {
  const base = { name: "X", contactEmail: "a@example.test", licenceValidUntil: "2027-01-01" };
  it("ist optional, prüft Format und reservierte Namen", () => {
    expect(customerCreateSchema.safeParse(base).success).toBe(true);
    expect(customerCreateSchema.safeParse({ ...base, slug: "mein-verein" }).success).toBe(true);
    for (const slug of ["", "Gross", "a b", "-a", "public", "x".repeat(64)]) {
      expect(customerCreateSchema.safeParse({ ...base, slug }).success, slug).toBe(false);
    }
  });
});
