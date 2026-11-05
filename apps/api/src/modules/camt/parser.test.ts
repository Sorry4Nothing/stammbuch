import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAmountRappen, parseCamt } from "./parser.js";
import { CamtError } from "./types.js";
import { checkUpload, MAX_CAMT_BYTES } from "./upload.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const camt053 = fixture("camt053-v04.xml");
const camt054 = fixture("camt054-v08.xml");

describe("CAMT.053 (Version 04)", () => {
  const doc = parseCamt(camt053);

  it("liest Kopf und überspringt nicht gebuchte Einträge", () => {
    expect(doc).toMatchObject({ kind: "camt.053", version: "04", messageId: "MSG-053-0001" });
    expect(doc.transactions).toHaveLength(5);
    expect(doc.ignoredEntries).toBe(1);
  });

  it("normalisiert Gutschrift mit QR-Referenz und Debitor", () => {
    expect(doc.transactions[0]).toMatchObject({
      accountIban: "CH4431999123000889012",
      bookingDate: "2026-10-05",
      valueDate: "2026-10-05",
      amountRappen: 12000,
      currency: "CHF",
      direction: "CREDIT",
      reversal: false,
      bankReference: "REF-0001",
      reference: { kind: "QRR", value: "000000021000000000000100009", valid: true },
      debtorName: "Muster & Söhne AG",
      debtorIban: "CH9300762011623852957",
    });
  });

  it("liest Rappenbeträge, ignoriert NOTPROVIDED und Freitext", () => {
    expect(doc.transactions[1]).toMatchObject({ amountRappen: 8050, endToEndId: undefined });
    expect(doc.transactions[2]).toMatchObject({
      reference: undefined,
      remittanceInfo: "Mitgliederbeitrag 2026",
    });
  });

  it("erkennt Storno und Belastung", () => {
    expect(doc.transactions[3]).toMatchObject({ direction: "DEBIT", reversal: true });
    expect(doc.transactions[4]).toMatchObject({ direction: "DEBIT", reversal: false });
  });
});

describe("CAMT.054 (Version 08)", () => {
  const doc = parseCamt(camt054);

  it("liest Sammelbuchung als Einzelbuchungen mit Einzelbeträgen", () => {
    expect(doc).toMatchObject({ kind: "camt.054", version: "08", messageId: "MSG-054-0001" });
    expect(doc.transactions.map((t) => t.amountRappen)).toEqual([20000, 10000, 4200]);
    expect(doc.transactions[0]).toMatchObject({
      bankReference: "REF-1001-A",
      debtorName: "Beispiel Verein",
    });
  });

  it("liest SCOR und Zusatzinfo, markiert falsche Prüfziffer", () => {
    expect(doc.transactions[1]).toMatchObject({
      reference: { kind: "SCOR", value: "RF18539007547034", valid: true },
      remittanceInfo: "Rechnung 4711",
    });
    expect(doc.transactions[2]?.reference).toMatchObject({ kind: "QRR", valid: false });
    expect(doc.transactions[2]?.bookingDate).toBe("2026-11-02");
  });
});

describe("parseAmountRappen", () => {
  it("rechnet exakt, ohne Fliesskomma-Fehler", () => {
    expect(parseAmountRappen("0.10")).toBe(10);
    expect(parseAmountRappen("1234.5")).toBe(123450);
    expect(parseAmountRappen("19.99")).toBe(1999);
    expect(parseAmountRappen("7")).toBe(700);
  });
  it.each(["-1.00", "1.001", "1,00", "abc", "", "1e3", " 1.00", "9999999999999"])(
    "lehnt %j ab",
    (v) => {
      expect(() => parseAmountRappen(v)).toThrow(CamtError);
    },
  );
});

