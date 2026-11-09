import rateLimit from "@fastify/rate-limit";
import {
  createMemoryRepositories,
  MailError,
  MailService,
  SecretBox,
  type ConnectionFactory,
  type MailContext,
  type OutgoingMail,
} from "@stammbuch/mail";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { errorHandler } from "../../lib/errors.js";
import { registerMailRoutes } from "./routes.js";

const key = Buffer.alloc(32, 5).toString("base64");

const users: Record<string, MailContext> = {
  anna: { tenantId: "t1", userId: "anna", email: "anna@example.test" },
  bob: { tenantId: "t1", userId: "bob", email: "bob@example.test" },
  carl: { tenantId: "t2", userId: "anna", email: "carl@example.test" },
};

function fakeConnections(sent: OutgoingMail[] = [], smtpOk = false): ConnectionFactory {
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
      list: async () => ({ total: 0, messages: [] }),
      read: async () => null,
      close: async () => undefined,
    }),
  };
}

async function build(opts: { rateLimitMax?: number; smtpOk?: boolean } = {}) {
  const sent: OutgoingMail[] = [];
  const service = new MailService({
    repos: createMemoryRepositories(),
    box: new SecretBox({ keys: { k1: key }, currentKeyId: "k1" }),
    connections: fakeConnections(sent, opts.smtpOk),
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
  return { app, sent };
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
