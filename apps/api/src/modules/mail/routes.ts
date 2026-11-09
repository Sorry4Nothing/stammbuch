import { MailError } from "@stammbuch/mail";
import type { ListView, MailContext, MailService } from "@stammbuch/mail";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { validate } from "../../lib/validate.js";

declare module "fastify" {
  interface FastifyRequest {
    mailCtx: MailContext | null;
  }
}

export type ContextResolver = (
  req: FastifyRequest,
) => Promise<MailContext | null> | MailContext | null;

export interface MailRouteDeps {
  service: MailService;
  resolveContext: ContextResolver;
  /** Fehlerhandler für alles, was kein MailError ist (der zentrale Handler der API). */
  onError: (error: unknown, request: FastifyRequest, reply: FastifyReply) => unknown;
}

// ---------------------------------------------------------------- Schemas
// Nur die aufgeführten Felder werden übernommen (z.object entfernt Unbekanntes, SR-72).

const str = (max: number) => z.string().max(max);
const id = z.string().min(1).max(64);
const idParam = z.object({ id });

const endpoint = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  security: z.enum(["tls", "starttls"]),
});

const recipient = z.object({
  email: str(254),
  anrede: str(120).optional(),
  vorname: str(80).optional(),
  nachname: str(80).optional(),
  name: str(160).optional(),
  antwortlink: str(2000).optional(),
});

const accountBody = z.object({
  label: z.string().min(1).max(80),
  fromAddress: str(254),
  fromName: str(120).optional(),
  username: z.string().min(1).max(254),
  password: z.string().min(1).max(512),
  smtp: endpoint,
  imap: endpoint.optional(),
});

const composeBody = z.object({
  accountId: id,
  subject: z.string().min(1).max(300),
  bodyHtml: z.string().min(1).max(600_000),
  attachmentIds: z.array(id).max(10).optional(),
  listIds: z.array(id).max(20).optional(),
  groupIds: z.array(id).max(50).optional(),
  manual: z.array(recipient).max(5000).optional(),
  sendAt: z.iso
    .datetime({ offset: true })
    .transform((v) => new Date(v))
    .optional(),
});

const listBody = z.object({
  name: z.string().min(1).max(100),
  description: str(500).optional(),
  manual: z.array(recipient).max(5000).optional(),
  groupIds: z.array(id).max(50).optional(),
  personIds: z.array(id).max(5000).optional(),
});

const folderName = z.string().min(1).max(100);
const folderQuery = z.object({
  folder: folderName.default("INBOX"),
});
const countsQuery = z.object({
  folders: z
    .string()
    .min(1)
    .max(800)
    .transform((v) => v.split(",")),
});
const uidsBody = z.object({
  folder: folderName,
  uids: z.array(z.number().int().min(1)).min(1).max(200),
});
const draftBody = z.object({
  to: z.object({ email: str(254), name: str(160).optional() }).optional(),
  subject: str(300),
  bodyHtml: str(600_000),
  attachmentIds: z.array(id).max(10).optional(),
});
const replyBody = z.object({
  bodyHtml: z.string().min(1).max(600_000),
  attachmentIds: z.array(id).max(10).optional(),
});
const rescheduleBody = z.object({
  sendAt: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
});
const inboxQuery = folderQuery.extend({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(25),
});
const uidParam = z.object({ id, uid: z.coerce.number().int().min(1) });
const deliveriesQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const attachmentBody = z.object({
  filename: z.string().min(1).max(200),
  contentBase64: z.string().min(1).max(15_000_000),
});

// ----------------------------------------------------------------- Fehler

const HTTP: Record<string, [number, string]> = {
  VALIDATION: [400, "Ungültige Anfrage."],
  FORBIDDEN: [403, "Nicht erlaubt."],
  NOT_FOUND: [404, "Nicht gefunden."],
  CONFLICT: [409, "Aktion in diesem Zustand nicht möglich."],
  TOO_LARGE: [413, "Anfrage zu gross."],
  BLOCKED_HOST: [422, "Dieser Mailserver ist nicht erlaubt."],
  BAD_PORT: [422, "Dieser Port ist nicht erlaubt."],
  // Fehler beim externen Mailserver: nur die Kategorie, nie der Servertext (SR-51).
  AUTH: [502, "Anmeldung am Mailserver fehlgeschlagen."],
  TLS: [502, "Sichere Verbindung zum Mailserver nicht möglich."],
  CONNECT: [502, "Mailserver nicht erreichbar."],
  REJECTED: [502, "Der Mailserver hat die Nachricht abgelehnt."],
  TRANSIENT: [502, "Mailserver vorübergehend nicht verfügbar."],
};

// ------------------------------------------------------------ Projektionen
// Antworten enthalten nur die benötigten Felder (SR-74), nie Mandanten-ID oder Chiffretext.

