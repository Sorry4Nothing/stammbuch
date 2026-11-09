import {
  PDFDocument,
  type PDFPage,
  PDFArray,
  PDFRawStream,
  decodePDFRawStream,
  rgb,
} from "pdf-lib";
import jsQRModule from "jsqr";
import { describe, expect, it } from "vitest";
import { buildQrPayload } from "../qrbill.js";
import { makeQrr } from "../reference.js";
import {
  IBAN,
  QR_IBAN,
  TENANT,
  invoiceInput,
  makeService,
  settingsInput,
} from "../test-fixtures.js";
import { SLIP_HEIGHT_MM, drawQrSlip } from "./qrslip.js";
import { mm } from "./text.js";
import { StandardFonts } from "pdf-lib";

// Node liefert die Funktion als Default; die Typen von jsqr beschreiben das Modul-Objekt.
const jsQR = jsQRModule as unknown as typeof jsQRModule.default;

const A4 = { w: 595.28, h: 841.89 };
const hex = (s: string) => Buffer.from(s, "latin1").toString("hex").toUpperCase();

/** Entpackte Inhaltsströme einer Seite als Text (Schrift wird als Hex ausgegeben). */
function content(page: PDFPage): string {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
  return streams
    .map((ref) => {
      const s = page.doc.context.lookup(ref);
      if (!(s instanceof PDFRawStream)) return "";
      return Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
    })
    .join("\n");
}

async function load(bytes: Uint8Array) {
  expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
  return PDFDocument.load(bytes);
}

async function booked(over = {}, input = {}) {
  const ctx = makeService();
  await ctx.service.saveSettings(TENANT, settingsInput(over));
  const d = await ctx.service.createDraft(TENANT, invoiceInput(input));
  const v = await ctx.service.send(TENANT, d.invoice.id);
  return { ...ctx, id: v.invoice.id, draftId: d.invoice.id };
}

