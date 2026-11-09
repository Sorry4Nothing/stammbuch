import { describe, expect, it, vi } from "vitest";
import { createHttpSettingsService } from "./httpSettingsService";
import type { MailDraft } from "./model";

type Call = { path: string; method: string; headers: Record<string, string>; body: unknown };

function setup(replies: { status: number; body?: unknown }[]) {
  const calls: Call[] = [];
  const onUnauthorized = vi.fn();
  const fetchFn = vi.fn((path: string, init: RequestInit) => {
    const reply = replies.shift();
    if (!reply) throw new Error("keine Antwort vorbereitet");
    calls.push({
      path,
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Promise.resolve(
      new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
      }),
    );
  });
  const service = createHttpSettingsService({
    csrfToken: () => "csrf-1",
    onUnauthorized,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { calls, service, onUnauthorized };
}

const draft: MailDraft = {
  email: "verein@example.ch",
  username: "verein",
  password: "geheim",
  senderName: "Verein",
  imapHost: "imap.example.ch",
  imapPort: "993",
  imapSecurity: "tls",
  smtpHost: "smtp.example.ch",
  smtpPort: "465",
  smtpSecurity: "tls",
};
const invalidCode = { error: { code: "INVALID_CODE", message: "x" } };

describe("HTTP-Dienst der Einstellungen (#114)", () => {
  it("schaltet frei, was die API liefert, und lässt offen, was sie nicht liefert", () => {
    const { service } = setup([]);
    expect(service.features).toMatchObject({
      accountHolder: true,
      lastLogin: true,
      securityInfo: true,
      totpRenewal: true,
      licenceDetails: true,
      auditXlsx: true,
      legalForm: false,
      creditAccount: false,
      paymentDays: false,
      closing: false,
      auditResult: false,
    });
  });

  it("zeigt letzte Anmeldung (Zeit Zürich) und Stand des Einmalcodes, ohne zu erfinden", async () => {
    const { service } = setup([
      {
        status: 200,
        body: {
          items: [
            {
              id: "u1",
              email: "a@x.ch",
              name: "A",
              role: "admin",
              status: "active",
              createdAt: "2026-01-01T00:00:00Z",
              lastLoginAt: "2026-11-03T08:15:00.000Z",
              totpEnrolled: true,
            },
            {
              id: "u2",
              email: "b@x.ch",
              name: "B",
              role: "user",
              status: "invited",
              createdAt: "2026-01-01T00:00:00Z",
              lastLoginAt: null,
              totpEnrolled: false,
            },
          ],
        },
      },
    ]);
    expect(await service.listUsers()).toMatchObject([
      { id: "u1", lastLogin: "03.11.2026 09:15", totpEnrolled: true },
      { id: "u2", lastLogin: null, totpEnrolled: false },
    ]);
  });

  it("liest die eigene Anmeldung und rechnet Daten auf Zürcher Kalendertage", async () => {
    const { service, calls } = setup([
      {
        status: 200,
        body: {
          passwordChangedAt: "2026-08-13T22:30:00.000Z",
          totpSince: null,
          recoveryLeft: 8,
          recoveryTotal: 10,
        },
      },
    ]);
    expect(await service.loadSecurity()).toEqual({
      passwordChangedAt: "2026-08-14",
      totpSince: null,
      recoveryLeft: 8,
      recoveryTotal: 10,
    });
    expect(calls[0]?.path).toBe("/auth/security");
  });

  describe("Einmalcode neu einrichten", () => {
    it("verlangt zuerst den bisherigen Code und liefert dann den neuen Schlüssel", async () => {
      const { service, calls } = setup([
        { status: 200, body: { secret: "ABCD", otpauthUri: "otpauth://totp/x" } },
        { status: 204 },
      ]);
      expect(await service.beginTotpRenewal("123456")).toEqual({
        secret: "ABCD",
        otpauthUri: "otpauth://totp/x",
      });
      expect(calls[0]).toMatchObject({
        path: "/auth/2fa/renew",
        method: "POST",
        body: { code: "123456" },
        headers: { "X-CSRF-Token": "csrf-1" },
      });
      expect(await service.confirmTotpRenewal("654321")).toBe(true);
      expect(calls[1]).toMatchObject({
        path: "/auth/2fa/renew/confirm",
        body: { code: "654321" },
      });
    });

    it("ein falscher Code ist kein Sitzungsende: Rückgabe null bzw. false, kein Abmelden", async () => {
      const { service, onUnauthorized } = setup([
        { status: 401, body: invalidCode },
        { status: 401, body: invalidCode },
      ]);
      expect(await service.beginTotpRenewal("000000")).toBeNull();
      expect(await service.confirmTotpRenewal("000000")).toBe(false);
      expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it("eine beendete Sitzung meldet ab; Sperre (429) kommt als Fehler an", async () => {
      const { service, onUnauthorized } = setup([
        { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "x" } } },
        { status: 429, body: { error: { code: "RATE_LIMITED", message: "x" } } },
      ]);
      await expect(service.beginTotpRenewal("123456")).rejects.toMatchObject({ status: 401 });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      await expect(service.confirmTotpRenewal("123456")).rejects.toMatchObject({ status: 429 });
    });
  });

  describe("Mailkonto prüfen", () => {
    it("neue Angaben werden ohne Speichern geprüft, Testmail nur wenn alles gelingt", async () => {
      const { service, calls } = setup([
        { status: 200, body: { smtp: "ok", imap: "ok", testMail: "ok" } },
      ]);
      const stages: number[] = [];
      const out = await service.testMail(draft, {
        signal: new AbortController().signal,
        onStage: (n) => stages.push(n),
      });
      expect(calls).toHaveLength(1); // kein POST /mail/accounts, kein DELETE
      expect(calls[0]).toMatchObject({ path: "/mail/accounts/verify", method: "POST" });
      expect(calls[0]?.body).toMatchObject({
        password: "geheim",
        smtp: { host: "smtp.example.ch", port: 465, security: "tls" },
        testMail: { subject: "Testmail Stammbuch" },
      });
      expect(out.persisted).toBe(false);
      expect(out.failedAt).toBeUndefined();
      expect(out.stages.map((s) => s.status)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
      expect(out.sentAt).toBeInstanceOf(Date);
    });

    it("meldet die gescheiterte Stufe aus der Antwort der API", async () => {
      const { service } = setup([
        { status: 200, body: { smtp: "AUTH", imap: "ok", testMail: null } },
      ]);
      const out = await service.testMail(draft, {
        signal: new AbortController().signal,
        onStage: () => undefined,
      });
      expect(out.failedAt).toBe(4);
      expect(out.persisted).toBe(false);
      expect(out.sentAt).toBeUndefined();
    });

    it("scheitert die Testmail, steht die letzte Stufe auf «fehlgeschlagen»", async () => {
      const { service } = setup([
        { status: 200, body: { smtp: "ok", imap: "ok", testMail: "REJECTED" } },
      ]);
      const out = await service.testMail(draft, {
        signal: new AbortController().signal,
        onStage: () => undefined,
      });
      expect(out.failedAt).toBe(5);
      expect(out.stages[5]?.status).toBe("failed");
    });
  });

  it("speichert den Kontoinhaber im Bereich bank, nur wenn er sich ändert", async () => {
    const org = {
      master: {
        name: "V",
        street: "",
        zip: "",
        city: "",
        country: "CH",
        uid: "",
        vatNumber: "",
        email: "",
        phone: "",
        website: "",
      },
      sender: { name: "", email: "", replyTo: "", footer: "" },
      bank: { accountHolder: "Verein", bankName: "", iban: "", qrIban: "", bic: "" },
      "fiscal-year": { startMonth: 1 },
      modules: { sammelrechnung: false, mail: true, kalender: true },
      logo: null,
    };
    const { service, calls } = setup([
      { status: 200, body: org },
      { status: 200, body: { bank: {} } },
    ]);
    const loaded = await service.loadOrganisation();
    expect(loaded.data.accountHolder).toBe("Verein");
    await service.saveOrganisation(loaded.data); // nichts geändert, nichts gesendet
    expect(calls).toHaveLength(1);
    await service.saveOrganisation({ ...loaded.data, accountHolder: "Verein Neu" });
    expect(calls[1]).toMatchObject({
      path: "/settings/organisation/bank",
      method: "PUT",
      body: { accountHolder: "Verein Neu" },
    });
  });

  it("exportiert das Protokoll als .xlsx und liest die Kunden-ID der Lizenz", async () => {
    const { service, calls } = setup([{ status: 200, body: "x" }]);
    await service.exportAudit({ action: "user.add" });
    expect(calls[0]?.path).toBe("/settings/audit/export?action=user.add&format=xlsx");

    const licence = setup([
      {
        status: 200,
        body: {
          customerId: "c-1",
          state: "active",
          validUntil: "2027-12-31",
          readOnly: false,
          blocked: false,
        },
      },
      { status: 500 },
      { status: 500 },
    ]);
    expect(await licence.service.loadLicence()).toMatchObject({
      customerId: "c-1",
      validUntil: "2027-12-31",
    });
  });
});
