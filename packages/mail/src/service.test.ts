import { describe, expect, it } from "vitest";
import { MailError } from "./net-guard.js";
import type { GroupLookup } from "./ports.js";
import { MailService } from "./service.js";
import {
  accountInput,
  ctxA,
  ctxOtherTenant,
  ctxOtherUser,
  fakeConnections,
  makeService,
} from "./test-helpers.js";
import type { ReadMessage } from "./types.js";

const code = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as MailError).code;

async function withAccount() {
  const fake = fakeConnections();
  const t = makeService({}, fake.factory);
  const account = await t.service.addAccount(ctxA, accountInput);
  return { ...t, fake, account };
}

const body = { subject: "Hallo {{vorname}}", bodyHtml: "<p>{{anrede}}</p>" };

describe("Konten und Zugangsdaten", () => {
  it("speichert das Passwort verschlüsselt und gibt es nie zurück", async () => {
    const t = await withAccount();
    expect(JSON.stringify(t.account)).not.toContain("app-passwort");
    expect(t.account).not.toHaveProperty("secretEnc");
    const stored = await t.repos.accounts.get("t1", t.account.id);
    expect(stored?.secretEnc).not.toContain("app-passwort");
    expect(t.box.decrypt(stored!.secretEnc, t.account.id)).toBe("app-passwort");
    expect(JSON.stringify(await t.service.listAccounts(ctxA))).not.toContain("secretEnc");
  });

  it("trennt Mandanten und Nutzer (Objektberechtigung)", async () => {
    const t = await withAccount();
    expect(await t.service.listAccounts(ctxOtherUser)).toEqual([]);
    expect(await t.service.listAccounts(ctxOtherTenant)).toEqual([]);
    for (const other of [ctxOtherUser, ctxOtherTenant]) {
      expect(await code(t.service.deleteAccount(other, t.account.id))).toBe("NOT_FOUND");
      expect(await code(t.service.verifyAccount(other, t.account.id))).toBe("NOT_FOUND");
      expect(await code(t.service.inbox(other, t.account.id, "INBOX", 1, 20))).toBe("NOT_FOUND");
      expect(
        await code(
          t.service.prepareCampaign(other, {
            accountId: t.account.id,
            ...body,
            manual: [{ email: "a@example.test" }],
          }),
        ),
      ).toBe("NOT_FOUND");
    }
  });

  it("prüft die Server-Angaben vor dem Speichern (SSRF)", async () => {
    const blocking = fakeConnections().factory;
    blocking.checkEndpoint = async () => {
      throw new MailError("BLOCKED_HOST");
    };
    const t = makeService({}, blocking);
    expect(await code(t.service.addAccount(ctxA, accountInput))).toBe("BLOCKED_HOST");
    expect(await t.service.listAccounts(ctxA)).toEqual([]);
  });

  it("Rotation verschlüsselt alle Konten mit dem neuen Schlüssel neu", async () => {
    const t = await withAccount();
    const { SecretBox } = await import("./crypto.js");
    const k = (n: number) => Buffer.alloc(32, n).toString("base64");
    const box2 = new SecretBox({ keys: { k1: k(7), k2: k(2) }, currentKeyId: "k2" });
    const svc = new MailService({ repos: t.repos, box: box2, connections: t.connections });
    expect(await svc.rotateSecrets()).toBe(1);
    expect(await svc.rotateSecrets()).toBe(0);
    const stored = await t.repos.accounts.get("t1", t.account.id);
    expect(stored?.secretEnc.split(".")[1]).toBe("k2");
    expect(box2.decrypt(stored!.secretEnc, t.account.id)).toBe("app-passwort");
  });
});