describe("Rechnungs-PDF", () => {
  it("erzeugt A4 mit Zahlteil in den unteren 105 mm", async () => {
    const { service, id } = await booked();
    const { pdf, filename } = await service.invoicePdf(TENANT, id);
    expect(filename).toBe("Rechnung_RE-2026-0001.pdf");
    const doc = await load(pdf);
    expect(doc.getPageCount()).toBe(1);
    const page = doc.getPage(0);
    expect(page.getWidth()).toBeCloseTo(A4.w, 1);
    expect(page.getHeight()).toBeCloseTo(A4.h, 1);
    const text = content(page);
    for (const t of ["Empfangsschein", "Zahlteil", "Rechnung RE-2026-0001", "Annahmestelle", "CHF"])
      expect(text).toContain(hex(t));
    // Betrag im Zahlteil: 265.94 und die formatierte QR-Referenz
    expect(text).toContain(hex("265.94"));
    expect(text).toContain(hex("CH44 3199 9123 0008 8901 2"));
  });

  it("Papier ist weiss: kein Hintergrund, nur schwarze und graue Füllungen", async () => {
    const { service, id } = await booked();
    const doc = await load((await service.invoicePdf(TENANT, id)).pdf);
    const text = content(doc.getPage(0));
    // Farben: nur Grau-/Schwarz- (g) bzw. RGB mit gleichen Anteilen; keine ganzseitige Fläche.
    const fills = [...text.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg/g)];
    for (const [, r, g, b] of fills) expect(r === g && g === b).toBe(true);
    expect(text).not.toMatch(/0 0 595\.28 841\.89 re/);
  });

  it("Entwurf trägt keinen Zahlteil, Gutschrift und bezahlte Rechnung ebenfalls nicht", async () => {
    const ctx = await booked();
    const draft = await load((await ctx.service.invoicePdf(TENANT, ctx.draftId)).pdf).catch(
      () => null,
    );
    expect(draft).not.toBeNull();
    const newDraft = await ctx.service.createDraft(TENANT, invoiceInput());
    const d = await load((await ctx.service.invoicePdf(TENANT, newDraft.invoice.id)).pdf);
    expect(content(d.getPage(0))).not.toContain(hex("Empfangsschein"));
    expect(content(d.getPage(0))).toContain(hex("(Entwurf)"));

    await ctx.service.cancel(TENANT, ctx.id);
    const notes = await ctx.service.list(TENANT, { kind: "credit_note", limit: 5, offset: 0 });
    const note = notes.items[0]!.invoice;
    const { pdf, filename } = await ctx.service.invoicePdf(TENANT, note.id);
    expect(filename).toBe("GS-2026-0001.pdf");
    const g = content((await load(pdf)).getPage(0));
    expect(g).toContain(hex("Gutschrift GS-2026-0001"));
    expect(g).toContain(hex("-265.94"));
    expect(g).not.toContain(hex("Empfangsschein"));
    const cancelled = content(
      (await load((await ctx.service.invoicePdf(TENANT, ctx.id)).pdf)).getPage(0),
    );
    expect(cancelled).not.toContain(hex("Empfangsschein"));
  });

  it("verträgt Sonderzeichen und sehr lange Wörter ohne Fehler", async () => {
    const { service, id } = await booked(
      {},
      {
        subject: "Zeichen: € – „Test“ 日本 \u0000",
        lines: [
          {
            description: "W".repeat(300) + "\nzweite Zeile ñ ü é",
            quantityMilli: 1000,
            unitCents: 100,
            vatRateBp: 0,
          },
        ],
      },
    );
    const doc = await load((await service.invoicePdf(TENANT, id)).pdf);
    const last = doc.getPage(doc.getPageCount() - 1);
    expect(content(last)).toContain(hex("Empfangsschein"));
  });

  it("bricht bei vielen Positionen um und setzt den Zahlteil nur auf die letzte Seite", async () => {
    const lines = Array.from({ length: 120 }, (_, i) => ({
      description: `Position ${i + 1}`,
      quantityMilli: 1000,
      unitCents: 1000,
      vatRateBp: 0,
    }));
    const { service, id } = await booked({}, { lines });
    const doc = await load((await service.invoicePdf(TENANT, id)).pdf);
    const n = doc.getPageCount();
    expect(n).toBeGreaterThan(2);
    doc.getPages().forEach((p, i) => {
      const has = content(p).includes(hex("Empfangsschein"));
      expect(has).toBe(i === n - 1);
    });
  });

  it("SCOR-Rechnung zeigt die Referenz in Vierergruppen", async () => {
    const { service, id } = await booked({ iban: IBAN });
    const doc = await load((await service.invoicePdf(TENANT, id)).pdf);
    expect(content(doc.getPage(0))).toContain(hex("CH58 0079 1123 0008 8901 2"));
    expect(content(doc.getPage(0))).toMatch(/<5246/); // "RF..." Referenz
  });
});