describe("Fehlerfälle", () => {
  const mutate = (from: string, to: string) => camt053.replace(from, to);
  const code = (xml: string) => {
    try {
      parseCamt(xml);
    } catch (e) {
      return e instanceof CamtError ? e.code : `UNERWARTET: ${String(e)}`;
    }
    return "OK";
  };

  it("lehnt kaputtes XML ab", () => {
    expect(code(camt053.slice(0, 600))).toBe("INVALID_XML");
    expect(code("<Document><a></Document>")).toBe("INVALID_XML");
  });
  it("lehnt fremde Formate und Versionen ab", () => {
    expect(code(`<?xml version="1.0"?><Document xmlns="urn:foo"/>`)).toBe("UNSUPPORTED_FORMAT");
    expect(code(mutate("camt.053.001.04", "camt.053.001.99"))).toBe("UNSUPPORTED_FORMAT");
    expect(code(mutate("camt.053.001.04", "camt.052.001.04"))).toBe("UNSUPPORTED_FORMAT");
    expect(code(mutate("camt.053.001.04", "camt.054.001.04"))).toBe("UNSUPPORTED_FORMAT");
  });
  it("lehnt inhaltliche Mängel ab", () => {
    expect(code(mutate('Ccy="CHF">120.00', 'Ccy="CHF">-120.00'))).toBe("INVALID_CONTENT");
    expect(code(mutate('Ccy="CHF">120.00', 'Ccy="chf">120.00'))).toBe("INVALID_CONTENT");
    expect(code(mutate("<Dt>2026-10-05</Dt></BookgDt>", "<Dt>2026-02-30</Dt></BookgDt>"))).toBe(
      "INVALID_CONTENT",
    );
    expect(code(mutate("<CdtDbtInd>CRDT</CdtDbtInd>", "<CdtDbtInd>XXXX</CdtDbtInd>"))).toBe(
      "INVALID_CONTENT",
    );
    expect(code(mutate("<IBAN>CH4431999123000889012</IBAN>", "<IBAN>x</IBAN>"))).toBe(
      "INVALID_CONTENT",
    );
    expect(code(mutate("<MsgId>MSG-053-0001</MsgId>", ""))).toBe("INVALID_CONTENT");
    expect(code(mutate("<RvslInd>true</RvslInd>", "<RvslInd>vielleicht</RvslInd>"))).toBe(
      "INVALID_CONTENT",
    );
  });
});

describe("XML-Sicherheit (SR-25)", () => {
  const xxe = `<?xml version="1.0"?>
<!DOCTYPE Document [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.04"><BkToCstmrStmt><GrpHdr><MsgId>&xxe;</MsgId></GrpHdr></BkToCstmrStmt></Document>`;
  const laughs = `<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.04"><BkToCstmrStmt><GrpHdr><MsgId>&lol3;</MsgId></GrpHdr></BkToCstmrStmt></Document>`;
  const external = `<?xml version="1.0"?><!DOCTYPE d SYSTEM "http://127.0.0.1:1/evil.dtd"><Document/>`;

  it.each([
    ["externe Entität (XXE)", xxe],
    ["Billion Laughs", laughs],
    ["externe DTD", external],
    ["DOCTYPE in Kleinschreibung", xxe.replace("DOCTYPE", "doctype")],
    ["DOCTYPE mit Leerzeichen", xxe.replace("<!DOCTYPE", "<! DOCTYPE")],
  ])("%s wird vom Parser und vom Upload-Check abgelehnt", (_n, xml) => {
    expect(() => parseCamt(xml)).toThrow(CamtError);
    expect(() => checkUpload(Buffer.from(xml))).toThrow(
      expect.objectContaining({ code: "INVALID_XML" }),
    );
  });

  it("verarbeitet vordefinierte Entitäten, aber keine eigenen", () => {
    const doc = parseCamt(camt053.replace("Erika Beispiel", "Erika &amp; &lt;Co&gt;"));
    expect(doc.transactions[1]?.debtorName).toBe("Erika & <Co>");
    expect(() => parseCamt(camt053.replace("Erika Beispiel", "&eigen;"))).not.toThrow(/passwd/);
  });

  it("scheitert kontrolliert bei extrem tiefer Verschachtelung", () => {
    const deep = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.04">${"<a>".repeat(200_000)}${"</a>".repeat(200_000)}</Document>`;
    expect(() => parseCamt(deep)).toThrow(CamtError);
  });

  it("bleibt bei sehr vielen Elementen im Zeitrahmen", () => {
    const wide = camt053.replace("</Stmt>", "<Ntry/>".repeat(100_000) + "</Stmt>");
    const t = Date.now();
    expect(() => parseCamt(wide)).toThrow(CamtError);
    expect(Date.now() - t).toBeLessThan(5000);
  });
});