describe("Bestätigung vor Massenversand (serverseitig)", () => {
  const prep = (t: Awaited<ReturnType<typeof withAccount>>, emails: string[]) =>
    t.service.prepareCampaign(ctxA, {
      accountId: t.account.id,
      ...body,
      manual: emails.map((email) => ({ email })),
    });

  it("mehrere Empfänger: Versand ruht, bis das Token passt; Token ist einmalig", async () => {
    const t = await withAccount();
    const p = await prep(t, ["a@example.test", "b@example.test"]);
    expect(p).toMatchObject({ confirmed: false, recipientCount: 2 });
    expect(p.confirmationToken).toMatch(/^[\w-]{40,}$/);
    expect((await t.service.getCampaignStatus(ctxA, p.campaignId)).counts.held).toBe(2);

    expect(await code(t.service.confirmCampaign(ctxA, p.campaignId, "falsch"))).toBe("FORBIDDEN");
    expect(
      await code(t.service.confirmCampaign(ctxOtherUser, p.campaignId, p.confirmationToken!)),
    ).toBe("NOT_FOUND");
    expect(
      await code(t.service.confirmCampaign(ctxOtherTenant, p.campaignId, p.confirmationToken!)),
    ).toBe("NOT_FOUND");

    const status = await t.service.confirmCampaign(ctxA, p.campaignId, p.confirmationToken!);
    expect(status.counts).toMatchObject({ held: 0, queued: 2 });
    expect(await code(t.service.confirmCampaign(ctxA, p.campaignId, p.confirmationToken!))).toBe(
      "CONFLICT",
    );
  });

  it("Token verfällt", async () => {
    const t = await withAccount();
    const p = await prep(t, ["a@example.test", "b@example.test"]);
    t.advance(31 * 60_000);
    expect(await code(t.service.confirmCampaign(ctxA, p.campaignId, p.confirmationToken!))).toBe(
      "CONFLICT",
    );
  });

  it("Status und Kampagnenliste enthalten weder Token noch Token-Hash", async () => {
    const t = await withAccount();
    const p = await prep(t, ["a@example.test", "b@example.test"]);
    const status = await t.service.getCampaignStatus(ctxA, p.campaignId);
    expect(JSON.stringify(status)).not.toMatch(/tokenHash|"confirmation"|secretEnc/i);
    expect(JSON.stringify(await t.service.listCampaigns(ctxA))).not.toMatch(
      /tokenHash|"confirmation"/i,
    );
  });

  it("Einzelempfänger braucht keine Bestätigung", async () => {
    const t = await withAccount();
    const p = await prep(t, ["a@example.test"]);
    expect(p).toMatchObject({ confirmed: true, confirmationToken: null });
    expect((await t.service.getCampaignStatus(ctxA, p.campaignId)).counts.queued).toBe(1);
  });

  it("abgebrochene Kampagne lässt sich nicht mehr bestätigen", async () => {
    const t = await withAccount();
    const p = await prep(t, ["a@example.test", "b@example.test"]);
    await t.service.cancelCampaign(ctxA, p.campaignId);
    expect(await code(t.service.confirmCampaign(ctxA, p.campaignId, p.confirmationToken!))).toBe(
      "CONFLICT",
    );
  });

  it("dedupliziert, meldet ungültige Adressen und fehlende Platzhalterwerte", async () => {
    const t = await withAccount();
    const p = await t.service.prepareCampaign(ctxA, {
      accountId: t.account.id,
      subject: "Hallo {{vorname}}",
      bodyHtml: "<p>{{antwortlink}}</p>",
      manual: [
        { email: "A@example.test", vorname: "Anna", antwortlink: "https://x.example.test/1" },
        { email: "a@example.test" },
        { email: "kaputt" },
        { email: "x@example.test\r\nBcc: y@example.test" },
        { email: "b@example.test", antwortlink: "javascript:alert(1)" },
      ],
    });
    expect(p.recipientCount).toBe(2);
    expect(p.rejected.map((r) => r.reason).sort()).toEqual(["duplicate", "invalid", "invalid"]);
    expect(p.missingValues).toEqual({ vorname: 1, antwortlink: 1 });
  });

  it("lehnt unbekannte Platzhalter, leeren Betreff, leere Empfänger und zu viele Empfänger ab", async () => {
    const t = await withAccount();
    const base = { accountId: t.account.id, manual: [{ email: "a@example.test" }] };
    expect(
      await code(
        t.service.prepareCampaign(ctxA, { ...base, subject: "{{process}}", bodyHtml: "<p>x</p>" }),
      ),
    ).toBe("VALIDATION");
    expect(
      await code(
        t.service.prepareCampaign(ctxA, { ...base, subject: "  \r\n ", bodyHtml: "<p>x</p>" }),
      ),
    ).toBe("VALIDATION");
    expect(
      await code(t.service.prepareCampaign(ctxA, { ...base, subject: "x", bodyHtml: "" })),
    ).toBe("VALIDATION");
    expect(await code(t.service.prepareCampaign(ctxA, { accountId: t.account.id, ...body }))).toBe(
      "VALIDATION",
    );
    const small = makeService({ maxRecipients: 2 }, t.connections);
    const acc = await small.service.addAccount(ctxA, accountInput);
    expect(
      await code(
        small.service.prepareCampaign(ctxA, {
          accountId: acc.id,
          ...body,
          manual: ["a", "b", "c"].map((n) => ({ email: `${n}@example.test` })),
        }),
      ),
    ).toBe("TOO_LARGE");
  });

  it("Versandplan: Vergangenheit = sofort, mehr als ein Jahr voraus ist ungültig", async () => {
    const t = await withAccount();
    const base = { accountId: t.account.id, ...body, manual: [{ email: "a@example.test" }] };
    const past = await t.service.prepareCampaign(ctxA, { ...base, sendAt: new Date("2020-01-01") });
    expect((await t.service.getCampaignStatus(ctxA, past.campaignId)).campaign.scheduledAt).toEqual(
      t.now(),
    );
    expect(
      await code(t.service.prepareCampaign(ctxA, { ...base, sendAt: new Date("2030-01-01") })),
    ).toBe("VALIDATION");
  });
});

