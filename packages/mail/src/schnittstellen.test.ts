import { describe, expect, it } from "vitest";
import { MailError } from "./net-guard.js";
import type { GroupLookup } from "./ports.js";
import { processDueDeliveries } from "./processor.js";
import { MailService } from "./service.js";
import {
  accountInput,
  ctxA,
  ctxOtherTenant,
  ctxOtherUser,
  fakeConnections,
  makeService,
} from "./test-helpers.js";
import { countAttachments } from "./transport.js";

const code = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as MailError).code;

async function withAccount() {
  const fake = fakeConnections();
  const t = makeService({}, fake.factory);
  const account = await t.service.addAccount(ctxA, accountInput);
  return { ...t, fake, account };
}

describe("Posteingang: Zähler, Gelesen, Löschen, Entwurf, Antwort mit Anhang (#112)", () => {
  it("leitet Gelesen und Löschen an den Server weiter und prüft Eingaben und Eigentümer", async () => {
    const t = await withAccount();
    await t.service.markRead(ctxA, t.account.id, "INBOX", [1, 2]);
    await t.service.deleteMessages(ctxA, t.account.id, "INBOX", [3]);
    expect(t.fake.state.seen).toEqual([{ folder: "INBOX", uids: [1, 2] }]);
    expect(t.fake.state.removed).toEqual([{ folder: "INBOX", uids: [3] }]);
    expect(await code(t.service.markRead(ctxA, t.account.id, "INBOX", []))).toBe("VALIDATION");
    expect(
      await code(t.service.deleteMessages(ctxA, t.account.id, "INBOX", Array(201).fill(1))),
    ).toBe("VALIDATION");
    expect(await code(t.service.markRead(ctxA, t.account.id, "../x", [1]))).toBe("VALIDATION");
    for (const other of [ctxOtherUser, ctxOtherTenant]) {
      expect(await code(t.service.markRead(other, t.account.id, "INBOX", [1]))).toBe("NOT_FOUND");
      expect(await code(t.service.deleteMessages(other, t.account.id, "INBOX", [1]))).toBe(
        "NOT_FOUND",
      );
      expect(await code(t.service.folderCounts(other, t.account.id, ["INBOX"]))).toBe("NOT_FOUND");
    }
    expect(t.fake.state.seen).toHaveLength(1);
    expect(t.fake.state.removed).toHaveLength(1);
  });

  it("Zähler: höchstens acht Ordner, doppelte nur einmal gefragt, fehlende fallen weg", async () => {
    const t = await withAccount();
    expect(await t.service.folderCounts(ctxA, t.account.id, ["INBOX", "INBOX", "Fehlt"])).toEqual([
      { folder: "INBOX", total: 0, unread: 0 },
    ]);
    expect(await code(t.service.folderCounts(ctxA, t.account.id, []))).toBe("VALIDATION");
    const nine = Array.from({ length: 9 }, (_, i) => `F${i}`);
    expect(await code(t.service.folderCounts(ctxA, t.account.id, nine))).toBe("VALIDATION");
  });

  it("Entwurf: bereinigt, mit Anhang, auch ohne Empfänger; fremde Anhänge scheitern", async () => {
    const t = await withAccount();
    const att = await t.service.addAttachment(ctxA, "Plan.pdf", Buffer.from("%PDF-1.7 plan"));
    await t.service.saveDraft(ctxA, t.account.id, {
      to: { email: "Eva@Example.test", name: "Eva" },
      subject: "Entwurf\r\nBcc: x@y.ch",
      bodyHtml: "<p>Hi</p><script>x()</script>",
      attachmentIds: [att.id],
    });
    await t.service.saveDraft(ctxA, t.account.id, { subject: "", bodyHtml: "" });
    const [first, second] = t.fake.state.drafts;
    expect(first?.to).toEqual([{ name: "Eva", address: "eva@example.test" }]);
    expect(first?.subject).not.toMatch(/[\r\n]/);
    expect(first?.html).not.toContain("<script");
    expect(first?.attachments?.map((a) => a.filename)).toEqual(["Plan.pdf"]);
    expect(second?.to).toEqual([]);

    const bad = { to: { email: "kaputt" }, subject: "", bodyHtml: "" };
    expect(await code(t.service.saveDraft(ctxA, t.account.id, bad))).toBe("VALIDATION");
    const mine = { subject: "x", bodyHtml: "y" };
    expect(await code(t.service.saveDraft(ctxOtherUser, t.account.id, mine))).toBe("NOT_FOUND");
    const other = await t.service.addAccount(ctxOtherUser, accountInput);
    const foreignFile = { ...mine, attachmentIds: [att.id] };
    expect(await code(t.service.saveDraft(ctxOtherUser, other.id, foreignFile))).toBe("NOT_FOUND");
    expect(t.fake.state.drafts).toHaveLength(2);
  });

  it("Antwort trägt die Anhänge des Benutzers", async () => {
    const t = await withAccount();
    t.fake.state.inbox.push({
      uid: 7,
      from: { address: "bea@example.test" },
      to: [],
      subject: "Frage",
      date: null,
      references: [],
      text: "Hallo",
      attachments: [],
    });
    const att = await t.service.addAttachment(ctxA, "Plan.pdf", Buffer.from("%PDF-1.7 plan"));
    await t.service.reply(ctxA, t.account.id, "INBOX", 7, "<p>Danke</p>", [att.id]);
    expect(t.fake.state.sent[0]?.attachments?.map((a) => a.filename)).toEqual(["Plan.pdf"]);
    expect(await code(t.service.reply(ctxA, t.account.id, "INBOX", 7, "<p>x</p>", ["fremd"]))).toBe(
      "NOT_FOUND",
    );
  });

  it("zählt Anhänge in der MIME-Struktur: Disposition oder Dateiname, Text ausgenommen", () => {
    expect(countAttachments(undefined)).toBe(0);
    expect(countAttachments({ type: "text/plain" })).toBe(0);
    expect(
      countAttachments({
        type: "multipart/mixed",
        childNodes: [
          {
            type: "multipart/alternative",
            childNodes: [{ type: "text/plain" }, { type: "text/html" }],
          },
          { type: "application/pdf", disposition: "attachment" },
          { type: "image/png", parameters: { name: "logo.png" } },
          { type: "text/plain", parameters: { name: "notiz.txt" } },
        ],
      }),
    ).toBe(2);
  });
});

