import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { toXlsx } from "./xlsx.js";

/** Liest das ZIP über das Verzeichnis am Ende zurück (nur Methode «stored»). */
function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let pos = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(pos)).toBe(0x02014b50);
    const crc = zip.readUInt32LE(pos + 16);
    const size = zip.readUInt32LE(pos + 24);
    const nameLength = zip.readUInt16LE(pos + 28);
    const local = zip.readUInt32LE(pos + 42);
    const name = zip.subarray(pos + 46, pos + 46 + nameLength).toString("utf8");
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26);
    const data = zip.subarray(start, start + size);
    expect(crc32(data), name).toBe(crc);
    files.set(name, data);
    pos += 46 + nameLength;
  }
  return files;
}

describe("toXlsx", () => {
  it("schreibt ein gültiges Paket mit allen Teilen", () => {
    const files = unzip(toXlsx([["Zeitpunkt", "Benutzer"]]));
    expect([...files.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/worksheets/sheet1.xml",
    ]);
  });

  it("legt Text als Inline-String ab, auch wenn er nach Formel aussieht, und maskiert XML", () => {
    const sheet = unzip(
      toXlsx([
        ["=1+1", '<b>"x"</b> & Müller', "a\u0000b"],
        ["zweite Zeile", "", "C"],
      ]),
    )
      .get("xl/worksheets/sheet1.xml")!
      .toString("utf8");
    expect(sheet).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">=1+1</t>');
    expect(sheet).toContain("&lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; Müller");
    expect(sheet).toContain(">ab</t>"); // Steuerzeichen entfernt
    expect(sheet).toContain('<c r="C2"');
    expect(sheet).not.toMatch(/<f>/);
  });

  it("benennt Spalten über Z hinaus", () => {
    const sheet = unzip(toXlsx([Array.from({ length: 28 }, () => "x")]))
      .get("xl/worksheets/sheet1.xml")!
      .toString("utf8");
    expect(sheet).toContain('r="Z1"');
    expect(sheet).toContain('r="AB1"');
  });
});
