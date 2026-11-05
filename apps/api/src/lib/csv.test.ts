import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv.js";

describe("csvCell", () => {
  it.each(["=1+1", "+49", "-1", "@SUM(A1)", "\tx", "\rx", '=HYPERLINK("http://x")'])(
    "neutralisiert %j",
    (v) => {
      expect(csvCell(v).replace(/^"/, "").startsWith("'")).toBe(true);
    },
  );

  it("lässt normalen Text unverändert und setzt Anführungszeichen nur bei Bedarf", () => {
    expect(csvCell("Müller AG")).toBe("Müller AG");
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell('sagt "hallo"')).toBe('"sagt ""hallo"""');
    expect(csvCell("zwei\nZeilen")).toBe('"zwei\nZeilen"');
  });

  it("schreibt BOM und CRLF", () => {
    expect(
      toCsv([
        ["a", "b"],
        ["=x", "y"],
      ]),
    ).toBe("﻿a;b\r\n'=x;y\r\n");
  });
});
