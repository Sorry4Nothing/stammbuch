import { describe, expect, it } from "vitest";
import { createHttpMailService } from "./httpMailService";
import { MailServiceError } from "./mailService";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Fetch-Attrappe: antwortet je Pfad, merkt sich jeden Aufruf. */
function fake(routes: Record<string, unknown | ((call: Call) => Response)>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const key = `${call.method} ${url.split("?")[0]}`;
    const route = routes[key];
    if (route === undefined) return new Response(null, { status: 404 });
    if (typeof route === "function") return (route as (c: Call) => Response)(call);
    return new Response(JSON.stringify(route), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const me = { "GET /auth/me": { csrfToken: "csrf-1" } };

describe("httpMailService", () => {
  it("liest den Posteingang und rechnet die API-Felder um", async () => {
    const { calls, fetchFn } = fake({
      "GET /mail/accounts/a1/inbox": {
        total: 128,
        messages: [
          {
            uid: 7,
            from: "Anna Beispiel",
            subject: "Frage",
            date: "2026-11-02T08:14:00Z",
            seen: false,
          },
        ],
      },
    });
    const page = await createHttpMailService(fetchFn).inbox("a1", "sent", 2, 16);
    expect(calls[0]!.url).toBe("/mail/accounts/a1/inbox?folder=Sent&page=2&pageSize=16");
    expect(calls[0]!.headers["X-CSRF-Token"]).toBeUndefined();
    expect(page.total).toBe(128);
    expect(page.messages[0]).toMatchObject({ uid: 7, from: "Anna Beispiel", seen: false });
  });

  it("wandelt HTML einer Mail in Text und liefert nie Markup", async () => {
    const { fetchFn } = fake({
      "GET /mail/accounts/a1/messages/3": {
        uid: 3,
        from: { name: "Anna", address: "anna@example.ch" },
        to: [{ address: "kontakt@example.ch" }],
        subject: "Hallo",
        date: null,
        html: "<p>Guten Tag</p><script>x()</script><p>Zwei</p>",
        text: null,
        attachments: [{ filename: "a.pdf", contentType: "application/pdf", size: 10 }],
      },
    });
    const mail = await createHttpMailService(fetchFn).read("a1", "inbox", 3);
    expect(mail.text).toBe("Guten Tag\n\nZwei");
    expect(mail.to[0]).toEqual({ name: null, address: "kontakt@example.ch" });
    expect(mail.attachments).toHaveLength(1);
  });

  it("holt das CSRF-Token einmal und sendet es bei Schreibzugriffen", async () => {
    const { calls, fetchFn } = fake({
      ...me,
      "POST /mail/campaigns": { campaignId: "c1", recipientCount: 1, confirmed: true },
    });
    const service = createHttpMailService(fetchFn);
    const mail = {
      accountId: "a1",
      to: "Anna Beispiel <anna@example.ch>",
      subject: "Betreff",
      body: "Hallo <b>Welt</b>\n\nZeile",
      attachmentIds: ["x1"],
    };
    await service.send(mail);
    await service.send(mail);
    expect(calls.filter((c) => c.url === "/auth/me")).toHaveLength(1);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.headers["X-CSRF-Token"]).toBe("csrf-1");
    expect(post.body).toEqual({
      accountId: "a1",
      subject: "Betreff",
      bodyHtml: "<p>Hallo &#60;b&#62;Welt&#60;/b&#62;</p><p>Zeile</p>",
      attachmentIds: ["x1"],
      manual: [{ email: "anna@example.ch", name: "Anna Beispiel" }],
    });
  });

  it("weist ungültige Adressen ab, bevor etwas gesendet wird", async () => {
    const { calls, fetchFn } = fake(me);
    await expect(
      createHttpMailService(fetchFn).send({
        accountId: "a1",
        to: "keine adresse",
        subject: "x",
        body: "y",
        attachmentIds: [],
      }),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(calls).toHaveLength(0);
  });

  it("ordnet Statuscodes einer Art zu, ohne den Text der Antwort zu übernehmen", async () => {
    const status = (code: number) =>
      createHttpMailService(
        fake({
          "GET /mail/accounts": () =>
            new Response(JSON.stringify({ error: { message: "geheimer Servertext" } }), {
              status: code,
            }),
        }).fetchFn,
      )
        .accounts()
        .catch((e: unknown) => e as MailServiceError);
    expect(await status(502)).toMatchObject({ kind: "mailServer", status: 502 });
    expect(await status(403)).toMatchObject({ kind: "forbidden" });
    // Sammelroute: 404 heisst «Modul aus».
    expect(await status(404)).toMatchObject({ kind: "notAvailable", status: 404 });
    expect(await status(500)).toMatchObject({ kind: "unavailable" });
    expect(String(((await status(502)) as MailServiceError).message)).not.toContain("geheimer");
  });

  it("meldet 404 einer einzelnen Adressliste als «nicht gefunden», nicht als «Modul aus»", async () => {
    const { fetchFn } = fake({ "GET /mail/groups": [] });
    const err = await createHttpMailService(fetchFn)
      .list("fehlt")
      .catch((e: unknown) => e as MailServiceError);
    expect(err).toMatchObject({ kind: "notFound", status: 404 });
  });

  it("liest Beantwortet, Anhangzahl und Ungelesene aus der Liste", async () => {
    const { fetchFn } = fake({
      "GET /mail/accounts/a1/inbox": {
        total: 3,
        unread: 2,
        messages: [
          {
            uid: 7,
            from: "Anna",
            subject: "S",
            date: null,
            seen: true,
            answered: true,
            attachments: 2,
          },
        ],
      },
    });
    const page = await createHttpMailService(fetchFn).inbox("a1", "inbox", 1, 16);
    expect(page.unread).toBe(2);
    expect(page.messages[0]).toMatchObject({ answered: true, attachments: 2 });
  });

  it("Zähler der Seitenleiste: ungelesene im Posteingang, sonst Gesamtzahl; ohne Konto keine", async () => {
    const routes = {
      "GET /mail/address-lists": [{ id: "l1" }],
      "GET /mail/campaigns": [],
    };
    const { calls, fetchFn } = fake({
      ...routes,
      "GET /mail/accounts": [{ id: "a 1" }],
      "GET /mail/accounts/a%201/counts": [
        { folder: "INBOX", total: 40, unread: 3 },
        { folder: "Drafts", total: 2, unread: 0 },
        { folder: "Trash", total: 9, unread: 0 },
      ],
    });
    expect(await createHttpMailService(fetchFn).counts()).toEqual({
      lists: 1,
      plan: 0,
      status: 0,
      inbox: 3,
      drafts: 2,
      trash: 9,
    });
    expect(calls.map((c) => c.url)).toContain(
      "/mail/accounts/a%201/counts?folders=INBOX,Drafts,Sent,Trash",
    );
    const none = fake({ ...routes, "GET /mail/accounts": [] });
    expect(await createHttpMailService(none.fetchFn).counts()).toEqual({
      lists: 1,
      plan: 0,
      status: 0,
    });
  });

  it("Zähler: Versandplan = ausstehend (auch pausiert), Versandstatus = laufend", async () => {
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const row = (id: string, state: string, scheduledAt: string, counts: object) => ({
      id,
      subject: id,
      state,
      scheduledAt,
      recipientCount: 5,
      attachmentIds: [],
      counts: { held: 0, queued: 0, sending: 0, sent: 0, failed: 0, cancelled: 0, ...counts },
    });
    const { fetchFn } = fake({
      "GET /mail/address-lists": [],
      "GET /mail/accounts": [],
      "GET /mail/campaigns": [
        row("laeuft", "confirmed", past, { queued: 3, sent: 2 }),
        row("fertig", "confirmed", past, { sent: 5 }),
        row("geplant", "confirmed", future, { queued: 5 }),
        row("pausiert", "paused", past, { held: 5 }),
        row("entwurf", "awaiting_confirmation", future, { held: 5 }),
        row("abgebrochen", "cancelled", past, { cancelled: 5 }),
      ],
    });
    expect(await createHttpMailService(fetchFn).counts()).toEqual({
      lists: 0,
      plan: 3,
      status: 1,
    });
  });

  it("Entwurf: die Kennung kommt zurück und geht beim nächsten Speichern als replaces mit", async () => {
    const answers = [{ saved: true, draftId: "<stammbuch-draft-1@x>" }, { saved: true }];
    const { calls, fetchFn } = fake({
      ...me,
      "POST /mail/accounts/a1/drafts": () => Response.json(answers.shift(), { status: 201 }),
    });
    const service = createHttpMailService(fetchFn);
    const draft = { accountId: "a1", to: "", subject: "S", body: "T", attachmentIds: [] };
    expect(await service.saveDraft(draft)).toEqual({ draftId: "<stammbuch-draft-1@x>" });
    expect(await service.saveDraft({ ...draft, replaces: "<stammbuch-draft-1@x>" })).toEqual({
      draftId: null,
    });
    const bodies = calls.filter((c) => c.url.endsWith("/drafts")).map((c) => c.body);
    expect(bodies[0]).not.toHaveProperty("replaces");
    expect(bodies[1]).toMatchObject({ replaces: "<stammbuch-draft-1@x>" });
  });

  it("gelesen, löschen, Entwurf und Antwort mit Anhang gehen an die Routen, mit CSRF-Token", async () => {
    const { calls, fetchFn } = fake({
      ...me,
      "POST /mail/accounts/a1/messages/mark-read": () => new Response(null, { status: 204 }),
      "POST /mail/accounts/a1/messages/delete": () => new Response(null, { status: 204 }),
      "POST /mail/accounts/a1/drafts": { saved: true },
      "POST /mail/accounts/a1/messages/4/reply": { messageId: "<m>" },
    });
    const service = createHttpMailService(fetchFn);
    await service.markRead("a1", "inbox", [1, 2]);
    await service.deleteMessages("a1", "trash", [3]);
    await service.saveDraft({
      accountId: "a1",
      to: "Anna Beispiel <anna@example.ch>",
      subject: "Betreff",
      body: "Text",
      attachmentIds: ["x"],
    });
    await service.saveDraft({ accountId: "a1", to: "", subject: "", body: "", attachmentIds: [] });
    await service.reply("a1", "inbox", 4, "Danke", ["att1"]);

    const body = (url: string) => calls.filter((c) => c.url.startsWith(url)).map((c) => c.body);
    expect(body("/mail/accounts/a1/messages/mark-read")).toEqual([
      { folder: "INBOX", uids: [1, 2] },
    ]);
    expect(body("/mail/accounts/a1/messages/delete")).toEqual([{ folder: "Trash", uids: [3] }]);
    expect(body("/mail/accounts/a1/drafts")).toEqual([
      {
        to: { email: "anna@example.ch", name: "Anna Beispiel" },
        subject: "Betreff",
        bodyHtml: "<p>Text</p>",
        attachmentIds: ["x"],
      },
      { subject: "", bodyHtml: "<p></p>", attachmentIds: [] },
    ]);
    expect(body("/mail/accounts/a1/messages/4/reply")).toEqual([
      { bodyHtml: "<p>Danke</p>", attachmentIds: ["att1"] },
    ]);
    for (const c of calls.filter((x) => x.method === "POST")) {
      expect(c.headers["X-CSRF-Token"], c.url).toBe("csrf-1");
    }
  });

  it("ein Entwurf mit ungültiger Adresse geht nicht an die API", async () => {
    const { calls, fetchFn } = fake(me);
    await expect(
      createHttpMailService(fetchFn).saveDraft({
        accountId: "a1",
        to: "keine adresse",
        subject: "",
        body: "",
        attachmentIds: [],
      }),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(calls).toHaveLength(0);
  });

  it("Versandplan: Zeitpunkt ändern, sofort senden, pausieren; angehalten ist ein eigener Zustand", async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const { calls, fetchFn } = fake({
      ...me,
      "POST /mail/campaigns/c1/reschedule": { campaign: {}, counts: {} },
      "POST /mail/campaigns/c1/send-now": { campaign: {}, counts: {} },
      "POST /mail/campaigns/c1/pause": { campaign: {}, counts: {} },
      "GET /mail/campaigns": [
        {
          id: "c1",
          subject: "S",
          state: "paused",
          scheduledAt: past,
          recipientCount: 2,
          attachmentIds: ["a", "b"],
          confirmedAt: past,
          confirmedBy: "Anna Muster",
          listName: "Vorstand",
        },
      ],
      "POST /mail/campaigns/c2/pause": () => new Response(null, { status: 409 }),
    });
    const service = createHttpMailService(fetchFn);
    const at = new Date(Date.now() + 3_600_000).toISOString();
    await service.reschedule("c1", at);
    await service.sendNow("c1");
    await service.pause("c1");
    expect(calls.filter((c) => c.method === "POST").map((c) => [c.url, c.body])).toEqual([
      ["/mail/campaigns/c1/reschedule", { sendAt: at }],
      ["/mail/campaigns/c1/send-now", {}],
      ["/mail/campaigns/c1/pause", {}],
    ]);
    await expect(service.pause("c2")).rejects.toMatchObject({ kind: "conflict" });
    expect((await service.campaigns())[0]).toMatchObject({
      state: "paused",
      listName: "Vorstand",
      confirmedBy: "Anna Muster",
      attachmentCount: 2,
    });
  });

  it("Zustellliste mit Empfängername", async () => {
    const { fetchFn } = fake({
      "GET /mail/campaigns/c1/deliveries": [
        { id: "d1", name: "Anna Beispiel", email: "anna@example.ch", status: "sent", sentAt: null },
        { id: "d2", email: "b@example.ch", status: "queued" },
      ],
    });
    const rows = await createHttpMailService(fetchFn).deliveries("c1", 0, 50);
    expect(rows.map((d) => d.name)).toEqual(["Anna Beispiel", null]);
  });

  it("baut Adresslisten aus Liste, Zahlen der API und Gruppen; Personen gehen als Verweis", async () => {
    const stats = (persons: number, withoutEmail: number) => ({
      persons,
      withoutEmail,
      recipients: persons - withoutEmail,
    });
    const { calls, fetchFn } = fake({
      ...me,
      "GET /mail/address-lists": [
        {
          id: "l1",
          name: "GV",
          description: "Alle",
          manual: [],
          groupIds: ["g1", "g2"],
          personIds: [],
          lastUsedAt: "2026-11-02T08:00:00Z",
          stats: stats(419, 12),
        },
        {
          id: "l2",
          name: "Intern",
          manual: [{ email: "a@example.ch", vorname: "A" }],
          groupIds: [],
          personIds: [],
          lastUsedAt: null,
          stats: stats(1, 0),
        },
      ],
      "GET /mail/groups": [
        { id: "g1", name: "Vorstand", persons: 7, withoutEmail: 0 },
        { id: "g2", name: "Aktiv", persons: 412, withoutEmail: 12 },
      ],
      "GET /mail/address-lists/l3": {
        id: "l3",
        name: "Neu",
        description: "Beschreibung",
        manual: [],
        groupIds: [],
        personIds: ["p1", "p2"],
        stats: stats(2, 1),
        people: [
          {
            id: "p1",
            name: "Eva Muster",
            email: "eva@example.ch",
            group: "Vorstand",
            vorname: "Eva",
          },
          { id: "p2", name: "Paul Ohne", email: null, group: null },
        ],
      },
      "POST /mail/address-lists": {
        id: "l3",
        name: "Neu",
        manual: [],
        groupIds: [],
        personIds: [],
        stats: stats(0, 0),
      },
    });
    const service = createHttpMailService(fetchFn);
    const [groups, manual] = await service.lists();
    expect(groups).toMatchObject({
      kind: "groups",
      source: "Vorstand und 1 weitere",
      persons: 419,
      withoutEmail: 12,
      recipients: 407,
      lastUsedAt: "2026-11-02T08:00:00Z",
    });
    expect(manual).toMatchObject({ kind: "manual", persons: 1, withoutEmail: 0, recipients: 1 });
    expect(await service.groups()).toEqual([
      { id: "g1", name: "Vorstand", persons: 7, withoutEmail: 0 },
      { id: "g2", name: "Aktiv", persons: 412, withoutEmail: 12 },
    ]);

    const detail = await service.list("l3");
    expect(detail.description).toBe("Beschreibung");
    expect(detail.entries).toMatchObject([
      { key: "p1", personId: "p1", name: "Eva Muster", email: "eva@example.ch", group: "Vorstand" },
      { key: "p2", personId: "p2", name: "Paul Ohne", email: null },
    ]);
    expect((await service.previewRecipient("l3"))?.name).toBe("Eva Muster");

    await service.saveList({
      name: "Neu",
      description: "Beschreibung",
      groupIds: [],
      entries: [
        { key: "p1", personId: "p1", name: "Eva", email: "eva@example.ch", group: null },
        { key: "p2", personId: "p2", name: "Paul", email: null, group: null },
        { key: "1", name: "A", email: "a@example.ch", group: null, vorname: "A" },
        { key: "2", name: "B", email: null, group: null },
      ],
    });
    const post = calls.find((c) => c.method === "POST" && c.url === "/mail/address-lists")!;
    expect(post.body).toEqual({
      name: "Neu",
      description: "Beschreibung",
      groupIds: [],
      personIds: ["p1", "p2"],
      manual: [{ email: "a@example.ch", vorname: "A" }],
    });
  });

  it("Personensuche liefert auch Personen ohne Adresse, mit Verweis auf die Person", async () => {
    const { fetchFn } = fake({
      "GET /mail/groups": [{ id: "g1", name: "Vorstand", persons: 1, withoutEmail: 0 }],
      "GET /api/mitglieder": {
        items: [
          {
            id: "p1",
            vorname: "Eva",
            nachname: "Muster",
            email: "eva@example.ch",
            anrede: "frau",
            gruppeId: "g1",
          },
          {
            id: "p2",
            vorname: "Paul",
            nachname: "Ohne",
            email: null,
            anrede: null,
            gruppeId: null,
          },
        ],
      },
    });
    const hits = await createHttpMailService(fetchFn).searchPeople("e");
    expect(hits).toMatchObject([
      {
        key: "p1",
        personId: "p1",
        name: "Eva Muster",
        email: "eva@example.ch",
        group: "Vorstand",
        anrede: "Frau",
      },
      { key: "p2", personId: "p2", name: "Paul Ohne", email: null, group: null },
    ]);
  });

  it("bereitet einen Versand vor, bestätigt ihn und rechnet die Zustände um", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const base = { accountId: "a1", recipientCount: 959, attachmentIds: [], createdAt: past };
    const { calls, fetchFn } = fake({
      ...me,
      "POST /mail/campaigns": {
        campaignId: "c1",
        recipientCount: 959,
        missingValues: { antwortlink: 3 },
        confirmed: false,
        confirmationToken: "tok",
      },
      "POST /mail/campaigns/c1/confirm": {
        campaign: {
          ...base,
          id: "c1",
          subject: "S",
          state: "confirmed",
          scheduledAt: future,
          confirmedAt: past,
        },
        counts: { held: 0, queued: 959, sending: 0, sent: 0, failed: 0, cancelled: 0 },
      },
      "GET /mail/campaigns": [
        { ...base, id: "c1", subject: "S", state: "confirmed", scheduledAt: future },
        { ...base, id: "c2", subject: "T", state: "awaiting_confirmation", scheduledAt: future },
        { ...base, id: "c3", subject: "U", state: "cancelled", scheduledAt: future },
      ],
      "GET /mail/campaigns/c9": {
        campaign: { ...base, id: "c9", subject: "V", state: "confirmed", scheduledAt: past },
        counts: { held: 0, queued: 5, sending: 0, sent: 50, failed: 0, cancelled: 0 },
      },
    });
    const service = createHttpMailService(fetchFn);
    const prepared = await service.prepare({
      accountId: "a1",
      listId: "l1",
      subject: "Hallo [Name]",
      body: "Guten Tag [Anrede] [Name]",
      attachmentIds: ["x"],
      sendAt: future,
    });
    expect(prepared).toEqual({
      campaignId: "c1",
      recipientCount: 959,
      missingValues: { antwortlink: 3 },
      confirmed: false,
      confirmationToken: "tok",
    });
    expect(calls.find((c) => c.url === "/mail/campaigns")!.body).toEqual({
      accountId: "a1",
      subject: "Hallo {{name}}",
      bodyHtml: "<p>Guten Tag {{anrede}} {{name}}</p>",
      attachmentIds: ["x"],
      listIds: ["l1"],
      sendAt: future,
    });
    const status = await service.confirm("c1", "tok");
    expect(status.campaign.state).toBe("planned");
    expect(calls.find((c) => c.url.endsWith("/confirm"))!.body).toEqual({ token: "tok" });

    const all = await service.campaigns();
    expect(all.map((c) => c.state)).toEqual(["planned", "draft", "cancelled"]);
    expect((await service.campaignStatus("c9")).campaign.state).toBe("sending");
  });
});
