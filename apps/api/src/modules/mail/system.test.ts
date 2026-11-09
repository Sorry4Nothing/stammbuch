import { MailError } from "@stammbuch/mail";
import type { ConnectionFactory, MailAccount, OutgoingMail } from "@stammbuch/mail";
import { describe, expect, it } from "vitest";
import {
  loadSystemMailer,
  mailerInvitationSender,
  mailerRegistrationSender,
  systemAuthMail,
  textToHtml,
} from "./system.js";

const ENV = {
  MAIL_SYSTEM_HOST: "smtp.anbieter.test",
  MAIL_SYSTEM_USER: "system@anbieter.test",
  MAIL_SYSTEM_PASSWORD: "geheim-nur-im-test",
  MAIL_SYSTEM_FROM: "noreply@anbieter.test",
};
const ORIGIN = "https://app.test";

function fakeFactory(opts: { fail?: boolean } = {}) {
  const sent: { account: MailAccount; password: string; mail: OutgoingMail }[] = [];
  let closed = 0;
  const factory: ConnectionFactory = {
    checkEndpoint: async () => undefined,
    imap: async () => {
      throw new Error("nicht benötigt");
    },
    smtp: async (account, password) => ({
      send: async (mail) => {
        if (opts.fail) throw new MailError("TRANSIENT");
        sent.push({ account, password, mail });
        return { messageId: "id" };
      },
      verify: async () => undefined,
      close: () => void closed++,
    }),
  };
  return { factory, sent, closed: () => closed };
}

const logger = () => {
  const lines: { obj: object; msg: string }[] = [];
  return { lines, log: (obj: object, msg: string) => void lines.push({ obj, msg }) };
};

describe("Systemmailer", () => {
  it("ohne MAIL_SYSTEM_HOST ist er aus; unvollständige Angaben brechen den Start ab", () => {
    expect(loadSystemMailer({})).toBeNull();
    expect(() => loadSystemMailer({ MAIL_SYSTEM_HOST: "smtp.anbieter.test" })).toThrow();
    expect(() => loadSystemMailer({ ...ENV, MAIL_SYSTEM_FROM: "keine-adresse" })).toThrow();
    expect(() => loadSystemMailer({ ...ENV, MAIL_SYSTEM_SECURITY: "klartext" })).toThrow();
    expect(() =>
      loadSystemMailer({ ...ENV, MAIL_ALLOW_PRIVATE_HOSTS: "true", NODE_ENV: "production" }),
    ).toThrow("Produktion");
  });

  it("sendet über TLS/STARTTLS-Postfach des Anbieters, maskiert den Inhalt und schliesst die Verbindung", async () => {
    const f = fakeFactory();
    const mailer = loadSystemMailer(ENV, f.factory)!;
    await mailer.send({
      to: "anna@verein.test",
      subject: "Betreff\r\nBcc: boese@example.test",
      text: "Hallo <script>alert(1)</script>\nhttps://app.test/einladung#abc_DEF-1",
    });
    expect(f.closed()).toBe(1);
    const { account, password, mail } = f.sent[0]!;
    expect(account.smtp).toEqual({ host: "smtp.anbieter.test", port: 587, security: "starttls" });
    expect(account.username).toBe("system@anbieter.test");
    expect(password).toBe("geheim-nur-im-test");
    expect(mail.from.address).toBe("noreply@anbieter.test");
    expect(mail.to).toEqual([{ address: "anna@verein.test" }]);
    // Kein Zeilenumbruch im Betreff (Header-Injection, SR-20).
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain('<a href="https://app.test/einladung#abc_DEF-1">');
    // Mail-Papier ist immer hell (Projektplan 3.6).
    expect(mail.html).toContain("background:#ffffff");
  });

  it("schliesst die Verbindung auch bei einem Fehler", async () => {
    const f = fakeFactory({ fail: true });
    const mailer = loadSystemMailer(ENV, f.factory)!;
    await expect(mailer.send({ to: "a@b.test", subject: "x", text: "y" })).rejects.toBeInstanceOf(
      MailError,
    );
    expect(f.closed()).toBe(1);
  });

  it("textToHtml maskiert Anführungszeichen und Tags", () => {
    expect(textToHtml('"><img src=x onerror=alert(1)>')).not.toContain("<img");
  });
});