describe("Adresslisten und Gruppen", () => {
  it("zieht Empfänger aus Handliste und Gruppen (GroupLookup) und dedupliziert", async () => {
    const t = await withAccount();
    const seen: string[][] = [];
    const groups: GroupLookup = {
      async membersOf(ctx, ids) {
        seen.push(ids);
        return [{ email: "gruppe@example.test", vorname: "Gina" }, { email: "hand@example.test" }];
      },
    };
    const svc = new MailService({
      repos: t.repos,
      box: t.box,
      connections: t.connections,
      groups,
      now: t.now,
    });
    const list = await svc.createList(ctxA, {
      name: "Vorstand",
      manual: [{ email: "hand@example.test" }],
      groupIds: ["g1"],
    });
    const p = await svc.prepareCampaign(ctxA, {
      accountId: t.account.id,
      ...body,
      listIds: [list.id],
      groupIds: ["g2"],
      manual: [{ email: "extra@example.test" }],
    });
    expect(p.recipientCount).toBe(3);
    expect(seen[0]?.sort()).toEqual(["g1", "g2"]);
    expect(p.rejected).toEqual([{ email: "hand@example.test", reason: "duplicate" }]);
  });

  it("Listen sind pro Nutzer und Mandant isoliert", async () => {
    const t = await withAccount();
    const list = await t.service.createList(ctxA, {
      name: "L",
      manual: [{ email: "a@example.test" }],
    });
    expect(await t.service.listLists(ctxOtherUser)).toEqual([]);
    expect(await code(t.service.getList(ctxOtherTenant, list.id))).toBe("NOT_FOUND");
    expect(await code(t.service.deleteList(ctxOtherUser, list.id))).toBe("NOT_FOUND");
    const upd = await t.service.updateList(ctxA, list.id, {
      name: "Neu",
      manual: [{ email: "b@example.test" }],
    });
    expect(upd.manual.map((r) => r.email)).toEqual(["b@example.test"]);
  });
});

describe("Anhänge", () => {
  it("werden einmal gespeichert; mehrere Mails verweisen nur per ID darauf", async () => {
    const t = await withAccount();
    const att = await t.service.addAttachment(ctxA, "Programm.pdf", Buffer.from("%PDF-1.7 x"));
    await t.service.prepareCampaign(ctxA, {
      accountId: t.account.id,
      ...body,
      attachmentIds: [att.id],
      manual: [{ email: "a@example.test" }, { email: "b@example.test" }],
    });
    const stored = await t.repos.attachments.get("t1", att.id);
    expect(stored?.bytes.toString()).toBe("%PDF-1.7 x");
    expect(att).not.toHaveProperty("bytes");
  });

  it("fremde oder unbekannte Anhänge sind nicht verwendbar", async () => {
    const t = await withAccount();
    const att = await t.service.addAttachment(ctxA, "x.pdf", Buffer.from("%PDF-1.7 x"));
    const input = { accountId: t.account.id, ...body, manual: [{ email: "a@example.test" }] };
    expect(await code(t.service.prepareCampaign(ctxA, { ...input, attachmentIds: ["nope"] }))).toBe(
      "NOT_FOUND",
    );
    const other = await t.service.addAccount(ctxOtherUser, accountInput);
    expect(
      await code(
        t.service.prepareCampaign(ctxOtherUser, {
          ...input,
          accountId: other.id,
          attachmentIds: [att.id],
        }),
      ),
    ).toBe("NOT_FOUND");
  });
});

