import { isIP } from "node:net";
import type { ConnectionOptions } from "node:tls";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createTransport } from "nodemailer";
import type { ConnectionFactory, ImapConnection, SmtpConnection } from "./ports.js";
import {
  IMAP_PORTS,
  MailError,
  SMTP_PORTS,
  resolvePublicHost,
  type HostGuardOptions,
  type MailErrorCode,
} from "./net-guard.js";
import type { Endpoint, FolderCount, MailAccount, OutgoingMail, ReadMessage } from "./types.js";

export interface ConnectionFactoryOptions extends HostGuardOptions {
  /** Nur Tests: zusätzliche TLS-Optionen (z.B. selbstsigniertes Zertifikat des Test-Servers). */
  tlsOverrides?: ConnectionOptions;
  timeoutMs?: number;
}

const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

/**
 * Ordnet Fehler von nodemailer/imapflow einem festen Code zu. Der Rohtext des Servers wird
 * verworfen: Er kann Hostnamen, Adressen oder Hinweise auf interne Systeme enthalten (SR-51).
 */
export function classifyError(err: unknown): MailError {
  if (err instanceof MailError) return err;
  const e = (typeof err === "object" && err !== null ? err : {}) as {
    code?: unknown;
    responseCode?: unknown;
    authenticationFailed?: unknown;
    message?: unknown;
  };
  const code = typeof e.code === "string" ? e.code : "";
  const status = typeof e.responseCode === "number" ? e.responseCode : 0;
  const msg = typeof e.message === "string" ? e.message : "";
  let result: MailErrorCode = "CONNECT";
  if (code === "EAUTH" || e.authenticationFailed === true || status === 535) result = "AUTH";
  else if (/tls|ssl|certificate|starttls|self.signed/i.test(msg) || /^ERR_(TLS|SSL)/.test(code))
    result = "TLS";
  else if (code === "EENVELOPE" || (status >= 500 && status < 600)) result = "REJECTED";
  else if (status >= 400 || code === "ETIMEDOUT" || code === "ECONNECTION" || code === "ESOCKET")
    result = "TRANSIENT";
  return new MailError(result);
}

/** Permanente Fehler lohnen keinen Wiederholungsversuch. */
export const isPermanent = (code: MailErrorCode) =>
  code === "AUTH" ||
  code === "REJECTED" ||
  code === "TLS" ||
  code === "BLOCKED_HOST" ||
  code === "BAD_PORT";

interface StructureNode {
  type?: string;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  parameters?: Record<string, string>;
  childNodes?: StructureNode[];
}

/** Zählt Anhänge in der MIME-Struktur eines IMAP-Servers: Teile mit Disposition «attachment» oder Dateiname ausser Text. */
export function countAttachments(node: StructureNode | undefined): number {
  if (!node) return 0;
  if (node.childNodes?.length) return node.childNodes.reduce((n, c) => n + countAttachments(c), 0);
  if (node.disposition?.toLowerCase() === "attachment") return 1;
  const named = node.dispositionParameters?.["filename"] ?? node.parameters?.["name"];
  return named && !node.type?.toLowerCase().startsWith("text/") ? 1 : 0;
}

