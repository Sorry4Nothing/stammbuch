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
    expect(await status(404)).toMatchObject({ kind: "notFound" });
    expect(await status(500)).toMatchObject({ kind: "unavailable" });
    expect(String(((await status(502)) as MailServiceError).message)).not.toContain("geheimer");
  });

  it("meldet Funktionen ohne Route als nicht verfügbar", async () => {
    const { calls, fetchFn } = fake({});
    const service = createHttpMailService(fetchFn);
    const draft = { accountId: "a", to: "", subject: "", body: "", attachmentIds: [] };
    await expect(service.saveDraft(draft)).rejects.toMatchObject({ kind: "unsupported" });
    await expect(service.deleteMessages("a", "inbox", [1])).rejects.toMatchObject({
      kind: "unsupported",
    });
    await expect(service.markRead("a", "inbox", [1])).rejects.toMatchObject({
      kind: "unsupported",
    });
    await expect(service.pause("c")).rejects.toMatchObject({ kind: "unsupported" });
    await expect(service.reply("a", "inbox", 1, "Text", ["att"])).rejects.toMatchObject({
      kind: "unsupported",
    });
    expect(calls).toHaveLength(0);
  });

  it("baut Adresslisten aus Liste und Gruppen und speichert nur Personen mit Adresse", async () => {
    const { calls, fetchFn } = fake({
      ...me,
      "GET /mail/address-lists": [
        { id: "l1", name: "GV", manual: [], groupIds: ["g1", "g2"] },
        {
          id: "l2",
          name: "Intern",
          manual: [{ email: "a@example.ch", vorname: "A" }],
          groupIds: [],
        },
      ],
      "GET /api/gruppen": {
        items: [
          { id: "g1", name: "Vorstand", mitglieder: 7 },
          { id: "g2", name: "Aktiv", mitglieder: 412 },
        ],
      },
      "POST /mail/address-lists": { id: "l3", name: "Neu", manual: [], groupIds: [] },
    });
    const service = createHttpMailService(fetchFn);
    const [groups, manual] = await service.lists();
    expect(groups).toMatchObject({
      kind: "groups",
      source: "Vorstand und 1 weitere",
      persons: 419,
      withoutEmail: null,
      recipients: null,
    });
    expect(manual).toMatchObject({ kind: "manual", persons: 1, withoutEmail: 0, recipients: 1 });

    await service.saveList({
      name: "Neu",
      description: "",
      groupIds: [],
      entries: [
        { key: "1", name: "A", email: "a@example.ch", group: null, vorname: "A" },
        { key: "2", name: "B", email: null, group: null },
      ],
    });
    const post = calls.find((c) => c.method === "POST" && c.url === "/mail/address-lists")!;
    expect(post.body).toEqual({
      name: "Neu",
      groupIds: [],
      manual: [{ email: "a@example.ch", vorname: "A" }],
    });
    await expect(
      service.saveList({ name: "X", description: "Text", entries: [], groupIds: [] }),
    ).rejects.toMatchObject({ kind: "unsupported" });
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
