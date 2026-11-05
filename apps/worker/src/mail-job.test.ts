import { createMemoryRepositories, MailService, SecretBox } from "@stammbuch/mail";
import type { ConnectionFactory, OutgoingMail } from "@stammbuch/mail";
import { describe, expect, it, vi } from "vitest";
import { createMailJob, mailTick } from "./mail-job.js";

const key = Buffer.alloc(32, 1).toString("base64");
const ctx = { tenantId: "t1", userId: "u1", email: "ich@example.test" };

describe("Mail-Job im Worker", () => {
  it("stellt fällige Mails zu und protokolliert nur Zähler", async () => {
    const sent: OutgoingMail[] = [];
    const connections: ConnectionFactory = {
      checkEndpoint: async () => undefined,
      imap: async () => {
        throw new Error("nicht benötigt");
      },
      smtp: async () => ({
        send: async (m) => {
          sent.push(m);
          return { messageId: "<x@test>" };
        },
        verify: async () => undefined,
        close: () => undefined,
      }),
    };
    const repos = createMemoryRepositories();
    const box = new SecretBox({ keys: { k1: key }, currentKeyId: "k1" });
    const service = new MailService({ repos, box, connections });
    const account = await service.addAccount(ctx, {
      label: "V",
      fromAddress: "v@example.test",
      username: "u",
      password: "pw",
      smtp: { host: "smtp.example.test", port: 587, security: "starttls" },
    });
    await service.sendTransactional(ctx, {
      accountId: account.id,
      to: { email: "a@example.test" },
      subject: "Hallo",
      bodyHtml: "<p>Hallo</p>",
    });

    const log = { info: vi.fn() };
    await mailTick({ repos, box, connections }, log)(new AbortController().signal);

    expect(sent).toHaveLength(1);
    expect(log.info).toHaveBeenCalledWith(
      { sent: 1, retried: 0, failed: 0, deferred: 0 },
      "Mailversand-Durchlauf",
    );
    expect(JSON.stringify(log.info.mock.calls)).not.toContain("example.test");

    // Zweiter Durchlauf ohne Arbeit bleibt still.
    await mailTick({ repos, box, connections }, log)(new AbortController().signal);
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it("ist ohne Schlüssel aus", () => {
    expect(createMailJob({}, { info: vi.fn() })).toBeNull();
  });

  it("verweigert interne Mailserver in Produktion (fail secure)", () => {
    expect(() =>
      createMailJob(
        {
          MAIL_ENCRYPTION_KEYS: `k1:${key}`,
          MAIL_ALLOW_PRIVATE_HOSTS: "true",
          NODE_ENV: "production",
        },
        { info: vi.fn() },
      ),
    ).toThrow();
  });
});