/** Die Mail als RFC-822-Text, ohne sie zu versenden (für den Entwurfsordner). */
async function toRaw(mail: OutgoingMail): Promise<Buffer> {
  const transport = createTransport({
    streamTransport: true,
    buffer: true,
    newline: "windows",
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const info = await transport.sendMail({
    ...(mail.messageId ? { messageId: mail.messageId } : {}),
    from: { name: mail.from.name ?? "", address: mail.from.address },
    ...(mail.to.length > 0
      ? { to: mail.to.map((t) => ({ name: t.name ?? "", address: t.address })) }
      : {}),
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    attachments: mail.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  });
  if (!Buffer.isBuffer(info.message)) throw new MailError("INTERNAL");
  return info.message;
}

function tlsOptions(endpoint: Endpoint, opts: ConnectionFactoryOptions): ConnectionOptions {
  return {
    minVersion: "TLSv1.2",
    // Zertifikatsprüfung bleibt in jedem Betrieb an; nur Tests setzen über tlsOverrides eine eigene CA.
    rejectUnauthorized: true,
    ...(isIP(endpoint.host) ? {} : { servername: endpoint.host }),
    ...opts.tlsOverrides,
  };
}

export function createConnectionFactory(opts: ConnectionFactoryOptions = {}): ConnectionFactory {
  const timeout = opts.timeoutMs ?? 20_000;

  return {
    async checkEndpoint(kind, endpoint) {
      await resolvePublicHost(
        endpoint.host,
        endpoint.port,
        kind === "smtp" ? SMTP_PORTS : IMAP_PORTS,
        opts,
      );
    },

    async smtp(account: MailAccount, password: string): Promise<SmtpConnection> {
      const { smtp } = account;
      const ip = await resolvePublicHost(smtp.host, smtp.port, SMTP_PORTS, opts);
      const transport = createTransport({
        host: ip,
        port: smtp.port,
        secure: smtp.security === "tls",
        // TLS-Pflicht: STARTTLS ist vorgeschrieben, nie Klartext (SR-40).
        requireTLS: smtp.security === "starttls",
        auth: { user: account.username, pass: password },
        tls: tlsOptions(smtp, opts),
        // EHLO-Name aus der Absenderdomain statt des internen Hostnamens.
        name: account.fromAddress.split("@")[1] ?? "localhost",
        connectionTimeout: timeout,
        greetingTimeout: timeout,
        socketTimeout: timeout,
        disableFileAccess: true,
        disableUrlAccess: true,
        logger: false,
      });
      return {
        async send(mail) {
          try {
            const info = await transport.sendMail({
              from: { name: mail.from.name ?? "", address: mail.from.address },
              to: mail.to.map((t) => ({ name: t.name ?? "", address: t.address })),
              subject: mail.subject,
              html: mail.html,
              text: mail.text,
              ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
              ...(mail.references?.length ? { references: mail.references } : {}),
              attachments: mail.attachments?.map((a) => ({
                filename: a.filename,
                content: a.content,
                contentType: a.contentType,
              })),
            });
            return { messageId: info.messageId };
          } catch (err) {
            throw classifyError(err);
          }
        },
        async verify() {
          try {
            await transport.verify();
          } catch (err) {
            throw classifyError(err);
          }
        },
        close: () => transport.close(),
      };
    },

    async imap(account: MailAccount, password: string): Promise<ImapConnection> {
      const { imap } = account;
      if (!imap) throw new MailError("VALIDATION");
      const ip = await resolvePublicHost(imap.host, imap.port, IMAP_PORTS, opts);
      const client = new ImapFlow({
        host: ip,
        port: imap.port,
        secure: imap.security === "tls",
        // STARTTLS erzwingen: ohne diese Option würde imapflow bei fehlendem STARTTLS im Klartext weitermachen.
        ...(imap.security === "starttls" ? { doSTARTTLS: true } : {}),
        auth: { user: account.username, pass: password },
        tls: tlsOptions(imap, opts),
        connectionTimeout: timeout,
        greetingTimeout: timeout,
        socketTimeout: timeout,
        logger: false,
      });
      client.on("error", () => undefined); // Fehler kommen über die awaitete Operation.
      try {
        await client.connect();
      } catch (err) {
        throw classifyError(err);
      }

      /** Pfad des Sonderordners (`\Trash`, `\Drafts`) oder, wenn der Server keinen kennzeichnet, der übliche Name. */
      const specialFolder = async (use: "\\Trash" | "\\Drafts", fallback: string) => {
        const boxes = await client.list();
        return (
          boxes.find((b) => b.specialUse === use)?.path ??
          boxes.find((b) => b.path.toLowerCase() === fallback.toLowerCase())?.path ??
          null
        );
      };
      const range = (uids: number[]) => uids.join(",");

      return {
        async list(folder, page, pageSize) {
          const lock = await client.getMailboxLock(folder, { readOnly: true });
          try {
            const total = client.mailbox ? client.mailbox.exists : 0;
            const unseen = total > 0 ? await client.search({ seen: false }, { uid: true }) : [];
            const unread = Array.isArray(unseen) ? unseen.length : 0;
            const to = total - (page - 1) * pageSize;
            if (to < 1) return { total, unread, messages: [] };
            const from = Math.max(1, to - pageSize + 1);
            const messages = [];
            for await (const m of client.fetch(`${from}:${to}`, {
              uid: true,
              envelope: true,
              flags: true,
              bodyStructure: true,
            })) {
              const f = m.envelope?.from?.[0];
              messages.push({
                uid: m.uid,
                from: f?.name || f?.address || "",
                subject: m.envelope?.subject ?? "",
                date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : null,
                seen: m.flags?.has("\\Seen") ?? false,
                answered: m.flags?.has("\\Answered") ?? false,
                attachments: countAttachments(m.bodyStructure as StructureNode | undefined),
              });
            }
            return { total, unread, messages: messages.reverse() };
          } catch (err) {
            throw classifyError(err);
          } finally {
            lock.release();
          }
        },

        async counts(folders): Promise<FolderCount[]> {
          const out: FolderCount[] = [];
          for (const folder of folders) {
            try {
              const s = await client.status(folder, { messages: true, unseen: true });
              if (s) out.push({ folder, total: s.messages ?? 0, unread: s.unseen ?? 0 });
            } catch {
              // Den Ordner gibt es auf diesem Server nicht: kein Zähler.
            }
          }
          return out;
        },

        async markSeen(folder, uids) {
          const lock = await client.getMailboxLock(folder);
          try {
            await client.messageFlagsAdd(range(uids), ["\\Seen"], { uid: true });
          } catch (err) {
            throw classifyError(err);
          } finally {
            lock.release();
          }
        },

        async remove(folder, uids) {
          try {
            const trash = await specialFolder("\\Trash", "Trash");
            if (!trash) throw new MailError("NOT_FOUND");
            const lock = await client.getMailboxLock(folder);
            try {
              if (folder.toLowerCase() === trash.toLowerCase()) {
                await client.messageDelete(range(uids), { uid: true });
              } else {
                await client.messageMove(range(uids), trash, { uid: true });
              }
            } finally {
              lock.release();
            }
          } catch (err) {
            throw classifyError(err);
          }
        },

        async saveDraft(mail, replaces) {
          try {
            const drafts = await specialFolder("\\Drafts", "Drafts");
            if (!drafts) throw new MailError("NOT_FOUND");
            await client.append(drafts, await toRaw(mail), ["\\Draft", "\\Seen"]);
            if (!replaces || replaces === mail.messageId) return;
            // Der neue Entwurf steht schon; das Aufräumen des alten darf ihn nicht mehr gefährden.
            try {
              const lock = await client.getMailboxLock(drafts);
              try {
                const old = await client.search(
                  { header: { "message-id": replaces } },
                  { uid: true },
                );
                if (Array.isArray(old) && old.length > 0) {
                  await client.messageDelete(range(old), { uid: true });
                }
              } finally {
                lock.release();
              }
            } catch {
              // shortcut: eine alte Kopie bleibt stehen, wenn der Server das Löschen ablehnt; Nutzer löscht sie von Hand.
            }
          } catch (err) {
            throw classifyError(err);
          }
        },

        async read(folder, uid): Promise<ReadMessage | null> {
          const lock = await client.getMailboxLock(folder, { readOnly: true });
          try {
            const msg = await client.fetchOne(
              String(uid),
              { uid: true, source: { maxLength: MAX_MESSAGE_BYTES } },
              { uid: true },
            );
            if (!msg || !msg.source) return null;
            const p = await simpleParser(msg.source);
            const refs = Array.isArray(p.references)
              ? p.references
              : p.references
                ? [p.references]
                : [];
            const addr = (a: typeof p.from) =>
              (a?.value ?? []).map((v) => ({
                name: v.name || undefined,
                address: v.address ?? "",
              }));
            return {
              uid,
              from: addr(p.from)[0] ?? { address: "" },
              to: addr(Array.isArray(p.to) ? p.to[0] : p.to),
              subject: p.subject ?? "",
              date: p.date ? p.date.toISOString() : null,
              messageId: p.messageId,
              references: refs,
              html: typeof p.html === "string" ? p.html : undefined,
              text: p.text,
              attachments: p.attachments.map((a) => ({
                filename: a.filename ?? "Anhang",
                contentType: a.contentType,
                size: a.size,
              })),
            };
          } catch (err) {
            throw classifyError(err);
          } finally {
            lock.release();
          }
        },

        async close() {
          await client.logout().catch(() => client.close());
        },
      };
    },
  };
}
