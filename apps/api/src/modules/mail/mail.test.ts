import rateLimit from "@fastify/rate-limit";
import {
  createMemoryRepositories,
  MailError,
  MailService,
  SecretBox,
  type ConnectionFactory,
  type GroupLookup,
  type MailContext,
  type OutgoingMail,
  type PersonRef,
} from "@stammbuch/mail";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { errorHandler } from "../../lib/errors.js";
import { registerMailRoutes } from "./routes.js";

const key = Buffer.alloc(32, 5).toString("base64");

const users: Record<string, MailContext> = {
  anna: { tenantId: "t1", userId: "anna", email: "anna@example.test", name: "Anna Muster" },
  bob: { tenantId: "t1", userId: "bob", email: "bob@example.test" },
  carl: { tenantId: "t2", userId: "anna", email: "carl@example.test" },
};

/** Was die Fake-Verbindung zum IMAP-Server geschickt hat. */
interface ImapLog {
  seen: { folder: string; uids: number[] }[];
  removed: { folder: string; uids: number[] }[];
  drafts: OutgoingMail[];
}

const ORIGINAL = {
  uid: 1,
  from: { name: "Vera Absender", address: "vera@example.test" },
  to: [{ address: "verein@example.test" }],
  subject: "Frage",
  date: null,
  messageId: "<orig@example.test>",
  references: [],
  text: "Hallo",
  attachments: [],
};

/** Personenmodul in klein: zwei Personen von Mandant t1, davon eine ohne Adresse. */
const PEOPLE: PersonRef[] = [
  { id: "p1", name: "Eva Muster", email: "eva@example.test", vorname: "Eva", group: "Vorstand" },
  { id: "p2", name: "Paul Ohne", email: null, vorname: "Paul", group: null },
];
const groupLookup: GroupLookup = {
  membersOf: async () => [],
  groups: async (ctx) =>
    ctx.tenantId === "t1" ? [{ id: "g1", name: "Vorstand", persons: 3, withoutEmail: 1 }] : [],
  people: async (ctx, ids) =>
    ctx.tenantId === "t1" ? PEOPLE.filter((p) => ids.includes(p.id)) : [],
};

function fakeConnections(
  sent: OutgoingMail[] = [],
  log?: ImapLog,
  smtpOk = false,
): ConnectionFactory {
  return {
    checkEndpoint: async (_kind, ep) => {
      if (ep.host === "intern.example.test") throw new MailError("BLOCKED_HOST", "10.0.0.1 intern");
    },
    smtp: async () => ({
      send: async (m) => {
        sent.push(m);
        return { messageId: "<id@test>" };
      },
      verify: async () => {
        if (smtpOk) return;
        throw new MailError("AUTH", "535 5.7.8 user geheim rejected");
      },
      close: () => undefined,
    }),
    imap: async () => ({
      list: async () => ({ total: 0, unread: 0, messages: [] }),
      read: async (_folder, uid) => (uid === ORIGINAL.uid ? ORIGINAL : null),
      counts: async (folders) =>
        folders.filter((f) => f !== "Fehlt").map((folder) => ({ folder, total: 4, unread: 1 })),
      markSeen: async (folder, uids) => {
        log?.seen.push({ folder, uids });
      },
      remove: async (folder, uids) => {
        log?.removed.push({ folder, uids });
      },
      saveDraft: async (mail) => {
        log?.drafts.push(mail);
      },
      close: async () => undefined,
    }),
  };
}

async function build(opts: { rateLimitMax?: number; smtpOk?: boolean } = {}) {
  const sent: OutgoingMail[] = [];
  const imap: ImapLog = { seen: [], removed: [], drafts: [] };
  const service = new MailService({
    repos: createMemoryRepositories(),
    box: new SecretBox({ keys: { k1: key }, currentKeyId: "k1" }),
    connections: fakeConnections(sent, imap, opts.smtpOk),
    groups: groupLookup,
  });
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  if (opts.rateLimitMax)
    await app.register(rateLimit, { max: opts.rateLimitMax, timeWindow: "1 minute" });
  app.setErrorHandler(errorHandler);
  await app.register(async (scope) =>
    registerMailRoutes(scope, {
      service,
      // Test-Authentifizierung: Header `x-user` wählt den Kontext, ohne Header = nicht angemeldet.
      resolveContext: (req) => users[String(req.headers["x-user"])] ?? null,
      onError: errorHandler,
    }),
  );
  return { app, sent, imap };
}

