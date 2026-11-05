import { createMemoryRepositories, MailService, SecretBox } from "@stammbuch/mail";
import type { ConnectionFactory, MailContext } from "@stammbuch/mail";
import { describe, expect, it } from "vitest";
import { mailServicePort, textToHtml } from "./mail-port.js";

const ctx: MailContext = { tenantId: "t1", userId: "u1", email: "ich@example.test" };
const who = { tenantId: "t1", userId: "u1" };
const key = Buffer.alloc(32, 3).toString("base64");

function setup() {
  const repos = createMemoryRepositories();
  const connections: ConnectionFactory = {
    checkEndpoint: async () => undefined,
    smtp: async () => {
      throw new Error("Der Versand gehört dem Worker");
    },
    imap: async () => {
      throw new Error("nicht benötigt");
    },
  };
  const service = new MailService({
    repos,
    box: new SecretBox({ keys: { k1: key }, currentKeyId: "k1" }),
    connections,
  });
  const addAccount = () =>
    service.addAccount(ctx, {
      label: "Verein",
      fromAddress: "verein@example.test",
      username: "u",
      password: "pw",
      smtp: { host: "smtp.example.test", port: 587, security: "starttls" },
    });
  return { repos, service, addAccount };
}

const message = {
  to: { email: "anna@example.org", name: "Anna Muster" },
  subject: "Einladung: Sommerfest",
  text: "Guten Tag Anna\n\nBitte antworten:\nhttps://app.example.org/antwort/abc_DEF-123",
};

describe("textToHtml", () => {
  it("maskiert HTML, macht https-Adressen zu Links und setzt Zeilenumbrüche", () => {
    expect(textToHtml("<b>Hi</b> & Tschüss\nhttps://x.example/a?b=1&c=2")).toBe(
      '<p>&lt;b&gt;Hi&lt;/b&gt; &amp; Tschüss<br><a href="https://x.example/a?b=1&amp;c=2">https://x.example/a?b=1&amp;c=2</a></p>',
    );
  });

  it("entschärft Platzhalter in Nutzereingaben", () => {
    expect(textToHtml("Titel {{name}}")).not.toContain("{{");
  });
});

describe("Kalender-MailPort über das Mail-Modul", () => {
  it("legt eine Einzelmail in die Queue des Kontos der einladenden Person", async () => {
    const { repos, service, addAccount } = setup();
    const account = await addAccount();
    const port = mailServicePort(service, async () => ctx);

    await port.send(who, message);

    const [delivery] = await repos.campaigns.listDue(new Date(Date.now() + 1000), 10);
    expect(delivery?.recipient).toMatchObject({ email: "anna@example.org", name: "Anna Muster" });
    const campaign = await repos.campaigns.getById(delivery!.campaignId);
    expect(campaign).toMatchObject({
      accountId: account.id,
      kind: "transactional",
      state: "confirmed",
      subject: "Einladung: Sommerfest",
    });
    expect(campaign?.bodyHtml).toContain('href="https://app.example.org/antwort/abc_DEF-123"');
  });

  it("nimmt einen Eventtitel mit Platzhalter-Syntax an", async () => {
    const { service, addAccount } = setup();
    await addAccount();
    const port = mailServicePort(service, async () => ctx);
    await expect(
      port.send(who, {
        ...message,
        subject: "Einladung: {{evil}}",
        text: "Sie sind eingeladen: {{evil}}",
      }),
    ).resolves.toBeUndefined();
  });

  it("scheitert ohne Mailkonto (die Einladung wird dann zurückgenommen)", async () => {
    const { service } = setup();
    const port = mailServicePort(service, async () => ctx);
    await expect(port.send(who, message)).rejects.toThrow();
  });

  it("scheitert ohne Mail-Kontext (fail secure)", async () => {
    const { service, addAccount } = setup();
    await addAccount();
    const port = mailServicePort(service, async () => null);
    await expect(port.send(who, message)).rejects.toThrow("Mail-Kontext");
  });
});