describe("Testversand", () => {
  it("geht nur an die eigene Adresse des Nutzers, mit [TEST]-Betreff, ohne Warteschlange", async () => {
    const t = await withAccount();
    await t.service.testSend(ctxA, {
      accountId: t.account.id,
      ...body,
      manual: [{ email: "kunde@example.test", vorname: "Anna" }],
    });
    expect(t.fake.state.sent).toHaveLength(1);
    const mail = t.fake.state.sent[0]!;
    expect(mail.to).toEqual([{ name: "Anna", address: "ich@example.test" }]);
    expect(mail.subject).toBe("[TEST] Hallo Anna");
    expect(mail.html).toContain("background-color:#ffffff");
    expect((await t.service.listCampaigns(ctxA)).length).toBe(0);
  });
});

describe("Posteingang, Lesen, Antworten", () => {
  const original: ReadMessage = {
    uid: 7,
    from: { name: "Bea <script>", address: "bea@example.test" },
    to: [{ address: "verein@example.test" }],
    subject: "Frage",
    date: "2026-11-01T10:00:00.000Z",
    messageId: "<abc@example.test>",
    references: ["<alt@example.test>", "kaputt\r\nBcc: x@y.z"],
    html: '<p onclick="x()">Hallo</p><script>alert(1)</script><img src="https://tracker.example.test/p.gif">',
    text: "Hallo <b>Verein</b>",
    attachments: [],
  };

  it("liefert den Posteingang und sanitisiert beim Lesen (kein Skript, keine Remote-Bilder)", async () => {
    const t = await withAccount();
    t.fake.state.inbox.push(original);
    const page = await t.service.inbox(ctxA, t.account.id, "INBOX", 1, 20);
    expect(page.messages[0]?.uid).toBe(7);
    const msg = await t.service.readMessage(ctxA, t.account.id, "INBOX", 7);
    expect(msg.html).toBe("<p>Hallo</p>");
    expect(await code(t.service.readMessage(ctxA, t.account.id, "INBOX", 99))).toBe("NOT_FOUND");
  });

  it("antwortet an den Absender des Originals, mit Threading und ohne Header-Injection", async () => {
    const t = await withAccount();
    t.fake.state.inbox.push(original);
    await t.service.reply(ctxA, t.account.id, "INBOX", 7, "<p>Danke!</p>");
    const mail = t.fake.state.sent[0]!;
    expect(mail.to[0]?.address).toBe("bea@example.test");
    expect(mail.subject).toBe("Re: Frage");
    expect(mail.inReplyTo).toBe("<abc@example.test>");
    expect(mail.references).toEqual(["<alt@example.test>", "<abc@example.test>"]);
    expect(mail.html).toContain("Danke!");
    expect(mail.html).toContain("&lt;b&gt;Verein&lt;/b&gt;"); // Zitat maskiert
    expect(mail.html).not.toContain("<script");
  });

  it("prüft Ordnernamen", async () => {
    const t = await withAccount();
    for (const f of ["../x", "a\r\nb", "", "a".repeat(101)]) {
      expect(await code(t.service.inbox(ctxA, t.account.id, f, 1, 20))).toBe("VALIDATION");
    }
  });

  it("Konto ohne IMAP kann keinen Posteingang öffnen", async () => {
    const t = makeService({}, fakeConnections().factory);
    const acc = await t.service.addAccount(ctxA, { ...accountInput, imap: undefined });
    expect(await code(t.service.inbox(ctxA, acc.id, "INBOX", 1, 20))).toBe("VALIDATION");
  });
});

describe("Transaktionsmail (MailPort)", () => {
  it("geht ohne Bestätigung in die Queue, Standardkonto des Nutzers", async () => {
    const t = await withAccount();
    const { campaignId } = await t.service.sendTransactional(ctxA, {
      to: { email: "neu@example.test", vorname: "Neo" },
      subject: "Willkommen {{vorname}}",
      bodyHtml: "<p>{{anrede}}</p>",
    });
    const status = await t.service.getCampaignStatus(ctxA, campaignId);
    expect(status.counts.queued).toBe(1);
    expect(status.campaign.kind).toBe("transactional");
  });

  it("ohne Konto: NOT_FOUND", async () => {
    const t = makeService();
    expect(
      await code(
        t.service.sendTransactional(ctxA, {
          to: { email: "a@example.test" },
          subject: "x",
          bodyHtml: "<p>x</p>",
        }),
      ),
    ).toBe("NOT_FOUND");
  });
});
