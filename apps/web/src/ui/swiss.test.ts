import { normalizePhone as apiPhone, parseUid as apiUid } from "@stammbuch/shared";
import { describe, expect, it } from "vitest";
import {
  dateError,
  isHttpUrl,
  isMwstNr,
  isUid,
  normalizePhone,
  parseDateInput,
  parseUid,
} from "./swiss";

describe("Schweizer Prüfregeln: gleiche Antwort wie die API", () => {
  const phones = [
    "079 123 45 67",
    "+41 79 123 45 67",
    "0041 79 123 45 67",
    "+41 (0)79 123 45 67",
    "123",
    "079 123 45",
    "+49 30 1234567",
    "abc",
    "",
    "+41791234567890",
  ];
  it.each(phones)("Telefon %j", (input) => {
    expect(normalizePhone(input)).toBe(apiPhone(input));
  });

  const uids = [
    "CHE-109.322.551",
    "CHE-109.322.551 MWST",
    "CHE109322551",
    "CHE-123.456.789",
    "che 109 322 551",
    "xyz",
  ];
  it.each(uids)("UID %j", (input) => {
    expect(parseUid(input)).toEqual(apiUid(input));
  });

  it("UID und MwSt-Nr. unterscheiden den Zusatz", () => {
    expect(isUid("CHE-109.322.551")).toBe(true);
    expect(isUid("CHE-123.456.789")).toBe(false);
    expect(isMwstNr("CHE-109.322.551 MWST")).toBe(true);
    expect(isMwstNr("CHE-109.322.551")).toBe(false);
  });
});

describe("Datum eingeben", () => {
  it("liest 1.1.27 nur mit shortYear", () => {
    expect(parseDateInput("1.1.27", { shortYear: true })).toEqual({ iso: "2027-01-01" });
    expect(parseDateInput("1.1.27")).toEqual({ error: "format" });
    expect(parseDateInput("01.01.2027")).toEqual({ iso: "2027-01-01" });
  });
  it("unterscheidet Format und nicht vorhandenes Datum", () => {
    expect(parseDateInput("31.02.2027")).toEqual({ error: "invalid" });
    expect(parseDateInput("morgen")).toEqual({ error: "format" });
    expect(dateError("31.02.2027")).toBe("Dieses Datum gibt es nicht.");
    expect(dateError("morgen")).toBe("Geben Sie das Datum als TT.MM.JJJJ ein.");
    expect(dateError("")).toBeUndefined();
    expect(dateError("22.07.1990")).toBeUndefined();
  });
});

describe("Webadresse", () => {
  it("nur http und https", () => {
    expect(isHttpUrl("https://www.example.ch")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("example.ch")).toBe(false);
  });
});