describe("Upload-Prüfung (SR-23)", () => {
  const upload = (b: Uint8Array | string) => () =>
    checkUpload(typeof b === "string" ? Buffer.from(b) : b);
  const code = (c: string) => expect.objectContaining({ code: c });

  it("akzeptiert UTF-8 mit und ohne BOM sowie führenden Leerraum", () => {
    expect(upload(camt053)).not.toThrow();
    expect(
      upload(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(camt053)])),
    ).not.toThrow();
    expect(upload("\n  " + camt053)).not.toThrow();
  });
  it("lehnt leere, zu grosse und binäre Dateien ab", () => {
    expect(upload(new Uint8Array(0))).toThrow(code("INVALID_UPLOAD"));
    expect(upload(new Uint8Array(MAX_CAMT_BYTES + 1))).toThrow(code("FILE_TOO_LARGE"));
    expect(upload(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toThrow(
      code("INVALID_UPLOAD"),
    );
    expect(upload(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]))).toThrow(
      code("INVALID_UPLOAD"),
    );
  });
  it("prüft den Inhalt, nicht den Namen: HTML, JSON, Skripte gehen nicht durch", () => {
    expect(upload("<html><body>x</body></html>")).toThrow(code("INVALID_UPLOAD"));
    expect(upload('{"a":1}')).toThrow(code("INVALID_UPLOAD"));
    expect(upload("<?php echo 1; ?>")).toThrow(code("INVALID_UPLOAD"));
  });
  it("lehnt UTF-16, ungültiges UTF-8 und andere Kodierungen ab", () => {
    expect(upload(Buffer.from(camt053, "utf16le"))).toThrow(code("INVALID_UPLOAD"));
    expect(upload(Buffer.from([0x3c, 0x3f, 0x78, 0x6d, 0x6c, 0xc3, 0x28]))).toThrow(
      code("INVALID_UPLOAD"),
    );
    expect(upload(camt053.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"'))).toThrow(
      code("INVALID_UPLOAD"),
    );
  });
});

describe("Fuzz-artige Eingaben", () => {
  // Deterministischer Zufall, damit Fehlschläge reproduzierbar sind.
  function rng(seed: number) {
    return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  }

  it("liefert für beliebig beschädigte Dateien nur Ergebnis oder CamtError", () => {
    const rand = rng(42);
    const seeds = [camt053, camt054];
    for (let i = 0; i < 400; i++) {
      let s = seeds[i % 2] as string;
      for (let k = 0; k < 1 + Math.floor(rand() * 6); k++) {
        const pos = Math.floor(rand() * s.length);
        const op = Math.floor(rand() * 4);
        if (op === 0) s = s.slice(0, pos) + s.slice(pos + 1 + Math.floor(rand() * 40));
        else if (op === 1)
          s = s.slice(0, pos) + String.fromCharCode(Math.floor(rand() * 256)) + s.slice(pos);
        else if (op === 2) s = s.slice(0, pos);
        else s = s.slice(0, pos) + "<" + s.slice(pos);
      }
      try {
        const doc = parseCamt(s);
        for (const t of doc.transactions) {
          expect(Number.isSafeInteger(t.amountRappen) && t.amountRappen >= 0).toBe(true);
        }
      } catch (e) {
        expect(e).toBeInstanceOf(CamtError);
      }
    }
  });

  it.each([
    "",
    "<",
    "<?xml",
    "\u0000\u0000",
    "<Document/>",
    "<Document xmlns='urn:iso:std:iso:20022:tech:xsd:camt.053.001.04'><BkToCstmrStmt/></Document>",
    "<Document xmlns='urn:iso:std:iso:20022:tech:xsd:camt.053.001.04'><BkToCstmrStmt><GrpHdr><MsgId>x</MsgId></GrpHdr><Stmt/></BkToCstmrStmt></Document>",
    "<Document xmlns='urn:iso:std:iso:20022:tech:xsd:camt.053.001.04'><BkToCstmrStmt><GrpHdr><MsgId>x</MsgId></GrpHdr><Stmt><Acct><Id><IBAN><x/></IBAN></Id></Acct></Stmt></BkToCstmrStmt></Document>",
    "\ud800<Document/>",
    "<Document xmlns='urn:iso:std:iso:20022:tech:xsd:camt.053.001.04' xmlns='x'/>",
  ])("lehnt %j kontrolliert ab oder liest es leer", (xml) => {
    try {
      parseCamt(xml);
    } catch (e) {
      expect(e).toBeInstanceOf(CamtError);
    }
  });
});
