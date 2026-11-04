import { describe, expect, it } from "vitest";
import { makeJpeg, makePng } from "../../platform/platform.testkit.js";
import { inspectLogo } from "./logo.js";

describe("inspectLogo", () => {
  it("erkennt PNG und JPEG mit Grösse", () => {
    expect(inspectLogo(makePng(120, 40), "image/png")).toEqual({
      mime: "image/png",
      width: 120,
      height: 40,
    });
    expect(inspectLogo(makeJpeg(640, 480), "image/jpeg")).toEqual({
      mime: "image/jpeg",
      width: 640,
      height: 480,
    });
  });

  it("lehnt Typ-Mismatch, Abgeschnittenes, Text und Grössen ausserhalb ab", () => {
    expect(inspectLogo(makePng(120, 40), "image/jpeg")).toBeUndefined();
    expect(inspectLogo(makeJpeg(120, 40), "image/png")).toBeUndefined();
    expect(inspectLogo(makePng(120, 40).subarray(0, 40), "image/png")).toBeUndefined();
    expect(inspectLogo(Buffer.from("<svg/>"), "image/png")).toBeUndefined();
    expect(inspectLogo(makePng(2001, 100), "image/png")).toBeUndefined();
    expect(inspectLogo(makeJpeg(100, 15), "image/jpeg")).toBeUndefined();
    expect(
      inspectLogo(Buffer.concat([makePng(100, 100), Buffer.alloc(600_000)]), "image/png"),
    ).toBeUndefined();
  });
});
