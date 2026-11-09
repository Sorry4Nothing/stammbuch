import { simpleParser, type ParsedMail } from "mailparser";
import { SMTPServer } from "smtp-server";
import type { AddressInfo } from "node:net";
import { SecretBox } from "./crypto.js";
import { createMemoryRepositories } from "./memory.js";
import type { ConnectionFactory, ImapConnection, SmtpConnection } from "./ports.js";
import { MailService, type MailServiceConfig } from "./service.js";
import { createConnectionFactory } from "./transport.js";
import type { MailAccount, MailContext, OutgoingMail, ReadMessage } from "./types.js";

export const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
export const newBox = () => new SecretBox({ keys: { k1: TEST_KEY }, currentKeyId: "k1" });

export const ctxA: MailContext = { tenantId: "t1", userId: "u1", email: "ich@example.test" };
export const ctxOtherUser: MailContext = { tenantId: "t1", userId: "u2", email: "du@example.test" };
export const ctxOtherTenant: MailContext = {
  tenantId: "t2",
  userId: "u1",
  email: "ich@example.test",
};

/** Echter SMTP-Server (smtp-server) auf Loopback mit STARTTLS und Pflicht-Anmeldung. */
export async function startSmtpServer(opts: { starttls?: boolean; rejectRcpt?: string } = {}) {
  const received: ParsedMail[] = [];
  const server = new SMTPServer({
    logger: false,
    authOptional: false,
    // Anmeldung nur über TLS (allowInsecureAuth ist standardmässig aus).
    disabledCommands: opts.starttls === false ? ["STARTTLS"] : [],
    onAuth(auth, _session, cb) {
      if (auth.username === "user" && auth.password === "app-passwort") cb(null, { user: "user" });
      else cb(new Error("Invalid login"));
    },
    onRcptTo(address, _session, cb) {
      if (opts.rejectRcpt && address.address === opts.rejectRcpt) {
        const err = Object.assign(new Error("Mailbox unavailable"), { responseCode: 550 });
        return cb(err);
      }
      cb();
    },
    onData(stream, _session, cb) {
      simpleParser(stream).then(
        (m) => {
          received.push(m);
          cb();
        },
        (e: Error) => cb(e),
      );
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.server.address() as AddressInfo).port;
  return {
    port,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Verbindungsfabrik gegen den lokalen Testserver (selbstsigniertes Zertifikat akzeptiert). */
export const localFactory = () =>
  createConnectionFactory({
    allowPrivateHosts: true,
    tlsOverrides: { rejectUnauthorized: false },
    timeoutMs: 5000,
  });

export interface FakeState {
  sent: OutgoingMail[];
  smtpFailures: (Error | undefined)[];
  inbox: ReadMessage[];
  smtpOpened: number;
  /** Was die Fake-Verbindung auf dem «Server» getan hat. */
  seen: { folder: string; uids: number[] }[];
  removed: { folder: string; uids: number[] }[];
  drafts: OutgoingMail[];
}

/** Austauschbare Verbindungen ohne Netz: erfasst Mails, liefert vorbereitete Posteingänge. */
export function fakeConnections(state: Partial<FakeState> = {}): {
  factory: ConnectionFactory;
  state: FakeState;
} {
  const s: FakeState = {
    sent: [],
    smtpFailures: [],
    inbox: [],
    smtpOpened: 0,
    seen: [],
    removed: [],
    drafts: [],
    ...state,
  };
  const smtp: SmtpConnection = {
    async send(mail) {
      const failure = s.smtpFailures.shift();
      if (failure) throw failure;
      s.sent.push(mail);
      return { messageId: `<m${s.sent.length}@test>` };
    },
    verify: async () => undefined,
    close: () => undefined,
  };
  const imap: ImapConnection = {
    list: async () => ({
      total: s.inbox.length,
      unread: s.inbox.length,
      messages: s.inbox.map((m) => ({
        uid: m.uid,
        from: m.from.address,
        subject: m.subject,
        date: m.date,
        seen: false,
        answered: false,
        attachments: m.attachments.length,
      })),
    }),
    read: async (_f, uid) => s.inbox.find((m) => m.uid === uid) ?? null,
    counts: async (folders) =>
      folders
        .filter((f) => f !== "Fehlt")
        .map((folder) => ({ folder, total: s.inbox.length, unread: s.inbox.length })),
    markSeen: async (folder, uids) => {
      s.seen.push({ folder, uids });
    },
    remove: async (folder, uids) => {
      s.removed.push({ folder, uids });
    },
    saveDraft: async (mail) => {
      s.drafts.push(mail);
    },
    close: async () => undefined,
  };
  return {
    state: s,
    factory: {
      smtp: async () => {
        s.smtpOpened++;
        return smtp;
      },
      imap: async () => imap,
      checkEndpoint: async () => undefined,
    },
  };
}

export function makeService(
  config: Partial<MailServiceConfig> = {},
  connections: ConnectionFactory = fakeConnections().factory,
) {
  const repos = createMemoryRepositories();
  const box = newBox();
  let clock = new Date("2026-11-04T10:00:00Z");
  const service = new MailService({ repos, box, connections, config, now: () => clock });
  return {
    service,
    repos,
    box,
    connections,
    now: () => clock,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

export const endpoint = { host: "mail.example.test", port: 587, security: "starttls" } as const;
export const accountInput = {
  label: "Verein",
  fromAddress: "verein@example.test",
  fromName: "Verein Muster",
  username: "user",
  password: "app-passwort",
  smtp: endpoint,
  imap: { host: "mail.example.test", port: 993, security: "tls" },
} as const;

/** Schlüsselwechsel: `oldBox` kennt nur k1, `newBox` kennt k1 und k2 und verschlüsselt mit k2. */
export const rotationBoxes = () => {
  const k = (n: number) => Buffer.alloc(32, n).toString("base64");
  return {
    oldBox: new SecretBox({ keys: { k1: TEST_KEY }, currentKeyId: "k1" }),
    ringBox: new SecretBox({ keys: { k1: TEST_KEY, k2: k(2) }, currentKeyId: "k2" }),
    // Ein Schlüsselring ohne k1: Konten aus k1 lassen sich hier nicht mehr lesen.
    otherBox: new SecretBox({ keys: { k0: k(9) }, currentKeyId: "k0" }),
  };
};

/** Ein Konto mit dem Passwort `password`, verschlüsselt mit `box` (zum direkten Einfügen ins Repository). */
export function accountWith(
  box: SecretBox,
  fields: Pick<MailAccount, "id" | "tenantId" | "ownerUserId">,
  password: string,
): MailAccount {
  return {
    ...fields,
    label: "V",
    fromAddress: "v@example.test",
    username: "user",
    secretEnc: box.encrypt(password, fields.id),
    smtp: endpoint,
    createdAt: new Date("2026-11-04T10:00:00.000Z"),
  };
}
