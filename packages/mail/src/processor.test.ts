import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MailError } from "./net-guard.js";
import { backoffMs, defaultProcessorConfig, processDueDeliveries } from "./processor.js";
import {
  accountInput,
  ctxA,
  fakeConnections,
  localFactory,
  makeService,
  startSmtpServer,
} from "./test-helpers.js";

const transient = Object.assign(new Error("421 try later"), { responseCode: 421 });

async function setup(opts: Parameters<typeof fakeConnections>[0] = {}) {
  const fake = fakeConnections(opts);
  const t = makeService({}, fake.factory);
  const account = await t.service.addAccount(ctxA, accountInput);
  const deps = (over = {}) => ({
    repos: t.repos,
    box: t.box,
    connections: fake.factory,
    now: t.now,
    random: () => 0.5,
    ...over,
  });
  const send = async (emails: string[], extra = {}) => {
    const p = await t.service.prepareCampaign(ctxA, {
      accountId: account.id,
      subject: "Hallo {{vorname}}",
      bodyHtml: "<p>{{anrede}}</p>",
      manual: emails.map((email) => ({ email, vorname: "Anna" })),
      ...extra,
    });
    if (p.confirmationToken)
      await t.service.confirmCampaign(ctxA, p.campaignId, p.confirmationToken);
    return p;
  };
  return { ...t, fake, account, deps, send };
}