describe("Einladungsmail", () => {
  const message = {
    to: "neu@verein.test",
    token: "tok_en-123",
    tenantName: "Verein <b>Test</b>",
    expiresAt: "2026-11-12T10:00:00.000Z",
  };

  it("enthält den Link mit dem Token im Fragment und den Ablauf, der Kundenname ist maskiert", async () => {
    const f = fakeFactory();
    const sender = mailerInvitationSender(loadSystemMailer(ENV, f.factory)!, ORIGIN, () => {});
    await sender.send(message);
    const { mail } = f.sent[0]!;
    expect(mail.to).toEqual([{ address: "neu@verein.test" }]);
    expect(mail.text).toContain("https://app.test/einladung#tok_en-123");
    expect(mail.text).toContain("12. November 2026");
    expect(mail.html).not.toContain("<b>Test</b>");
  });

  it("ein Fehler beim Versand lässt die Anfrage nicht scheitern und steht im Log ohne Empfänger und Token", async () => {
    const f = fakeFactory({ fail: true });
    const l = logger();
    const sender = mailerInvitationSender(loadSystemMailer(ENV, f.factory)!, ORIGIN, l.log);
    await expect(sender.send(message)).resolves.toBeUndefined();
    expect(l.lines).toHaveLength(1);
    const text = JSON.stringify(l.lines);
    expect(text).toContain("TRANSIENT");
    expect(text).not.toContain("tok_en-123");
    expect(text).not.toContain("neu@verein.test");
  });
});

describe("Mails des Auth-Moduls", () => {
  const reset = {
    to: "anna@verein.test",
    link: "https://app.test/passwort-zuruecksetzen#tok_en-123",
    expiresAt: new Date("2026-11-05T12:00:00.000Z"),
  };

  it("der Link zum Zurücksetzen geht per Mail raus", async () => {
    const f = fakeFactory();
    const mail = systemAuthMail(loadSystemMailer(ENV, f.factory)!, () => {});
    await mail.sendPasswordReset(reset);
    expect(f.sent[0]!.mail.to).toEqual([{ address: "anna@verein.test" }]);
    expect(f.sent[0]!.mail.text).toContain(reset.link);
    expect(f.sent[0]!.mail.subject).toBe("Stammbuch: Passwort zurücksetzen");
  });

  it("ohne Systemmailer oder bei einem Fehler wirft der Versand (das Auth-Modul protokolliert es)", async () => {
    await expect(systemAuthMail(null, () => {}).sendPasswordReset(reset)).rejects.toThrow();
    const l = logger();
    const mail = systemAuthMail(loadSystemMailer(ENV, fakeFactory({ fail: true }).factory)!, l.log);
    await expect(mail.sendPasswordReset(reset)).rejects.toBeInstanceOf(MailError);
    const text = JSON.stringify(l.lines);
    expect(text).not.toContain("tok_en-123");
    expect(text).not.toContain("anna@verein.test");
  });

  it("Sicherheitsmeldungen stehen weiter nur im Log, ohne Empfänger", async () => {
    const l = logger();
    await systemAuthMail(null, l.log).sendSecurityNotice({
      kind: "password_changed",
      to: "anna@verein.test",
      at: new Date(0),
    });
    expect(JSON.stringify(l.lines)).not.toContain("anna@verein.test");
  });
});