describe("Mahn-PDF", () => {
  it("zeigt Stufe, Gebühren und Gesamtbetrag und trägt den Zahlteil über den Gesamtbetrag", async () => {
    const { service, id } = await booked();
    await service.issueReminder(TENANT, id, "2026-12-11");
    const r2 = await service.issueReminder(TENANT, id, "2026-12-22");
    expect(r2.level).toBe(2);
    const { pdf, filename } = await service.reminderPdf(TENANT, id, 2);
    expect(filename).toBe("mahnung-2-RE-2026-0001.pdf");
    const doc = await load(pdf);
    expect(doc.getPageCount()).toBe(1);
    const text = content(doc.getPage(0));
    expect(text).toContain(hex("1. Mahnung"));
    expect(text).toContain(hex("20.00")); // Gebühr
    expect(text).toContain(hex("285.94")); // 265.94 + 20.00
    expect(text).toContain(hex("Empfangsschein"));
    await expect(service.reminderPdf(TENANT, id, 3)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("Zahlteil-Geometrie (SIX)", () => {
  it("QR-Code 46 x 46 mm an Position 67/17 mm, Zahlteil 210 x 105 mm", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([mm(210), mm(SLIP_HEIGHT_MM)]);
    const rects: { x: number; y: number; width: number; height: number; black: boolean }[] = [];
    const orig = page.drawRectangle.bind(page);
    page.drawRectangle = (o) => {
      const c = o?.color as { red?: number } | undefined;
      rects.push({
        x: o?.x ?? 0,
        y: o?.y ?? 0,
        width: o?.width ?? 0,
        height: o?.height ?? 0,
        black: c?.red === 0,
      });
      return orig(o);
    };
    const lines: { x1: number; x2: number }[] = [];
    const origLine = page.drawLine.bind(page);
    page.drawLine = (o) => {
      lines.push({ x1: o.start.x, x2: o.end.x });
      return origLine(o);
    };
    const fonts = {
      regular: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold),
    };
    drawQrSlip(page, fonts, {
      iban: QR_IBAN,
      creditor: settingsInput().creditor,
      amountCents: 5000,
      currency: "CHF",
      referenceType: "QRR",
      reference: makeQrr("42"),
    });
    const dark = rects.filter((r) => r.black);
    const minX = Math.min(...dark.map((r) => r.x));
    const maxX = Math.max(...dark.map((r) => r.x + r.width));
    const minY = Math.min(...dark.map((r) => r.y));
    const maxY = Math.max(...dark.map((r) => r.y + r.height));
    // Finder-Muster liegen in drei Ecken, also spannt die dunkle Fläche den ganzen Code auf.
    expect(minX / mm(1)).toBeCloseTo(67, 1);
    expect((maxX - minX) / mm(1)).toBeCloseTo(46, 1);
    expect((maxY - minY) / mm(1)).toBeCloseTo(46, 1);
    expect((SLIP_HEIGHT_MM * mm(1) - maxY) / mm(1)).toBeCloseTo(17, 1); // 17 mm von oben
    // Schweizer Kreuz: weisses Quadrat 7 x 7 mm in der Mitte
    const white = rects.find((r) => !r.black && Math.abs(r.width - mm(7)) < 0.01);
    expect(white).toBeDefined();
    expect((white!.x + mm(3.5) - minX) / mm(1)).toBeCloseTo(23, 1);
    // Kreuz-Raster der SIX-Vorlage (19.8 Einheiten = 7 mm, Quelle: Implementation Guidelines v2.4,
    // 6.4.2 für 7 x 7 mm; Innenmasse aus dem Logo): schwarzes Quadrat 18.4, Balken 3.3 x 11, zentriert.
    const u = mm(7) / 19.8;
    const i = rects.indexOf(white!);
    const [sq, vBar, hBar] = rects.slice(i + 1, i + 4);
    const cx = white!.x + mm(3.5);
    const cy = white!.y + mm(3.5);
    const centered = (r: typeof white) => [r!.x + r!.width / 2 - cx, r!.y + r!.height / 2 - cy];
    expect(sq!.black).toBe(true);
    expect([sq!.width / u, sq!.height / u]).toEqual([
      expect.closeTo(18.4, 3),
      expect.closeTo(18.4, 3),
    ]);
    expect([vBar!.width / u, vBar!.height / u]).toEqual([
      expect.closeTo(3.3, 3),
      expect.closeTo(11, 3),
    ]);
    expect([hBar!.width / u, hBar!.height / u]).toEqual([
      expect.closeTo(11, 3),
      expect.closeTo(3.3, 3),
    ]);
    for (const r of [sq, vBar, hBar]) {
      expect(r!.black).toBe(r === sq);
      expect(centered(r as typeof white)[0]).toBeCloseTo(0, 3);
      expect(centered(r as typeof white)[1]).toBeCloseTo(0, 3);
    }
    // Empfangsschein 62 mm breit (Trennlinie), Zahlteil 148 mm (Guidelines v2.4, 3.1)
    expect(
      lines.some((l) => Math.abs(l.x1 - mm(62)) < 0.01 && Math.abs(l.x2 - mm(62)) < 0.01),
    ).toBe(true);
    expect(page.getWidth() / mm(1)).toBeCloseTo(210, 3);
    expect(page.getHeight() / mm(1)).toBeCloseTo(105, 3);
    void rgb;
  });

  it("der gezeichnete QR-Code ist mit Schweizer Kreuz lesbar und liefert den Payload zurück", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([mm(210), mm(SLIP_HEIGHT_MM)]);
    const rects: { x: number; y: number; width: number; height: number; red: number }[] = [];
    const orig = page.drawRectangle.bind(page);
    page.drawRectangle = (o) => {
      const c = o?.color as { red?: number } | undefined;
      rects.push({
        x: o?.x ?? 0,
        y: o?.y ?? 0,
        width: o?.width ?? 0,
        height: o?.height ?? 0,
        red: c?.red ?? 0,
      });
      return orig(o);
    };
    let circles = 0;
    const origCircle = page.drawCircle.bind(page);
    page.drawCircle = (o) => (circles++, origCircle(o));
    const fonts = {
      regular: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold),
    };
    const data = {
      iban: QR_IBAN,
      creditor: settingsInput().creditor,
      amountCents: 26594,
      currency: "CHF" as const,
      debtor: {
        name: "Erika Beispiel",
        street: "Teststrasse",
        buildingNumber: "1",
        postalCode: "3000",
        town: "Bern",
        country: "CH",
      },
      referenceType: "QRR" as const,
      reference: makeQrr("20260000018"),
      message: "Rechnung RE-2026-0001 - Grösse äöü",
    };
    drawQrSlip(page, fonts, data);
    // Zwei Scherensymbole mit je zwei Griffringen und einer weissen Unterlage.
    expect(circles).toBe(6);

    // Die tatsächlich gezeichneten Rechtecke in ein Bitmap übertragen (10 px/mm, 5 mm Ruhezone) und dekodieren.
    const PX = 10;
    const pad = 5 * PX;
    const size = 46 * PX + 2 * pad;
    const buf = new Uint8ClampedArray(size * size * 4).fill(255);
    const left = mm(67);
    const top = mm(SLIP_HEIGHT_MM - 17); // Oberkante des QR-Codes (pdf-Koordinaten, y nach oben)
    for (const r of rects) {
      if (r.x < left - 1 || r.x > left + mm(46) + 1) continue; // nur der QR-Bereich
      if (r.y > top + 1 || r.y < top - mm(46) - 1) continue;
      const x0 = Math.round(((r.x - left) / mm(1)) * PX) + pad;
      const x1 = Math.round(((r.x + r.width - left) / mm(1)) * PX) + pad;
      const y0 = Math.round(((top - (r.y + r.height)) / mm(1)) * PX) + pad;
      const y1 = Math.round(((top - r.y) / mm(1)) * PX) + pad;
      const v = r.red === 0 ? 0 : 255;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * size + xx) * 4;
          buf[i] = buf[i + 1] = buf[i + 2] = v;
        }
    }
    const decoded = jsQR(buf, size, size, { inversionAttempts: "dontInvert" });
    expect(decoded).not.toBeNull();
    expect(decoded!.data).toBe(buildQrPayload(data));
  });

  it("verweigert einen ungültigen Zahlteil, statt falsch zu drucken", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([mm(210), mm(105)]);
    const fonts = {
      regular: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold),
    };
    expect(() =>
      drawQrSlip(page, fonts, {
        iban: QR_IBAN,
        creditor: settingsInput().creditor,
        amountCents: 5000,
        currency: "CHF",
        referenceType: "QRR",
        reference: "123",
      }),
    ).toThrow();
    expect(buildQrPayload).toBeTypeOf("function");
  });
});
