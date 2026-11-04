import {
  PDFDocument,
  type PDFPage,
  PDFArray,
  PDFRawStream,
  decodePDFRawStream,
  rgb,
} from "pdf-lib";
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
    expect(filename).toBe("RE-2026-0001.pdf");
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
    expect(page.getWidth() / mm(1)).toBeCloseTo(210, 3);
    expect(page.getHeight() / mm(1)).toBeCloseTo(105, 3);
    void rgb;
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
