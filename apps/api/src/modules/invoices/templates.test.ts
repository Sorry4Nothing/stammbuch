import { describe, expect, it } from "vitest";
import { CANCEL_MAIL, INVOICE_MAIL, renderTemplate } from "./templates.js";

describe("Mailtexte des Servers", () => {
  const values = {
    invoice: "RE-2026-0001",
    creditNote: "GS-2026-0001",
    issueDate: "01.11.2026",
    dueDate: "01.12.2026",
    amount: "CHF 265.94",
    org: "Musterverein",
  };

  it("setzen die Nummern in den Betreff und alle Platzhalter in den Text (Sie-Form)", () => {
    const cancel = renderTemplate(CANCEL_MAIL, values);
    expect(cancel.subject).toBe("Storno der Rechnung RE-2026-0001");
    expect(cancel.text).toContain("Gutschrift GS-2026-0001");
    expect(cancel.text).toMatch(/Musterverein$/);
    const invoice = renderTemplate(INVOICE_MAIL, values);
    expect(invoice.subject).toBe("Rechnung RE-2026-0001 vom 01.11.2026");
    expect(invoice.text).toContain("über CHF 265.94, zahlbar bis 01.12.2026");
    for (const m of [cancel, invoice]) expect(`${m.subject}${m.text}`).not.toMatch(/\{\w+\}/);
  });

  it("lässt unbekannte Platzhalter leer und wertet Werte nicht aus", () => {
    const out = renderTemplate(
      { subject: "{unbekannt}A", text: "{org}" },
      { org: "Verein {invoice}" },
    );
    expect(out).toEqual({ subject: "A", text: "Verein {invoice}" });
  });
});