const account = (a: Awaited<ReturnType<MailService["addAccount"]>>) => ({
  id: a.id,
  label: a.label,
  fromAddress: a.fromAddress,
  fromName: a.fromName ?? null,
  username: a.username,
  smtp: a.smtp,
  imap: a.imap ?? null,
  createdAt: a.createdAt,
});

const list = (v: ListView, withPeople = false) => ({
  id: v.list.id,
  name: v.list.name,
  description: v.list.description,
  manual: v.list.manual,
  groupIds: v.list.groupIds,
  personIds: v.list.personIds,
  lastUsedAt: v.list.lastUsedAt ?? null,
  stats: v.stats,
  ...(withPeople ? { people: v.people } : {}),
});

const campaign = (c: Awaited<ReturnType<MailService["getCampaignStatus"]>>["campaign"]) => ({
  id: c.id,
  accountId: c.accountId,
  subject: c.subject,
  state: c.state,
  scheduledAt: c.scheduledAt,
  recipientCount: c.recipientCount,
  attachmentIds: c.attachmentIds,
  createdAt: c.createdAt,
  confirmedAt: c.confirmedAt ?? null,
  confirmedBy: c.confirmedBy ?? null,
  listName: c.listName ?? null,
});

const status = (s: Awaited<ReturnType<MailService["getCampaignStatus"]>>) => ({
  campaign: campaign(s.campaign),
  counts: s.counts,
});

/** Strengere Limits für teure oder missbrauchsanfällige Routen (SR-71), zusätzlich zum globalen Limit. */
const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: "1 minute" } } });