const as = (user: string) => ({ "x-user": user });
const account = {
  label: "Verein",
  fromAddress: "verein@example.test",
  username: "verein",
  password: "geheimes-passwort",
  smtp: { host: "smtp.example.test", port: 587, security: "starttls" },
  imap: { host: "imap.example.test", port: 993, security: "tls" },
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllEnvs();
});

async function createAccount(a: FastifyInstance, user = "anna") {
  const res = await a.inject({
    method: "POST",
    url: "/mail/accounts",
    headers: as(user),
    payload: account,
  });
  return res.json() as { id: string };
}

describe("Authentifizierung und Rechte (SR-10, SR-11)", () => {
  it("jede Route verlangt eine Anmeldung", async () => {
    ({ app } = await build());
    const routes: [string, string][] = [
      ["GET", "/mail/accounts"],
      ["POST", "/mail/accounts"],
      ["DELETE", "/mail/accounts/x"],
      ["POST", "/mail/accounts/x/verify"],
      ["POST", "/mail/accounts/verify"],
      ["GET", "/mail/accounts/x/inbox"],
      ["GET", "/mail/accounts/x/messages/1"],
      ["POST", "/mail/accounts/x/messages/1/reply"],
      ["GET", "/mail/accounts/x/counts"],
      ["POST", "/mail/accounts/x/messages/mark-read"],
      ["POST", "/mail/accounts/x/messages/delete"],
      ["POST", "/mail/accounts/x/drafts"],
      ["GET", "/mail/groups"],
      ["POST", "/mail/campaigns/x/pause"],
      ["POST", "/mail/campaigns/x/send-now"],
      ["POST", "/mail/campaigns/x/reschedule"],
      ["POST", "/mail/attachments"],
      ["GET", "/mail/address-lists"],
      ["POST", "/mail/address-lists"],
      ["GET", "/mail/address-lists/x"],
      ["PUT", "/mail/address-lists/x"],
      ["DELETE", "/mail/address-lists/x"],
      ["POST", "/mail/test-send"],
      ["POST", "/mail/campaigns"],
      ["GET", "/mail/campaigns"],
      ["GET", "/mail/campaigns/x"],
      ["GET", "/mail/campaigns/x/deliveries"],
      ["POST", "/mail/campaigns/x/confirm"],
      ["POST", "/mail/campaigns/x/cancel"],
    ];
    for (const [method, url] of routes) {
      const res = await app.inject({
        method: method as "GET",
        url,
        payload: method === "GET" ? undefined : {},
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("fremde Nutzer und Mandanten sehen Konten nicht (404 statt 403)", async () => {
    ({ app } = await build());
    const { id } = await createAccount(app);
    for (const other of ["bob", "carl"]) {
      const res = await app.inject({
        method: "POST",
        url: `/mail/accounts/${id}/verify`,
        headers: as(other),
      });
      expect(res.statusCode).toBe(404);
      expect(
        (await app.inject({ method: "GET", url: "/mail/accounts", headers: as(other) })).json(),
      ).toEqual([]);
    }
  });
});

describe("Konten", () => {
  it("antwortet ohne Passwort, Chiffretext und interne IDs (SR-74)", async () => {
    ({ app } = await build());
    const res = await app.inject({
      method: "POST",
      url: "/mail/accounts",
      headers: as("anna"),
      payload: account,
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toMatch(/geheimes-passwort|secretEnc|tenantId|password/);
    const list = await app.inject({ method: "GET", url: "/mail/accounts", headers: as("anna") });
    expect(list.body).not.toMatch(/geheimes-passwort|secretEnc|tenantId/);
  });

  it("übernimmt nur erlaubte Felder und verweigert ungültige Eingaben (SR-20, SR-72)", async () => {
    ({ app } = await build());
    for (const payload of [
      { ...account, smtp: { ...account.smtp, security: "none" } },
      { ...account, smtp: { ...account.smtp, port: 70000 } },
      { ...account, fromAddress: "a@b.ch\r\nBcc: x@y.ch" },
      { label: "x" },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/mail/accounts",
        headers: as("anna"),
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION");
    }
    const ok = await app.inject({
      method: "POST",
      url: "/mail/accounts",
      headers: as("anna"),
      payload: { ...account, tenantId: "t9", ownerUserId: "bob", id: "feste-id" },
    });
    expect(ok.json().id).not.toBe("feste-id");
    expect(
      (await app.inject({ method: "GET", url: "/mail/accounts", headers: as("bob") })).json(),
    ).toEqual([]);
  });

  it("interne Mailserver: 422 ohne Details zur Adresse", async () => {
    ({ app } = await build());
    const res = await app.inject({
      method: "POST",
      url: "/mail/accounts",
      headers: as("anna"),
      payload: { ...account, smtp: { ...account.smtp, host: "intern.example.test" } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("BLOCKED_HOST");
    expect(res.body).not.toContain("10.0.0.1");
  });

  it("Serverfehler beim Verbindungstest: nur Kategorie, nie der Servertext (SR-51)", async () => {
    ({ app } = await build());
    const { id } = await createAccount(app);
    const res = await app.inject({
      method: "POST",
      url: `/mail/accounts/${id}/verify`,
      headers: as("anna"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ smtp: "AUTH", imap: "ok" });
    expect(res.body).not.toMatch(/535|geheim/);
  });
});

describe("Konto prüfen ohne Speichern", () => {
  const verify = (a: FastifyInstance, payload: object, user = "anna") =>
    a.inject({ method: "POST", url: "/mail/accounts/verify", headers: as(user), payload });

  it("meldet nur die Kategorie, speichert nichts und gibt das Passwort nie zurück (SR-51)", async () => {
    ({ app } = await build());
    const res = await verify(app, account);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ smtp: "AUTH", imap: "ok", testMail: null });
    expect(res.body).not.toMatch(/535|geheim/);
    const list = await app.inject({ method: "GET", url: "/mail/accounts", headers: as("anna") });
    expect(list.json()).toEqual([]);
  });

  it("schickt die Testmail nur bei gelungener Prüfung und nur an den eigenen Benutzer", async () => {
    const built = await build({ smtpOk: true });
    app = built.app;
    const res = await verify(app, {
      ...account,
      testMail: { subject: "Testmail", bodyHtml: "<p>Hallo</p>" },
    });
    expect(res.json()).toEqual({ smtp: "ok", imap: "ok", testMail: "ok" });
    expect(built.sent).toHaveLength(1);
    expect(built.sent[0]?.to.map((t) => t.address)).toEqual(["anna@example.test"]);
  });

  it("keine Testmail, wenn die Anmeldung scheitert", async () => {
    const built = await build();
    app = built.app;
    const res = await verify(app, {
      ...account,
      testMail: { subject: "Testmail", bodyHtml: "<p>Hallo</p>" },
    });
    expect(res.json().testMail).toBeNull();
    expect(built.sent).toHaveLength(0);
  });

  it("sperrt interne Server wie beim Speichern (SSRF) und prüft die Eingabe", async () => {
    ({ app } = await build());
    const blocked = await verify(app, {
      ...account,
      smtp: { ...account.smtp, host: "intern.example.test" },
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.body).not.toContain("10.0.0.1");
    expect((await verify(app, { ...account, password: "" })).statusCode).toBe(400);
  });
});

describe("Versand und Bestätigung", () => {
  const compose = (accountId: string, emails: string[]) => ({
    accountId,
    subject: "Einladung {{vorname}}",
    bodyHtml: "<p>{{anrede}}</p>",
    manual: emails.map((email) => ({ email, vorname: "Anna" })),
  });

  it("Massenversand startet erst nach Bestätigung mit dem Token des Erstellers", async () => {
    ({ app } = await build());
    const { id } = await createAccount(app);
    const prep = await app.inject({
      method: "POST",
      url: "/mail/campaigns",
      headers: as("anna"),
      payload: compose(id, ["a@example.test", "b@example.test"]),
    });
    expect(prep.statusCode).toBe(201);
    const { campaignId, confirmationToken, confirmed } = prep.json();
    expect(confirmed).toBe(false);

    const confirm = (user: string, token: string) =>
      app!.inject({
        method: "POST",
        url: `/mail/campaigns/${campaignId}/confirm`,
        headers: as(user),
        payload: { token },
      });
    expect((await confirm("anna", "x".repeat(43))).statusCode).toBe(403);
    expect((await confirm("bob", confirmationToken)).statusCode).toBe(404);
    const ok = await confirm("anna", confirmationToken);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().counts.queued).toBe(2);
    expect(ok.body).not.toMatch(/tokenHash|confirmation"/);
    expect((await confirm("anna", confirmationToken)).statusCode).toBe(409);
  });

  it("Testversand geht nur an die eigene Adresse, nie an die Empfänger der Anfrage", async () => {
    const built = await build();
    app = built.app;
    const { id } = await createAccount(app);
    const res = await app.inject({
      method: "POST",
      url: "/mail/test-send",
      headers: as("anna"),
      payload: { ...compose(id, ["fremd@example.test"]), to: "boese@example.test" },
    });
    expect(res.statusCode).toBe(200);
    expect(built.sent).toHaveLength(1);
    expect(built.sent[0]?.to.map((t) => t.address)).toEqual(["anna@example.test"]);
  });

  it("lehnt unbekannte Platzhalter und fremde Konten ab", async () => {
    ({ app } = await build());
    const { id } = await createAccount(app);
    const bad = { ...compose(id, ["a@example.test"]), subject: "{{process}}" };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/mail/campaigns",
          headers: as("anna"),
          payload: bad,
        })
      ).statusCode,
    ).toBe(400);
    const foreign = await app.inject({
      method: "POST",
      url: "/mail/campaigns",
      headers: as("bob"),
      payload: compose(id, ["a@example.test"]),
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("Anhang: Typ und Inhalt werden serverseitig geprüft", async () => {
    ({ app } = await build());
    const upload = (filename: string, content: string) =>
      app!.inject({
        method: "POST",
        url: "/mail/attachments",
        headers: as("anna"),
        payload: { filename, contentBase64: Buffer.from(content).toString("base64") },
      });
    const ok = await upload("../../Programm.pdf", "%PDF-1.7 inhalt");
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ filename: "Programm.pdf", contentType: "application/pdf" });
    expect(ok.body).not.toMatch(/tenantId|sha256/);
    expect((await upload("virus.exe", "MZ")).statusCode).toBe(400);
    expect((await upload("fake.pdf", "kein pdf")).statusCode).toBe(400);
  });

  it("begrenzt Testversand pro Minute (SR-71)", async () => {
    ({ app } = await build({ rateLimitMax: 1000 }));
    const { id } = await createAccount(app);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push(
        (
          await app.inject({
            method: "POST",
            url: "/mail/test-send",
            headers: as("anna"),
            payload: compose(id, ["a@example.test"]),
          })
        ).statusCode,
      );
    }
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe("Posteingang: Zähler, Gelesen, Löschen, Entwürfe, Antwort mit Anhang (#112)", () => {
  const post = (a: FastifyInstance, url: string, payload: object, user = "anna") =>
    a.inject({ method: "POST", url, headers: as(user), payload });

  it("Zähler je Ordner: nur genannte Ordner, fehlende fallen weg, fremde Konten 404", async () => {
    ({ app } = await build());
    const { id } = await createAccount(app);
    const res = await app.inject({
      method: "GET",
      url: `/mail/accounts/${id}/counts?folders=INBOX,Drafts,Fehlt`,
      headers: as("anna"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { folder: "INBOX", total: 4, unread: 1 },
      { folder: "Drafts", total: 4, unread: 1 },
    ]);
    for (const query of ["", "?folders=", "?folders=../etc", `?folders=${"A,".repeat(9)}A`]) {
      const bad = await app.inject({
        method: "GET",
        url: `/mail/accounts/${id}/counts${query}`,
        headers: as("anna"),
      });
      expect(bad.statusCode, query).toBe(400);
    }
    const foreign = await app.inject({
      method: "GET",
      url: `/mail/accounts/${id}/counts?folders=INBOX`,
      headers: as("bob"),
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("als gelesen markieren und löschen: 204, geprüfte Eingaben, nur eigene Konten", async () => {
    const built = await build();
    app = built.app;
    const { id } = await createAccount(app);
    expect(
      (
        await post(app, `/mail/accounts/${id}/messages/mark-read`, {
          folder: "INBOX",
          uids: [1, 2],
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await post(app, `/mail/accounts/${id}/messages/delete`, { folder: "Trash", uids: [3] }))
        .statusCode,
    ).toBe(204);
    expect(built.imap.seen).toEqual([{ folder: "INBOX", uids: [1, 2] }]);
    expect(built.imap.removed).toEqual([{ folder: "Trash", uids: [3] }]);

    for (const url of ["mark-read", "delete"]) {
      for (const payload of [
        { folder: "INBOX", uids: [] },
        { folder: "INBOX", uids: [0] },
        { folder: "INBOX", uids: Array.from({ length: 201 }, (_, i) => i + 1) },
        { folder: "../x", uids: [1] },
        { uids: [1] },
      ]) {
        const res = await post(app, `/mail/accounts/${id}/messages/${url}`, payload);
        expect(res.statusCode, `${url} ${JSON.stringify(payload).slice(0, 40)}`).toBe(400);
      }
      const foreign = await post(
        app,
        `/mail/accounts/${id}/messages/${url}`,
        { folder: "INBOX", uids: [1] },
        "bob",
      );
      expect(foreign.statusCode).toBe(404);
    }
    expect(built.imap.seen).toHaveLength(1);
    expect(built.imap.removed).toHaveLength(1);
  });

  it("Entwurf: bereinigter Inhalt im Entwurfsordner, Empfänger optional, ungültige Adresse 400", async () => {
    const built = await build();
    app = built.app;
    const { id } = await createAccount(app);
    const ok = await post(app, `/mail/accounts/${id}/drafts`, {
      to: { email: "Eva@Example.test", name: 'Eva "Muster"' },
      subject: "Entwurf\r\nBcc: x@y.ch",
      bodyHtml: "<p>Hallo</p><script>alert(1)</script>",
    });
    expect(ok.statusCode).toBe(201);
    const [draft] = built.imap.drafts;
    expect(draft?.to).toEqual([{ name: "Eva Muster", address: "eva@example.test" }]);
    expect(draft?.subject).not.toMatch(/[\r\n]/);
    expect(draft?.html).not.toContain("<script");
    expect(draft?.text).toContain("Hallo");

    const bare = await post(app, `/mail/accounts/${id}/drafts`, { subject: "", bodyHtml: "" });
    expect(bare.statusCode).toBe(201);
    expect(built.imap.drafts[1]?.to).toEqual([]);

    for (const payload of [
      { to: { email: "kein-mail" }, subject: "x", bodyHtml: "y" },
      { subject: "x" },
      { subject: "x", bodyHtml: "y", attachmentIds: ["gibt-es-nicht"] },
    ]) {
      expect((await post(app, `/mail/accounts/${id}/drafts`, payload)).statusCode).not.toBe(201);
    }
    expect(
      (await post(app, `/mail/accounts/${id}/drafts`, { subject: "x", bodyHtml: "y" }, "bob"))
        .statusCode,
    ).toBe(404);
    expect(built.imap.drafts).toHaveLength(2);
  });

  it("Antwort mit Anhang: Datei geht mit, fremde Dateien nicht", async () => {
    const built = await build();
    app = built.app;
    const { id } = await createAccount(app);
    const upload = await post(app, "/mail/attachments", {
      filename: "Programm.pdf",
      contentBase64: Buffer.from("%PDF-1.7 inhalt").toString("base64"),
    });
    const attachmentId = upload.json().id as string;
    const url = `/mail/accounts/${id}/messages/1/reply?folder=INBOX`;
    const res = await post(app, url, { bodyHtml: "<p>Danke</p>", attachmentIds: [attachmentId] });
    expect(res.statusCode).toBe(200);
    expect(built.sent.at(-1)?.attachments?.map((a) => a.filename)).toEqual(["Programm.pdf"]);
    expect(built.sent.at(-1)?.to.map((t) => t.address)).toEqual(["vera@example.test"]);

    // Annas Datei gehört Bob nicht: für ihn gibt es sie nicht (und sein Konto nicht).
    await post(app, "/mail/accounts", account, "bob");
    const bobs = (
      await app.inject({ method: "GET", url: "/mail/accounts", headers: as("bob") })
    ).json() as { id: string }[];
    const foreign = await post(
      app,
      `/mail/accounts/${bobs[0]?.id}/messages/1/reply?folder=INBOX`,
      { bodyHtml: "<p>x</p>", attachmentIds: [attachmentId] },
      "bob",
    );
    expect(foreign.statusCode).toBe(404);
    const tooMany = await post(app, url, {
      bodyHtml: "<p>x</p>",
      attachmentIds: Array.from({ length: 11 }, (_, i) => `a${i}`),
    });
    expect(tooMany.statusCode).toBe(400);
  });
});

describe("Adresslisten: Beschreibung, Personen, Zahlen (#112)", () => {
  const send = (a: FastifyInstance, method: "POST" | "PUT", url: string, payload: object) =>
    a.inject({ method, url, headers: as("anna"), payload });

  it("speichert Beschreibung und Personenverweise und liefert aufgelöste Personen mit Zahlen", async () => {
    ({ app } = await build());
    const created = await send(app, "POST", "/mail/address-lists", {
      name: "Vorstand",
      description: "Alle Mitglieder\r\ndes Vorstands",
      manual: [{ email: "hand@example.test", vorname: "Hans" }],
      groupIds: ["g1"],
      personIds: ["p1", "p2", "p1"],
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.description).toBe("Alle Mitglieder des Vorstands");
    expect(body.personIds).toEqual(["p1", "p2"]);
    expect(body.lastUsedAt).toBeNull();
    // 1 von Hand + 2 Personen + 3 aus der Gruppe; ohne Adresse: p2 und 1 in der Gruppe.
    expect(body.stats).toEqual({ persons: 6, withoutEmail: 2, recipients: 4 });
    expect(body.people.map((p: PersonRef) => p.name)).toEqual(["Eva Muster", "Paul Ohne"]);

    const all = (
      await app.inject({ method: "GET", url: "/mail/address-lists", headers: as("anna") })
    ).json();
    expect(all).toHaveLength(1);
    expect(all[0].stats).toEqual(body.stats);
    expect(all[0].people).toBeUndefined();

    const one = await app.inject({
      method: "GET",
      url: `/mail/address-lists/${body.id}`,
      headers: as("anna"),
    });
    expect(one.json().people).toHaveLength(2);

    const updated = await send(app, "PUT", `/mail/address-lists/${body.id}`, { personIds: ["p1"] });
    expect(updated.json()).toMatchObject({
      description: "Alle Mitglieder des Vorstands",
      personIds: ["p1"],
      stats: { persons: 5, withoutEmail: 1, recipients: 4 },
    });
  });

  it("unbekannte oder fremde Personen-IDs sind ungültig, ohne zu verraten, ob es sie gibt", async () => {
    ({ app } = await build());
    const bad = await send(app, "POST", "/mail/address-lists", { name: "L", personIds: ["p9"] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("VALIDATION");
    // Mandant t2 kennt p1 nicht.
    const other = await app.inject({
      method: "POST",
      url: "/mail/address-lists",
      headers: as("carl"),
      payload: { name: "L", personIds: ["p1"] },
    });
    expect(other.statusCode).toBe(400);
    const tooLong = await send(app, "POST", "/mail/address-lists", {
      name: "L",
      description: "x".repeat(501),
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it("«Zuletzt verwendet» entsteht beim Vorbereiten eines Versands; Personen ohne Adresse bekommen nichts", async () => {
    ({ app } = await build());
    const { id: accountId } = await createAccount(app);
    const list = (
      await send(app, "POST", "/mail/address-lists", { name: "Liste", personIds: ["p1", "p2"] })
    ).json();
    const prep = await send(app, "POST", "/mail/campaigns", {
      accountId,
      subject: "Hallo",
      bodyHtml: "<p>Hallo</p>",
      listIds: [list.id],
    });
    expect(prep.statusCode).toBe(201);
    // Nur eine Person hat eine Adresse: ein Empfänger, keine Bestätigung nötig.
    expect(prep.json()).toMatchObject({ recipientCount: 1, confirmed: true });
    const after = await app.inject({
      method: "GET",
      url: `/mail/address-lists/${list.id}`,
      headers: as("anna"),
    });
    expect(after.json().lastUsedAt).toEqual(expect.any(String));
    const deliveries = await app.inject({
      method: "GET",
      url: `/mail/campaigns/${prep.json().campaignId}/deliveries`,
      headers: as("anna"),
    });
    expect(deliveries.json()).toMatchObject([{ name: "Eva", email: "eva@example.test" }]);
  });

  it("Gruppen mit Zahlen: nur die des eigenen Mandanten", async () => {
    ({ app } = await build());
    const own = await app.inject({ method: "GET", url: "/mail/groups", headers: as("anna") });
    expect(own.json()).toEqual([{ id: "g1", name: "Vorstand", persons: 3, withoutEmail: 1 }]);
    const other = await app.inject({ method: "GET", url: "/mail/groups", headers: as("carl") });
    expect(other.json()).toEqual([]);
  });
});

describe("Versandplan: pausieren, sofort senden, Zeitpunkt ändern (#112)", () => {
  const post = (a: FastifyInstance, url: string, payload: object = {}, user = "anna") =>
    a.inject({ method: "POST", url, headers: as(user), payload });
  const status = async (a: FastifyInstance, id: string) =>
    (
      await a.inject({ method: "GET", url: `/mail/campaigns/${id}`, headers: as("anna") })
    ).json() as {
      campaign: {
        state: string;
        scheduledAt: string;
        listName: string | null;
        confirmedBy: string | null;
      };
      counts: Record<string, number>;
    };

  async function confirmed(a: FastifyInstance, sendAt?: string) {
    const { id: accountId } = await createAccount(a);
    const list = (
      await post(a, "/mail/address-lists", {
        name: "Vorstand",
        manual: [
          { email: "a@example.test" },
          { email: "b@example.test", vorname: "Berta Beispiel" },
        ],
      })
    ).json();
    const prep = (
      await post(a, "/mail/campaigns", {
        accountId,
        subject: "Plan",
        bodyHtml: "<p>Plan</p>",
        listIds: [list.id],
        ...(sendAt ? { sendAt } : {}),
      })
    ).json();
    expect(prep.confirmed).toBe(false);
    const ok = await post(a, `/mail/campaigns/${prep.campaignId}/confirm`, {
      token: prep.confirmationToken,
    });
    expect(ok.statusCode).toBe(200);
    return prep.campaignId as string;
  }

  const in1h = () => new Date(Date.now() + 3_600_000).toISOString();
  const in2h = () => new Date(Date.now() + 7_200_000).toISOString();

  it("Listenname und «Bestätigt von» stehen am Versand", async () => {
    ({ app } = await build());
    const id = await confirmed(app, in1h());
    const s = await status(app, id);
    expect(s.campaign).toMatchObject({
      state: "confirmed",
      listName: "Vorstand",
      confirmedBy: "Anna Muster",
    });
    const list = await app.inject({ method: "GET", url: "/mail/campaigns", headers: as("anna") });
    expect(list.json()[0]).toMatchObject({ listName: "Vorstand", confirmedBy: "Anna Muster" });
  });

  it("pausieren hält die Zustellungen an, Zeitpunkt ändern setzt fort", async () => {
    ({ app } = await build());
    const id = await confirmed(app, in1h());
    const paused = await post(app, `/mail/campaigns/${id}/pause`);
    expect(paused.statusCode).toBe(200);
    expect(paused.json().campaign.state).toBe("paused");
    expect(paused.json().counts).toMatchObject({ held: 2, queued: 0 });
    expect((await post(app, `/mail/campaigns/${id}/pause`)).statusCode).toBe(409);

    const at = in2h();
    const moved = await post(app, `/mail/campaigns/${id}/reschedule`, { sendAt: at });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().campaign).toMatchObject({ state: "confirmed", scheduledAt: at });
    expect(moved.json().counts).toMatchObject({ held: 0, queued: 2 });
  });

  it("sofort senden: setzt eine Pause fort und holt einen geplanten Versand nach vorn", async () => {
    ({ app } = await build());
    const id = await confirmed(app, in1h());
    await post(app, `/mail/campaigns/${id}/pause`);
    const now = await post(app, `/mail/campaigns/${id}/send-now`);
    expect(now.statusCode).toBe(200);
    expect(now.json().campaign.state).toBe("confirmed");
    expect(now.json().counts).toMatchObject({ queued: 2, held: 0 });
    expect(new Date(now.json().campaign.scheduledAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("ohne Bestätigung lässt sich nichts freigeben: sofort senden 409, Zeitpunkt ändern bleibt wartend", async () => {
    ({ app } = await build());
    const { id: accountId } = await createAccount(app);
    const prep = (
      await post(app, "/mail/campaigns", {
        accountId,
        subject: "Plan",
        bodyHtml: "<p>Plan</p>",
        manual: [{ email: "a@example.test" }, { email: "b@example.test" }],
      })
    ).json();
    const url = (action: string) => `/mail/campaigns/${prep.campaignId}/${action}`;
    expect((await post(app, url("send-now"))).statusCode).toBe(409);
    expect((await post(app, url("pause"))).statusCode).toBe(409);
    const moved = await post(app, url("reschedule"), { sendAt: in2h() });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().campaign.state).toBe("awaiting_confirmation");
    expect(moved.json().counts).toMatchObject({ held: 2, queued: 0 });
  });

  it("abgebrochene Versände bleiben abgebrochen; fremde Versände gibt es nicht", async () => {
    ({ app } = await build());
    const id = await confirmed(app, in1h());
    for (const action of ["pause", "send-now", "reschedule"]) {
      const foreign = await post(app, `/mail/campaigns/${id}/${action}`, { sendAt: in2h() }, "bob");
      expect(foreign.statusCode, action).toBe(404);
    }
    await post(app, `/mail/campaigns/${id}/cancel`);
    for (const action of ["pause", "send-now", "reschedule"]) {
      const res = await post(app, `/mail/campaigns/${id}/${action}`, { sendAt: in2h() });
      expect(res.statusCode, action).toBe(409);
    }
    expect((await status(app, id)).campaign.state).toBe("cancelled");
  });

  it("prüft den neuen Zeitpunkt (SR-20): Format, höchstens ein Jahr voraus", async () => {
    ({ app } = await build());
    const id = await confirmed(app, in1h());
    for (const sendAt of ["morgen", "2030-01-01", undefined]) {
      const res = await post(app, `/mail/campaigns/${id}/reschedule`, { sendAt });
      expect(res.statusCode, String(sendAt)).toBe(400);
    }
    const far = new Date(Date.now() + 400 * 86_400_000).toISOString();
    expect((await post(app, `/mail/campaigns/${id}/reschedule`, { sendAt: far })).statusCode).toBe(
      400,
    );
    // Vergangenheit: gilt als «jetzt».
    const past = await post(app, `/mail/campaigns/${id}/reschedule`, {
      sendAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    expect(past.statusCode).toBe(200);
    expect(new Date(past.json().campaign.scheduledAt).getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe("Einbindung in die App", () => {
  const config = loadConfig({ LOG_LEVEL: "silent" });

  it("ohne MAIL_ENCRYPTION_KEYS bleibt das Modul aus", async () => {
    vi.stubEnv("MAIL_ENCRYPTION_KEYS", "");
    app = await buildApp(config);
    expect((await app.inject({ method: "GET", url: "/mail/accounts" })).statusCode).toBe(404);
  });

  it("mit Schlüsseln, aber ohne Authentifizierungsmodul, lehnt es alles ab (fail secure)", async () => {
    vi.stubEnv("MAIL_ENCRYPTION_KEYS", `k1:${key}`);
    app = await buildApp(config);
    const res = await app.inject({ method: "GET", url: "/mail/accounts", headers: as("anna") });
    expect(res.statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});
