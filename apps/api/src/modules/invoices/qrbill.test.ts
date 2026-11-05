import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import { formatIban, isQrIban, isSwissOrLiIban, isValidIban } from "./iban.js";
import { QrBillError, buildQrPayload, toQrLatin } from "./qrbill.js";
import type { QrBillData } from "./qrbill.js";
import {
  formatQrr,
  formatScor,
  isValidQrr,
  isValidScor,
  makeQrr,
  makeScor,
  mod10Check,
} from "./reference.js";

// Beispielwerte aus den Swiss Implementation Guidelines QR-bill (SIX) und ISO 11649.
const QR_IBAN = "CH4431999123000889012";
const IBAN = "CH5800791123000889012";
const QRR = "210000000003139471430009017";

const creditor = {
  name: "Robert Schneider AG",
  street: "Rue du Lac",
  buildingNumber: "1268",
  postalCode: "2501",
  town: "Biel",
  country: "CH",
};
const debtor = {
  name: "Pia-Maria Rutschmann-Schnyder",
  street: "Grosse Marktgasse",
  buildingNumber: "28",
  postalCode: "9400",
  town: "Rorschach",
  country: "CH",
};
const base: QrBillData = {
  iban: QR_IBAN,
  creditor,
  amountCents: 194975,
  currency: "CHF",
  debtor,
  referenceType: "QRR",
  reference: QRR,
  message: "Rechnung Nr. 3139 für Gartenarbeiten",
};

describe("IBAN", () => {
  it("erkennt gültige und ungültige Prüfziffern", () => {
    for (const i of [QR_IBAN, IBAN, "CH9300762011623852957", "CH5604835012345678009"])
      expect(isValidIban(i)).toBe(true);
    expect(isValidIban("CH9300762011623852958")).toBe(false);
    expect(isValidIban("")).toBe(false);
    expect(isValidIban("DE89 3704 0044 0532 0130 00")).toBe(true);
  });
  it("unterscheidet QR-IBAN (IID 30000-31999) von normaler IBAN", () => {
    expect(isQrIban(QR_IBAN)).toBe(true);
    expect(isQrIban(IBAN)).toBe(false);
    expect(isQrIban("CH93 0076 2011 6238 5295 7")).toBe(false);
  });
  it("lässt für die QR-Rechnung nur CH/LI zu und formatiert in Vierergruppen", () => {
    expect(isSwissOrLiIban("DE89370400440532013000")).toBe(false);
    expect(isSwissOrLiIban(" ch44 3199 9123 0008 8901 2 ")).toBe(true);
    expect(formatIban(QR_IBAN)).toBe("CH44 3199 9123 0008 8901 2");
  });
});

describe("QR-Referenz (Modulo 10 rekursiv)", () => {
  it("liefert die Prüfziffer des SIX-Beispiels", () => {
    expect(mod10Check("21000000000313947143000901")).toBe("7");
    expect(isValidQrr(QRR)).toBe(true);
    expect(makeQrr("21000000000313947143000901")).toBe(QRR);
  });
  it("lehnt falsche Prüfziffer, falsche Länge und Buchstaben ab", () => {
    expect(isValidQrr("210000000003139471430009018")).toBe(false);
    expect(isValidQrr("21000000000313947143000901")).toBe(false);
    expect(isValidQrr("2100000000031394714300090A7")).toBe(false);
  });
  it("füllt links mit Nullen auf und formatiert 2-5-5-5-5-5", () => {
    expect(makeQrr("1")).toHaveLength(27);
    expect(isValidQrr(makeQrr("1"))).toBe(true);
    expect(formatQrr(QRR)).toBe("21 00000 00003 13947 14300 09017");
    expect(() => makeQrr("1".repeat(27))).toThrow();
  });
});

describe("SCOR (ISO 11649)", () => {
  it("prüft bekannte und erzeugte Referenzen", () => {
    expect(isValidScor("RF18539007547034")).toBe(true);
    expect(isValidScor("RF19539007547034")).toBe(false);
    expect(makeScor("539007547034")).toBe("RF18539007547034");
    expect(isValidScor(makeScor("20260000042"))).toBe(true);
    expect(formatScor("RF18539007547034")).toBe("RF18 5390 0754 7034");
  });
});