export async function registerMailRoutes(app: FastifyInstance, deps: MailRouteDeps) {
  const { service } = deps;

  app.decorateRequest("mailCtx", null);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof MailError) {
      const [code, message] = HTTP[error.code] ?? [500, "Interner Fehler."];
      if (code >= 500 && error.code === "INTERNAL")
        request.log.error({ code: error.code }, "Mail-Fehler");
      else request.log.info({ code: error.code }, "Mail-Anfrage abgelehnt");
      return reply.status(code).send({ error: { code: error.code, message } });
    }
    return deps.onError(error, request, reply);
  });

  // Authentifizierung für jede Route des Moduls (SR-10). Kein Kontext = 401, nie «fail open».
  app.addHook("preHandler", async (req, reply) => {
    const ctx = await deps.resolveContext(req);
    if (!ctx) {
      return reply
        .status(401)
        .send({ error: { code: "UNAUTHENTICATED", message: "Anmeldung erforderlich." } });
    }
    req.mailCtx = ctx;
  });
  const ctxOf = (req: FastifyRequest): MailContext => {
    if (!req.mailCtx) throw new MailError("FORBIDDEN");
    return req.mailCtx;
  };

  // Konten
  app.get("/mail/accounts", async (req) => (await service.listAccounts(ctxOf(req))).map(account));
  app.post("/mail/accounts", limit(10), async (req, reply) => {
    const created = await service.addAccount(ctxOf(req), validate(accountBody, req.body));
    return reply.status(201).send(account(created));
  });
  app.delete("/mail/accounts/:id", async (req, reply) => {
    await service.deleteAccount(ctxOf(req), validate(idParam, req.params).id);
    return reply.status(204).send();
  });
  app.post("/mail/accounts/:id/verify", limit(5), async (req) =>
    service.verifyAccount(ctxOf(req), validate(idParam, req.params).id),
  );

  // Posteingang
  app.get("/mail/accounts/:id/inbox", limit(60), async (req) => {
    const { id: accountId } = validate(idParam, req.params);
    const q = validate(inboxQuery, req.query);
    return service.inbox(ctxOf(req), accountId, q.folder, q.page, q.pageSize);
  });
  app.get("/mail/accounts/:id/messages/:uid", limit(120), async (req) => {
    const p = validate(uidParam, req.params);
    return service.readMessage(ctxOf(req), p.id, validate(folderQuery, req.query).folder, p.uid);
  });
  app.post("/mail/accounts/:id/messages/:uid/reply", limit(20), async (req) => {
    const p = validate(uidParam, req.params);
    const q = validate(folderQuery, req.query);
    const b = validate(replyBody, req.body);
    return service.reply(ctxOf(req), p.id, q.folder, p.uid, b.bodyHtml, b.attachmentIds ?? []);
  });
  app.get("/mail/accounts/:id/counts", limit(60), async (req) => {
    const { id: accountId } = validate(idParam, req.params);
    return service.folderCounts(ctxOf(req), accountId, validate(countsQuery, req.query).folders);
  });
  app.post("/mail/accounts/:id/messages/mark-read", limit(60), async (req, reply) => {
    const b = validate(uidsBody, req.body);
    await service.markRead(ctxOf(req), validate(idParam, req.params).id, b.folder, b.uids);
    return reply.status(204).send();
  });
  app.post("/mail/accounts/:id/messages/delete", limit(60), async (req, reply) => {
    const b = validate(uidsBody, req.body);
    await service.deleteMessages(ctxOf(req), validate(idParam, req.params).id, b.folder, b.uids);
    return reply.status(204).send();
  });
  app.post("/mail/accounts/:id/drafts", limit(30), async (req, reply) => {
    await service.saveDraft(
      ctxOf(req),
      validate(idParam, req.params).id,
      validate(draftBody, req.body),
    );
    return reply.status(201).send({ saved: true });
  });

  // Anhänge: Base64 im JSON (kein Multipart nötig), Limit nur für diese Route erhöht (SR-23).
  app.post(
    "/mail/attachments",
    { ...limit(30), bodyLimit: 16 * 1024 * 1024 },
    async (req, reply) => {
      const b = validate(attachmentBody, req.body);
      const meta = await service.addAttachment(
        ctxOf(req),
        b.filename,
        Buffer.from(b.contentBase64, "base64"),
      );
      return reply.status(201).send({
        id: meta.id,
        filename: meta.filename,
        contentType: meta.contentType,
        size: meta.size,
      });
    },
  );

  // Adresslisten
  app.get("/mail/address-lists", limit(60), async (req) => {
    const ctx = ctxOf(req);
    return (await service.viewLists(ctx, await service.listLists(ctx))).map((v) => list(v));
  });
  app.post("/mail/address-lists", limit(30), async (req, reply) => {
    const ctx = ctxOf(req);
    const created = await service.createList(ctx, validate(listBody, req.body));
    return reply.status(201).send(list(await service.viewList(ctx, created), true));
  });
  app.get("/mail/address-lists/:id", limit(60), async (req) => {
    const ctx = ctxOf(req);
    return list(
      await service.viewList(ctx, await service.getList(ctx, validate(idParam, req.params).id)),
      true,
    );
  });
  app.put("/mail/address-lists/:id", limit(30), async (req) => {
    const ctx = ctxOf(req);
    const updated = await service.updateList(
      ctx,
      validate(idParam, req.params).id,
      validate(listBody.partial(), req.body),
    );
    return list(await service.viewList(ctx, updated), true);
  });
  // Gruppen des Personenmoduls mit der Zahl der Personen und derer ohne E-Mail-Adresse.
  app.get("/mail/groups", limit(30), async (req) => service.listGroups(ctxOf(req)));
  app.delete("/mail/address-lists/:id", async (req, reply) => {
    await service.deleteList(ctxOf(req), validate(idParam, req.params).id);
    return reply.status(204).send();
  });

  // Versand
  app.post("/mail/test-send", limit(5), async (req) => {
    await service.testSend(ctxOf(req), validate(composeBody, req.body));
    return { sent: true };
  });
  app.post("/mail/campaigns", limit(20), async (req, reply) => {
    const p = await service.prepareCampaign(ctxOf(req), validate(composeBody, req.body));
    return reply.status(201).send(p);
  });
  app.get("/mail/campaigns", async (req) =>
    (await service.listCampaigns(ctxOf(req))).map(campaign),
  );
  app.get("/mail/campaigns/:id", async (req) =>
    status(await service.getCampaignStatus(ctxOf(req), validate(idParam, req.params).id)),
  );
  app.get("/mail/campaigns/:id/deliveries", async (req) => {
    const q = validate(deliveriesQuery, req.query);
    return service.listDeliveries(ctxOf(req), validate(idParam, req.params).id, q.offset, q.limit);
  });
  app.post("/mail/campaigns/:id/confirm", limit(10), async (req) => {
    const { token } = validate(z.object({ token: z.string().min(20).max(100) }), req.body);
    return status(
      await service.confirmCampaign(ctxOf(req), validate(idParam, req.params).id, token),
    );
  });
  app.post("/mail/campaigns/:id/cancel", limit(20), async (req) =>
    status(await service.cancelCampaign(ctxOf(req), validate(idParam, req.params).id)),
  );
  app.post("/mail/campaigns/:id/pause", limit(20), async (req) =>
    status(await service.pauseCampaign(ctxOf(req), validate(idParam, req.params).id)),
  );
  app.post("/mail/campaigns/:id/send-now", limit(20), async (req) =>
    status(await service.sendCampaignNow(ctxOf(req), validate(idParam, req.params).id)),
  );
  app.post("/mail/campaigns/:id/reschedule", limit(20), async (req) =>
    status(
      await service.rescheduleCampaign(
        ctxOf(req),
        validate(idParam, req.params).id,
        validate(rescheduleBody, req.body).sendAt,
      ),
    ),
  );
}
