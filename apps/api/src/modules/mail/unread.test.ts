import {
  createMemoryRepositories,
  MailError,
  MailService,
  SecretBox,
  type ConnectionFactory,
  type MailContext,
} from "@stammbuch/mail";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { errorHandler } from "../../lib/errors.js";
import { registerMailRoutes, UNREAD_CACHE_MS } from "./routes.js";

const key = Buffer.alloc(32, 5).toString("base64");
const users: Record<string, MailContext> = {
  anna: { tenantId: "t1", userId: "anna", email: "anna@example.test" },
  bob: { tenantId: "t1", userId: "bob", email: "bob@example.test" },
  // Gleiche Benutzer-ID wie anna, anderer Mandant: darf den Zähler nicht teilen.
  carl: { tenantId: "t2", userId: "anna", email: "carl@example.test" },
};

/** Ungelesene INBOX-Mails je IMAP-Host; jeder andere Host wirft. */
const UNREAD: Record<string, number> = {
  "a.example.test": 2,
  "b.example.test": 3,
  "c.example.test": 7,
};

async function build() {
  const calls: string[] = [];
  const connections: ConnectionFactory = {
    checkEndpoint: async () => undefined,
    smtp: async () => ({
      send: async () => ({ messageId: "<x>" }),
      verify: async () => undefined,
      close: () => undefined,
    }),
    imap: async (account) => ({
      list: async () => ({ total: 0, unread: 0, messages: [] }),
      read: async () => null,
      counts: async (folders) => {
        calls.push(account.imap?.host ?? "");
        const unread = UNREAD[account.imap?.host ?? ""];
        if (unread === undefined) throw new MailError("CONNECT", "geheim: 10.0.0.1 refused");
        return folders.map((folder) => ({ folder, total: 9, unread }));
      },
      markSeen: async () => undefined,
      remove: async () => undefined,
      saveDraft: async () => undefined,
      close: async () => undefined,
    }),
  };
  const service = new MailService({
    repos: createMemoryRepositories(),
    box: new SecretBox({ keys: { k1: key }, currentKeyId: "k1" }),
    connections,
    groups: { membersOf: async () => [], groups: async () => [], people: async () => [] },
  });
  let clock = 1_000_000;
  const app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  await app.register(async (scope) =>
    registerMailRoutes(scope, {
      service,
      resolveContext: (req) => users[String(req.headers["x-user"])] ?? null,
      onError: errorHandler,
      now: () => clock,
    }),
  );
  const as = (user: string) => ({ "x-user": user });
  const add = (user: string, host: string | null) =>
    app.inject({
      method: "POST",
      url: "/mail/accounts",
      headers: as(user),
      payload: {
        label: host ?? "nur-smtp",
        fromAddress: "verein@example.test",
        username: "verein",
        password: "geheim",
        smtp: { host: "smtp.example.test", port: 587, security: "starttls" },
        ...(host ? { imap: { host, port: 993, security: "tls" } } : {}),
      },
    });
  const get = (user: string) =>
    app.inject({ method: "GET", url: "/mail/unread-count", headers: as(user) });
  const unread = async (user: string) => (await get(user)).json().unread;
  return { app, calls, add, get, unread, tick: (ms: number) => (clock += ms), as };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("Zähler ungelesener Mails", () => {
  it("verlangt eine Anmeldung", async () => {
    const t = await build();
    app = t.app;
    const res = await app.inject({ method: "GET", url: "/mail/unread-count" });
    expect(res.statusCode).toBe(401);
  });

  it("zählt INBOX aller Konten der Person; Konten ohne IMAP fehlen", async () => {
    const t = await build();
    app = t.app;
    await t.add("anna", "a.example.test");
    await t.add("anna", "b.example.test");
    await t.add("anna", null);
    expect(await t.unread("anna")).toBe(5);
    expect(await t.unread("bob")).toBe(0);
  });

  it("lässt ein Konto aus, das nicht antwortet; antwortet keines, gibt es keine Zahl", async () => {
    const t = await build();
    app = t.app;
    await t.add("anna", "a.example.test");
    await t.add("anna", "kaputt.example.test");
    const res = await t.get("anna");
    expect(res.json()).toEqual({ unread: 2 });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).not.toMatch(/10\.0\.0\.1|geheim/);

    await t.add("bob", "kaputt.example.test");
    expect(await t.unread("bob")).toBeNull();
  });

  it("fragt höchstens einmal pro Minute und Person bei den Mailservern", async () => {
    const t = await build();
    app = t.app;
    await t.add("anna", "a.example.test");
    await Promise.all([t.unread("anna"), t.unread("anna"), t.unread("anna")]);
    await t.unread("anna");
    expect(t.calls).toEqual(["a.example.test"]);
    t.tick(UNREAD_CACHE_MS + 1);
    await t.unread("anna");
    expect(t.calls).toHaveLength(2);
  });

  it("trennt Mandanten, auch bei gleicher Benutzer-ID", async () => {
    const t = await build();
    app = t.app;
    await t.add("anna", "a.example.test");
    await t.add("carl", "c.example.test");
    expect(await t.unread("anna")).toBe(2);
    expect(await t.unread("carl")).toBe(7);
  });

  it("verwirft die Zahl nach «gelesen markieren»", async () => {
    const t = await build();
    app = t.app;
    const acc = (await t.add("anna", "a.example.test")).json() as { id: string };
    await t.unread("anna");
    const res = await app.inject({
      method: "POST",
      url: `/mail/accounts/${acc.id}/messages/mark-read`,
      headers: t.as("anna"),
      payload: { folder: "INBOX", uids: [1] },
    });
    expect(res.statusCode).toBe(204);
    await t.unread("anna");
    expect(t.calls).toHaveLength(2);
  });
});
