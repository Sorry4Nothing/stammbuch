import { describe, expect, it } from "vitest";
import { REMINDER_MAIL, reminderMail } from "./templates";

describe("Mailtext der Mahnung", () => {
  const values = {
    title: "1. Mahnung",
    invoice: "RE-2026-0001",
    issueDate: "01.11.2026",
    total: "CHF 270.00",
    dueOn: "20.12.2026",
    org: "Musterverein",
  };

  it("setzt alle Platzhalter ein: Rechnungsnummer im Betreff, Sie-Form, Vereinsname", () => {
    const mail = reminderMail(values);
    expect(mail.subject).toBe("1. Mahnung zur Rechnung RE-2026-0001");
    expect(mail.message).toContain("Zur Rechnung RE-2026-0001 vom 01.11.2026");
    expect(mail.message).toContain("1. Mahnung über CHF 270.00");
    expect(mail.message).toContain("bis zum 20.12.2026");
    expect(mail.message).toMatch(/Musterverein$/);
    expect(`${mail.subject}${mail.message}`).not.toMatch(/\{\w+\}/);
  });

  it("nutzt nur die Platzhalter, die es kennt", () => {
    const keys = new Set(
      [...`${REMINDER_MAIL.subject}${REMINDER_MAIL.message}`.matchAll(/\{(\w+)\}/g)].map(
        (m) => m[1],
      ),
    );
    expect([...keys].sort()).toEqual(Object.keys(values).sort());
  });

  it("wertet Werte nicht aus: Klammern im Namen bleiben stehen", () => {
    expect(reminderMail({ ...values, org: "Verein {title}" }).message).toMatch(/Verein \{title\}$/);
  });
});