describe("Payload", () => {
  it("entspricht Zeile für Zeile der Spezifikation (Version 0200, Typ S)", () => {
    const lines = buildQrPayload(base).split("\n");
    expect(lines.slice(0, 4)).toEqual(["SPC", "0200", "1", QR_IBAN]);
    expect(lines.slice(4, 11)).toEqual([
      "S",
      "Robert Schneider AG",
      "Rue du Lac",
      "1268",
      "2501",
      "Biel",
      "CH",
    ]);
    expect(lines.slice(11, 18)).toEqual(["", "", "", "", "", "", ""]); // endgültiger Empfänger leer
    expect(lines.slice(18, 20)).toEqual(["1949.75", "CHF"]);
    expect(lines[21]).toBe("Pia-Maria Rutschmann-Schnyder");
    expect(lines.slice(27, 31)).toEqual([
      "QRR",
      QRR,
      "Rechnung Nr. 3139 für Gartenarbeiten",
      "EPD",
    ]);
  });
  it("lässt Betrag und Zahlungspflichtigen leer, wenn offen", () => {
    const lines = buildQrPayload({ ...base, amountCents: null, debtor: null }).split("\n");
    expect(lines[18]).toBe("");
    expect(lines.slice(20, 27)).toEqual(["", "", "", "", "", "", ""]);
  });
  it("formatiert den Betrag ohne Tausendertrenner mit zwei Stellen", () => {
    expect(buildQrPayload({ ...base, amountCents: 5 }).split("\n")[18]).toBe("0.05");
    expect(buildQrPayload({ ...base, amountCents: 100000000 }).split("\n")[18]).toBe("1000000.00");
  });
  it("verlangt für QR-IBAN die QR-Referenz und für normale IBAN SCOR oder NON", () => {
    const scor = { iban: IBAN, referenceType: "SCOR" as const, reference: "RF18539007547034" };
    expect(() => buildQrPayload({ ...base, referenceType: "NON", reference: undefined })).toThrow(
      QrBillError,
    );
    expect(() => buildQrPayload({ ...base, iban: IBAN })).toThrow(QrBillError);
    expect(() => buildQrPayload({ ...base, ...scor })).not.toThrow();
    expect(() =>
      buildQrPayload({ ...base, iban: IBAN, referenceType: "NON", reference: undefined }),
    ).not.toThrow();
    expect(() => buildQrPayload({ ...base, iban: IBAN, referenceType: "NON" })).toThrow();
  });
  it("lehnt ungültige Referenz, IBAN, Beträge, Längen und Zeichen ab", () => {
    expect(() => buildQrPayload({ ...base, reference: "210000000003139471430009018" })).toThrow();
    expect(() => buildQrPayload({ ...base, iban: "DE89370400440532013000" })).toThrow();
    expect(() => buildQrPayload({ ...base, amountCents: 0 })).toThrow();
    expect(() => buildQrPayload({ ...base, amountCents: 100_000_000_000 })).toThrow();
    expect(() =>
      buildQrPayload({ ...base, creditor: { ...creditor, name: "x".repeat(71) } }),
    ).toThrow();
    expect(() => buildQrPayload({ ...base, creditor: { ...creditor, name: "Łódź AG" } })).toThrow();
    expect(() => buildQrPayload({ ...base, creditor: { ...creditor, name: "A\nB" } })).toThrow();
    expect(() => buildQrPayload({ ...base, message: "x".repeat(141) })).toThrow();
    expect(() =>
      buildQrPayload({ ...base, message: "x".repeat(100), billInfo: "y".repeat(41) }),
    ).toThrow();
    expect(() => buildQrPayload({ ...base, currency: "USD" as "CHF" })).toThrow();
  });
  it("wandelt freien Text best effort in den QR-Zeichensatz", () => {
    expect(toQrLatin("Łódź\tAG")).toBe("Lódz AG");
    expect(toQrLatin("Müller Café")).toBe("Müller Café");
    expect(toQrLatin("日本")).toBe("??");
  });
  it("passt als QR-Code (Fehlerkorrektur M) in Version 25 oder kleiner", () => {
    const qr = QRCode.create(buildQrPayload(base), { errorCorrectionLevel: "M" });
    expect(qr.version).toBeLessThanOrEqual(25);
    expect(qr.errorCorrectionLevel.bit).toBe(0); // M
  });
});
