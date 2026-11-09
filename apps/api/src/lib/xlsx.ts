import { crc32 } from "node:zlib";

/**
 * Minimaler .xlsx-Export ohne Abhängigkeit: ein Blatt, nur Text. Zellen sind Inline-Strings, Excel führt sie nie als
 * Formel aus (anders als CSV braucht es hier kein vorangestelltes `'`). Das ZIP-Format ist unkomprimiert («stored»):
 * ein Protokollexport ist klein genug (höchstens 10'000 Zeilen).
 * shortcut: nur Text, keine Formate und keine Spaltenbreiten, bei Bedarf auf eine Bibliothek (exceljs) wechseln.
 */

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** Entfernt Zeichen, die in XML 1.0 nicht vorkommen dürfen, und maskiert den Rest. */
function xmlText(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g, "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
  );
}

/** Spaltenname: 0 = A, 25 = Z, 26 = AA. */
function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

function sheetXml(rows: string[][]): string {
  const body = rows
    .map((row, r) => {
      const cells = row
        .map(
          (value, c) =>
            `<c r="${columnName(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`,
        )
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  return `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/** Blattname: höchstens 31 Zeichen, ohne `[]:*?/\`. */
const sheetName = (name: string) =>
  xmlText(name.replace(/[[\]:*?/\\]/g, " ").slice(0, 31) || "Blatt1");

/** Ein ZIP mit unkomprimierten Einträgen (Methode 0), Namen als UTF-8. */
export function zipStored(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // Version
    local.writeUInt16LE(0x0800, 6); // Namen in UTF-8
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // Zeit 00:00
    local.writeUInt16LE(0x21, 12); // Datum 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // erstellt mit
    entry.writeUInt16LE(20, 6); // nötig zum Entpacken
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Zeilen als .xlsx (ein Blatt). Alle Werte sind Text. */
export function toXlsx(rows: string[][], name = "Protokoll"): Buffer {
  const text = (s: string) => Buffer.from(s, "utf8");
  return zipStored([
    {
      name: "[Content_Types].xml",
      data: text(
        `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      data: text(
        `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
    },
    {
      name: "xl/workbook.xml",
      data: text(
        `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: text(
        `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      ),
    },
    { name: "xl/worksheets/sheet1.xml", data: text(sheetXml(rows)) },
  ]);
}