describe("Mails der Registrierung", () => {
  const base = {
    kundeId: "k1",
    kunde: "verein-a",
    an: "neu@verein.test",
    art: "person" as const,
    referenz: "ABCD-2345",
  };

  it("Bestätigungsmail: Link mit Token im Fragment, Ablauf und Referenz", async () => {
    const f = fakeFactory();
    const sender = mailerRegistrationSender(loadSystemMailer(ENV, f.factory)!, ORIGIN, () => {});
    await sender.send({
      ...base,
      vorlage: "registrierung_bestaetigen",
      token: "tok_en-123",
      gueltigBis: new Date("2026-11-12T10:00:00.000Z"),
    });
    const { mail } = f.sent[0]!;
    expect(mail.to).toEqual([{ address: "neu@verein.test" }]);
    expect(mail.text).toContain("https://app.test/registrierung/verein-a/bestaetigen#tok_en-123");
    expect(mail.text).toContain("12. November 2026");
    expect(mail.text).toContain("ABCD-2345");
  });

  it("alle drei Mails nennen den Vereinsnamen aus den Einstellungen, auch im Betreff (#130)", async () => {
    const f = fakeFactory();
    const asked: string[] = [];
    const sender = mailerRegistrationSender(
      loadSystemMailer(ENV, f.factory)!,
      ORIGIN,
      () => {},
      async (kundeId) => {
        asked.push(kundeId);
        return "Turnverein Beispiel";
      },
    );
    await sender.send({
      ...base,
      vorlage: "registrierung_bestaetigen",
      token: "t",
      gueltigBis: new Date(0),
    });
    await sender.send({ ...base, vorlage: "registrierung_bekannt" });
    await sender.send({ ...base, vorlage: "registrierung_eingegangen" });
    expect(asked).toEqual(["k1", "k1", "k1"]);
    for (const { mail } of f.sent) {
      expect(mail.subject).toContain("Turnverein Beispiel");
      expect(mail.text).toContain("Turnverein Beispiel");
      expect(mail.text).toContain("ABCD-2345");
      expect(mail.text).toContain("Freundliche Grüsse");
    }
    expect(f.sent.map((m) => m.mail.subject)).toEqual([
      "Turnverein Beispiel: Registrierung bestätigen",
      "Turnverein Beispiel: Registrierung",
      "Turnverein Beispiel: Registrierung eingegangen",
    ]);
  });

  it("ein Name mit Zeilenumbruch kann den Betreff nicht aufbrechen, ein Fehler beim Nachschlagen die Mail nicht verhindern", async () => {
    const f = fakeFactory();
    const mailer = loadSystemMailer(ENV, f.factory)!;
    const registration = { ...base, vorlage: "registrierung_bekannt" as const };
    await mailerRegistrationSender(
      mailer,
      ORIGIN,
      () => {},
      async () => "Verein\r\nBcc: x@y.test",
    ).send(registration);
    expect(f.sent[0]!.mail.subject).not.toMatch(/[\r\n]/);
    await mailerRegistrationSender(
      mailer,
      ORIGIN,
      () => {},
      () => Promise.reject(new Error("db")),
    ).send(registration);
    expect(f.sent[1]!.mail.subject).toBe("Stammbuch: Registrierung");
  });

  it('"bekannt" enthält keinen Link, die Eingangsbestätigung unterscheidet Person und Firma', async () => {
    const f = fakeFactory();
    const sender = mailerRegistrationSender(loadSystemMailer(ENV, f.factory)!, ORIGIN, () => {});
    await sender.send({ ...base, vorlage: "registrierung_bekannt" });
    await sender.send({ ...base, vorlage: "registrierung_eingegangen" });
    await sender.send({ ...base, art: "firma", vorlage: "registrierung_eingegangen" });
    const texts = f.sent.map((m) => m.mail.text);
    expect(texts[0]).not.toContain("https://");
    expect(texts[1]).not.toContain("prüft");
    expect(texts[2]).toContain("prüft Ihre Firma");
    for (const t of texts) expect(t).toContain("ABCD-2345");
  });

  it("ein Fehler oder fehlender Systemmailer wirft nicht und steht im Log ohne Empfänger und Token", async () => {
    const msg = { ...base, vorlage: "registrierung_bestaetigen" as const, token: "tok_en-123" };
    const l = logger();
    const failing = fakeFactory({ fail: true });
    await expect(
      mailerRegistrationSender(loadSystemMailer(ENV, failing.factory)!, ORIGIN, l.log).send(msg),
    ).resolves.toBeUndefined();
    await expect(mailerRegistrationSender(null, ORIGIN, l.log).send(msg)).resolves.toBeUndefined();
    expect(l.lines).toHaveLength(2);
    const text = JSON.stringify(l.lines);
    expect(text).toContain("TRANSIENT");
    expect(text).not.toContain("tok_en-123");
    expect(text).not.toContain("neu@verein.test");
  });
});