describe("Adresslisten mit Personen, Zahlen und letzter Verwendung (#112)", () => {
  const people = [
    { id: "p1", name: "Eva Muster", email: "eva@example.test", vorname: "Eva", group: "Vorstand" },
    { id: "p2", name: "Paul Ohne", email: null, vorname: "Paul", group: null },
  ];
  const lookup: GroupLookup = {
    membersOf: async () => [{ email: "gruppe@example.test" }],
    groups: async () => [{ id: "g1", name: "Vorstand", persons: 2, withoutEmail: 1 }],
    people: async (_ctx, ids) => people.filter((p) => ids.includes(p.id)),
  };
  const make = () => {
    const t = makeService({}, fakeConnections().factory);
    const service = new MailService({
      repos: t.repos,
      box: t.box,
      connections: t.connections,
      groups: lookup,
      now: t.now,
    });
    return { ...t, service };
  };

  it("Zahlen: Handliste, Personen und Gruppen; Personen ohne Adresse zählen nicht als Empfänger", async () => {
    const { service } = make();
    const list = await service.createList(ctxA, {
      name: "Alle",
      description: "Zeile 1\nZeile 2",
      manual: [{ email: "hand@example.test" }],
      groupIds: ["g1", "gibt-es-nicht"],
      personIds: ["p1", "p2", "p1"],
    });
    expect(list).toMatchObject({ description: "Zeile 1 Zeile 2", personIds: ["p1", "p2"] });
    const view = await service.viewList(ctxA, list);
    expect(view.stats).toEqual({ persons: 5, withoutEmail: 2, recipients: 3 });
    expect(view.people.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(await service.listGroups(ctxA)).toHaveLength(1);
  });

  it("Personen-IDs, die das Personenmodul nicht kennt, sind ungültig (Anlegen und Ändern)", async () => {
    const { service } = make();
    expect(await code(service.createList(ctxA, { name: "x", personIds: ["p9"] }))).toBe(
      "VALIDATION",
    );
    const list = await service.createList(ctxA, { name: "x", personIds: ["p1"] });
    expect(await code(service.updateList(ctxA, list.id, { personIds: ["p1", "p9"] }))).toBe(
      "VALIDATION",
    );
    // Ohne personIds im Update bleiben die Verweise erhalten.
    expect((await service.updateList(ctxA, list.id, { name: "y" })).personIds).toEqual(["p1"]);
  });

  it("Versand an eine Liste löst Personen auf, vermerkt Verwendung, Listenname und Bestätigung", async () => {
    const { service, now } = make();
    const account = await service.addAccount(ctxA, accountInput);
    const list = await service.createList(ctxA, {
      name: "Vorstand",
      manual: [{ email: "hand@example.test" }],
      personIds: ["p1", "p2"],
    });
    expect(list.lastUsedAt).toBeUndefined();
    const anna = { ...ctxA, name: "Anna Muster" };
    const prep = await service.prepareCampaign(anna, {
      accountId: account.id,
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
      listIds: [list.id],
    });
    // Hand + Eva (Paul hat keine Adresse): 2 Empfänger, Bestätigung nötig.
    expect(prep.recipientCount).toBe(2);
    expect((await service.getList(ctxA, list.id)).lastUsedAt).toEqual(now());
    const before = await service.getCampaignStatus(ctxA, prep.campaignId);
    expect(before.campaign.listName).toBe("Vorstand");
    expect(before.campaign.confirmedBy).toBeUndefined();
    const confirmed = await service.confirmCampaign(anna, prep.campaignId, prep.confirmationToken!);
    expect(confirmed.campaign.confirmedBy).toBe("Anna Muster");
    const names = (await service.listDeliveries(ctxA, prep.campaignId, 0, 10)).map((d) => d.name);
    expect(names).toEqual([null, "Eva"]);
  });
});

describe("Versandplan: pausieren, sofort senden, Zeitpunkt ändern (#112)", () => {
  async function plan() {
    const t = await withAccount();
    const p = await t.service.prepareCampaign(ctxA, {
      accountId: t.account.id,
      subject: "Plan",
      bodyHtml: "<p>Plan</p>",
      manual: [{ email: "a@example.test" }, { email: "b@example.test" }],
      sendAt: new Date(t.now().getTime() + 3_600_000),
    });
    return { ...t, id: p.campaignId, token: p.confirmationToken! };
  }

  it("pausiert nur bestätigte Versände; Zustellungen liegen dann auf «held»", async () => {
    const t = await plan();
    expect(await code(t.service.pauseCampaign(ctxA, t.id))).toBe("CONFLICT");
    await t.service.confirmCampaign(ctxA, t.id, t.token);
    const paused = await t.service.pauseCampaign(ctxA, t.id);
    expect(paused.campaign.state).toBe("paused");
    expect(paused.counts).toMatchObject({ held: 2, queued: 0 });
    expect(await code(t.service.pauseCampaign(ctxA, t.id))).toBe("CONFLICT");
  });

  it("sofort senden setzt fort und holt den Zeitpunkt auf jetzt; ohne Bestätigung nie", async () => {
    const t = await plan();
    expect(await code(t.service.sendCampaignNow(ctxA, t.id))).toBe("CONFLICT");
    expect((await t.service.getCampaignStatus(ctxA, t.id)).counts.held).toBe(2);
    await t.service.confirmCampaign(ctxA, t.id, t.token);
    await t.service.pauseCampaign(ctxA, t.id);
    const now = await t.service.sendCampaignNow(ctxA, t.id);
    expect(now.campaign).toMatchObject({ state: "confirmed", scheduledAt: t.now() });
    expect(now.counts).toMatchObject({ queued: 2, held: 0 });
  });

  it("Zeitpunkt ändern: Vergangenheit = jetzt, über ein Jahr ungültig, Wartende bleiben wartend", async () => {
    const t = await plan();
    const later = new Date(t.now().getTime() + 7_200_000);
    const waiting = await t.service.rescheduleCampaign(ctxA, t.id, later);
    expect(waiting.campaign).toMatchObject({ state: "awaiting_confirmation", scheduledAt: later });
    expect(waiting.counts).toMatchObject({ held: 2, queued: 0 });
    await t.service.confirmCampaign(ctxA, t.id, t.token);
    const tooFar = new Date(t.now().getTime() + 400 * 86_400_000);
    expect(await code(t.service.rescheduleCampaign(ctxA, t.id, tooFar))).toBe("VALIDATION");
    const past = await t.service.rescheduleCampaign(ctxA, t.id, new Date(0));
    expect(past.campaign.scheduledAt).toEqual(t.now());
  });

  it("abgebrochene Versände lassen sich nicht mehr steuern; fremde gibt es nicht", async () => {
    const t = await plan();
    await t.service.confirmCampaign(ctxA, t.id, t.token);
    await t.service.cancelCampaign(ctxA, t.id);
    const soon = new Date(t.now().getTime() + 1000);
    expect(await code(t.service.pauseCampaign(ctxA, t.id))).toBe("CONFLICT");
    expect(await code(t.service.sendCampaignNow(ctxA, t.id))).toBe("CONFLICT");
    expect(await code(t.service.rescheduleCampaign(ctxA, t.id, soon))).toBe("CONFLICT");
    for (const other of [ctxOtherUser, ctxOtherTenant]) {
      expect(await code(t.service.pauseCampaign(other, t.id))).toBe("NOT_FOUND");
      expect(await code(t.service.sendCampaignNow(other, t.id))).toBe("NOT_FOUND");
    }
  });
});

describe("Worker und Pause (#112)", () => {
  async function setup() {
    const t = await withAccount();
    const deps = {
      repos: t.repos,
      box: t.box,
      connections: t.fake.factory,
      now: t.now,
      random: () => 0.5,
    };
    const p = await t.service.prepareCampaign(ctxA, {
      accountId: t.account.id,
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
      manual: [{ email: "a@example.test" }, { email: "b@example.test" }],
    });
    await t.service.confirmCampaign(ctxA, p.campaignId, p.confirmationToken!);
    return { ...t, deps, id: p.campaignId };
  }

  it("pausierte Versände werden nicht gesendet; nach dem Fortsetzen gehen sie raus", async () => {
    const s = await setup();
    await s.service.pauseCampaign(ctxA, s.id);
    expect(await processDueDeliveries(s.deps)).toMatchObject({ sent: 0, failed: 0 });
    expect(s.fake.state.sent).toHaveLength(0);
    await s.service.sendCampaignNow(ctxA, s.id);
    expect((await processDueDeliveries(s.deps)).sent).toBe(2);
  });

  it("pausiert nach dem Übernehmen: zurück auf «held», kein Fehler, nichts gesendet", async () => {
    const s = await setup();
    const [due] = await s.repos.campaigns.listDue(s.now(), 10);
    await s.repos.campaigns.claim(due!.id, s.now(), new Date(s.now().getTime() + 120_000));
    // Pausiert zwischen Übernehmen und Senden: die übernommene Zustellung hängt auf «sending».
    await s.service.pauseCampaign(ctxA, s.id);
    s.advance(121_000);
    expect(await processDueDeliveries(s.deps)).toMatchObject({ sent: 0, failed: 0 });
    const { counts } = await s.service.getCampaignStatus(ctxA, s.id);
    expect(counts).toMatchObject({ held: 2, failed: 0, sent: 0 });
  });
});