describe("Versandqueue (Worker)", () => {
  it("sendet alle fälligen Zustellungen und setzt den Status", async () => {
    const s = await setup();
    const p = await s.send(["a@example.test", "b@example.test"]);
    const r = await processDueDeliveries(s.deps());
    expect(r).toMatchObject({ sent: 2, failed: 0, retried: 0 });
    expect(s.fake.state.sent.map((m) => m.to[0]?.address).sort()).toEqual([
      "a@example.test",
      "b@example.test",
    ]);
    expect(s.fake.state.sent[0]?.subject).toBe("Hallo Anna");
    expect((await s.service.getCampaignStatus(ctxA, p.campaignId)).counts.sent).toBe(2);
  });

  it("hält den Versandplan ein: vor dem Zeitpunkt passiert nichts", async () => {
    const s = await setup();
    const at = new Date(s.now().getTime() + 3_600_000);
    await s.send(["a@example.test", "b@example.test"], { sendAt: at });
    expect((await processDueDeliveries(s.deps())).sent).toBe(0);
    s.advance(3_600_001);
    expect((await processDueDeliveries(s.deps())).sent).toBe(2);
  });

  it("sendet nichts, solange die Bestätigung fehlt", async () => {
    const s = await setup();
    await s.service.prepareCampaign(ctxA, {
      accountId: s.account.id,
      subject: "x",
      bodyHtml: "<p>x</p>",
      manual: [{ email: "a@example.test" }, { email: "b@example.test" }],
    });
    expect((await processDueDeliveries(s.deps())).sent).toBe(0);
    expect(s.fake.state.sent).toHaveLength(0);
  });

  it("wiederholt bei vorübergehendem Fehler mit exponentiellem Backoff", async () => {
    const s = await setup({ smtpFailures: [transient, transient] });
    const p = await s.send(["a@example.test"]);

    expect(await processDueDeliveries(s.deps())).toMatchObject({ retried: 1, sent: 0 });
    // Direkt danach ist nichts fällig.
    expect(await processDueDeliveries(s.deps())).toMatchObject({ sent: 0, retried: 0 });
    s.advance(defaultProcessorConfig.baseBackoffMs + 1);
    expect(await processDueDeliveries(s.deps())).toMatchObject({ retried: 1 });
    // Zweiter Fehlversuch: doppelte Wartezeit.
    s.advance(defaultProcessorConfig.baseBackoffMs + 1);
    expect((await processDueDeliveries(s.deps())).sent).toBe(0);
    s.advance(defaultProcessorConfig.baseBackoffMs * 2);
    expect((await processDueDeliveries(s.deps())).sent).toBe(1);

    const [d] = await s.service.listDeliveries(ctxA, p.campaignId, 0, 10);
    expect(d).toMatchObject({ status: "sent", attempts: 3 });
  });

  it("gibt nach maxAttempts auf und speichert nur einen Fehlercode", async () => {
    const s = await setup({ smtpFailures: Array(10).fill(transient) });
    const p = await s.send(["a@example.test"]);
    for (let i = 0; i < 4; i++) {
      await processDueDeliveries(s.deps({ config: { maxAttempts: 3, baseBackoffMs: 1000 } }));
      s.advance(10_000);
    }
    const [d] = await s.service.listDeliveries(ctxA, p.campaignId, 0, 10);
    expect(d).toMatchObject({ status: "failed", attempts: 3, lastError: "TRANSIENT" });
    expect(JSON.stringify(d)).not.toContain("421");
  });

  it("wiederholt permanente Fehler (z.B. Empfänger abgelehnt) nicht", async () => {
    const rejected = Object.assign(new Error("550 no such user"), { responseCode: 550 });
    const s = await setup({ smtpFailures: [rejected] });
    const p = await s.send(["a@example.test", "b@example.test"]);
    const r = await processDueDeliveries(s.deps());
    expect(r).toMatchObject({ failed: 1, sent: 1, retried: 0 });
    const rows = await s.service.listDeliveries(ctxA, p.campaignId, 0, 10);
    expect(rows.find((d) => d.status === "failed")?.lastError).toBe("REJECTED");
  });

  it("begrenzt die Rate pro Kunde und verschiebt den Rest", async () => {
    const s = await setup();
    await s.send(["a@example.test", "b@example.test", "c@example.test"]);
    const cfg = { config: { perTenantPerMinute: 2 } };
    expect(await processDueDeliveries(s.deps(cfg))).toMatchObject({ sent: 2, deferred: 1 });
    // Innerhalb derselben Minute bleibt das Limit bestehen ...
    expect(await processDueDeliveries(s.deps(cfg))).toMatchObject({ sent: 0, deferred: 1 });
    // ... danach läuft der Rest.
    s.advance(61_000);
    expect((await processDueDeliveries(s.deps(cfg))).sent).toBe(1);
  });

  it("ein Kunde mit vollem Limit blockiert andere Kunden nicht", async () => {
    const s = await setup();
    const other = { tenantId: "t9", userId: "u9", email: "x@example.test" };
    const acc2 = await s.service.addAccount(other, accountInput);
    await s.send(["a@example.test", "b@example.test", "c@example.test"]);
    const p2 = await s.service.prepareCampaign(other, {
      accountId: acc2.id,
      subject: "y",
      bodyHtml: "<p>y</p>",
      manual: [{ email: "z@example.test" }],
    });
    expect(p2.confirmed).toBe(true);
    const r = await processDueDeliveries(s.deps({ config: { perTenantPerMinute: 1 } }));
    expect(r.sent).toBe(2); // je ein Mail pro Kunde
  });

  it("nimmt verwaiste „sending“-Zustellungen nach Ablauf der Sperre wieder auf", async () => {
    const s = await setup();
    await s.send(["a@example.test"]);
    const [due] = await s.repos.campaigns.listDue(s.now(), 10);
    // Worker A nimmt auf und stürzt ab.
    await s.repos.campaigns.claim(due!.id, s.now(), new Date(s.now().getTime() + 1000));
    expect((await processDueDeliveries(s.deps())).sent).toBe(0);
    s.advance(2000);
    expect((await processDueDeliveries(s.deps())).sent).toBe(1);
  });

  it("doppelte Aufnahme derselben Zustellung ist ausgeschlossen (claim ist atomar)", async () => {
    const s = await setup();
    await s.send(["a@example.test"]);
    const [due] = await s.repos.campaigns.listDue(s.now(), 10);
    const lease = new Date(s.now().getTime() + 60_000);
    const results = await Promise.all([
      s.repos.campaigns.claim(due!.id, s.now(), lease),
      s.repos.campaigns.claim(due!.id, s.now(), lease),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("übergeht abgebrochene Kampagnen", async () => {
    const s = await setup();
    const p = await s.send(["a@example.test", "b@example.test"]);
    await s.service.cancelCampaign(ctxA, p.campaignId);
    expect((await processDueDeliveries(s.deps())).sent).toBe(0);
    expect((await s.service.getCampaignStatus(ctxA, p.campaignId)).counts.cancelled).toBe(2);
  });

  it("öffnet pro Konto und Durchlauf nur eine Verbindung", async () => {
    const s = await setup();
    await s.send(["a@example.test", "b@example.test", "c@example.test"]);
    await processDueDeliveries(s.deps());
    expect(s.fake.state.smtpOpened).toBe(1);
  });

  it("Anmeldefehler des Kontos ist permanent und betrifft alle Zustellungen des Kontos", async () => {
    const s = await setup();
    await s.send(["a@example.test", "b@example.test"]);
    const bad = {
      ...s.fake.factory,
      smtp: async () => {
        throw new MailError("AUTH");
      },
    };
    const r = await processDueDeliveries(s.deps({ connections: bad }));
    expect(r).toMatchObject({ failed: 2, sent: 0 });
  });

  it("Backoff wächst exponentiell, ist gedeckelt und streut um ±20 %", () => {
    const cfg = defaultProcessorConfig;
    expect(backoffMs(1, cfg, () => 0.5)).toBe(60_000);
    expect(backoffMs(2, cfg, () => 0.5)).toBe(120_000);
    expect(backoffMs(30, cfg, () => 0.5)).toBe(cfg.maxBackoffMs);
    expect(backoffMs(1, cfg, () => 0)).toBe(48_000);
    expect(backoffMs(1, cfg, () => 1)).toBe(72_000);
  });
});

describe("Versand gegen echten SMTP-Server (smtp-server)", () => {
  let server: Awaited<ReturnType<typeof startSmtpServer>>;
  beforeEach(async () => {
    server = await startSmtpServer();
  });
  afterEach(async () => {
    await server.close();
  });

  async function runAgainst(port: number, security: "starttls" | "tls", password = "app-passwort") {
    const connections = localFactory();
    const t = makeService({}, connections);
    const account = await t.service.addAccount(ctxA, {
      ...accountInput,
      fromAddress: "verein@example.test",
      password,
      smtp: { host: "127.0.0.1", port, security },
      imap: undefined,
    });
    const file = await t.service.addAttachment(ctxA, "Einladung.pdf", Buffer.from("%PDF-1.4 test"));
    const p = await t.service.prepareCampaign(ctxA, {
      accountId: account.id,
      subject: "Einladung {{vorname}}\r\nBcc: boese@example.test",
      bodyHtml:
        '<p>{{anrede}} <script>alert(1)</script></p><a href="{{antwortlink}}">Antworten</a>',
      attachmentIds: [file.id],
      manual: [
        {
          email: "anna@example.test",
          vorname: "Anna\r\nBcc: boese@example.test",
          antwortlink: "https://antwort.example.test/x?t=1",
        },
      ],
    });
    const result = await processDueDeliveries({
      repos: t.repos,
      box: t.box,
      connections,
      now: t.now,
      config: { maxAttempts: 1 },
    });
    return { result, t, p };
  }

  it("sendet per STARTTLS mit Anmeldung, Anhang und sauberen Headern", async () => {
    const { result } = await runAgainst(server.port, "starttls");
    expect(result.sent).toBe(1);
    const mail = server.received[0]!;
    const to = Array.isArray(mail.to) ? mail.to[0] : mail.to;
    expect(to?.value).toHaveLength(1);
    expect(to?.value[0]?.address).toBe("anna@example.test");
    expect(mail.subject).toBe("Einladung Anna Bcc: boese@example.test Bcc: boese@example.test");
    expect(mail.headers.get("bcc")).toBeUndefined();
    expect(JSON.stringify([...mail.headers.keys()])).not.toContain("boese");
    expect(mail.html).not.toContain("<script");
    expect(mail.html).toContain('href="https://antwort.example.test/x?t=1"');
    expect(mail.html).toContain("background-color:#ffffff");
    expect(mail.attachments.map((a) => a.filename)).toEqual(["Einladung.pdf"]);
  });

  it("meldet falsche Zugangsdaten als AUTH, ohne Servertext", async () => {
    const { t, p } = await runAgainst(server.port, "starttls", "falsch");
    const [d] = await t.service.listDeliveries(ctxA, p.campaignId, 0, 10);
    expect(d).toMatchObject({ status: "failed", lastError: "AUTH" });
    expect(server.received).toHaveLength(0);
  });

  it("verweigert Klartext: Server ohne STARTTLS wird nicht benutzt (TLS-Pflicht)", async () => {
    const plain = await startSmtpServer({ starttls: false });
    try {
      const { t, p } = await runAgainst(plain.port, "starttls");
      const [d] = await t.service.listDeliveries(ctxA, p.campaignId, 0, 10);
      expect(d?.status).toBe("failed");
      expect(plain.received).toHaveLength(0);
    } finally {
      await plain.close();
    }
  });

  it("prüft das Zertifikat: ohne Test-Override schlägt die Verbindung fehl", async () => {
    const strict = (await import("./transport.js")).createConnectionFactory({
      allowPrivateHosts: true,
      timeoutMs: 5000,
    });
    const t = makeService({}, strict);
    const account = await t.service.addAccount(ctxA, {
      ...accountInput,
      smtp: { host: "127.0.0.1", port: server.port, security: "starttls" },
      imap: undefined,
    });
    await t.service.prepareCampaign(ctxA, {
      accountId: account.id,
      subject: "x",
      bodyHtml: "<p>x</p>",
      manual: [{ email: "a@example.test" }],
    });
    const r = await processDueDeliveries({
      repos: t.repos,
      box: t.box,
      connections: strict,
      now: t.now,
      config: { maxAttempts: 1 },
    });
    expect(r.failed).toBe(1);
    expect(server.received).toHaveLength(0);
  });
});
