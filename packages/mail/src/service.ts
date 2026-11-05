import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { checkAttachment } from "./attachments.js";
import type { SecretBox } from "./crypto.js";
import { assertEmail, displayName, emailSchema } from "./headers.js";
import { buildOutgoing, recipientValues, wrapPaper } from "./message.js";
import { MailError, type MailErrorCode } from "./net-guard.js";
import type {
  CampaignStatus,
  ConnectionFactory,
  GroupLookup,
  ImapConnection,
  MailPort,
  PrepareCampaignInput,
  PreparedCampaign,
  SmtpConnection,
  TransactionalMail,
} from "./ports.js";
import type { MailRepositories } from "./repositories.js";
import { htmlToText, sanitizeMailHtml } from "./sanitize.js";
import {
  BUILTIN_PLACEHOLDERS,
  assertKnownPlaceholders,
  escapeHtml,
  headerSafe,
  placeholdersIn,
} from "./template.js";
import type {
  AddressList,
  AttachmentMeta,
  Campaign,
  Delivery,
  Endpoint,
  MailAccount,
  MailContext,
  PublicAccount,
  ReadMessage,
  Recipient,
} from "./types.js";

export interface MailServiceConfig {
  maxAttachmentBytes: number;
  maxAttachmentsPerMail: number;
  maxRecipients: number;
  maxBodyChars: number;
  confirmationTtlMs: number;
  /** Bis zu dieser Empfängerzahl braucht ein Versand keine Bestätigung (Einzelmail). */
  autoConfirmUpTo: number;
}

export const defaultServiceConfig: MailServiceConfig = {
  maxAttachmentBytes: 10 * 1024 * 1024,
  maxAttachmentsPerMail: 10,
  maxRecipients: 5000,
  maxBodyChars: 500_000,
  confirmationTtlMs: 30 * 60_000,
  autoConfirmUpTo: 1,
};

export interface MailServiceDeps {
  repos: MailRepositories;
  box: SecretBox;
  connections: ConnectionFactory;
  groups?: GroupLookup;
  config?: Partial<MailServiceConfig>;
  now?: () => Date;
}

export interface RotationResult {
  rotated: number;
  /** Konto-IDs, die sich nicht umschlüsseln liessen (Schlüssel fehlt, Daten beschädigt). Nie Schlüssel oder Klartext. */
  failed: string[];
  aborted: boolean;
}

export interface NewAccountInput {
  label: string;
  fromAddress: string;
  fromName?: string | undefined;
  username: string;
  /** Passwort oder App-Passwort; wird sofort verschlüsselt und nie zurückgegeben. */
  password: string;
  smtp: Endpoint;
  imap?: Endpoint | undefined;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();
const FOLDER = /^[\p{L}\p{N} ._/-]{1,100}$/u;

/** Gruppen-Lookup ohne Quelle: liefert nichts (bis #3 eine Umsetzung stellt). */
export const noGroups: GroupLookup = { membersOf: async () => [] };

export class MailService implements MailPort {
  readonly #repos: MailRepositories;
  readonly #box: SecretBox;
  readonly #conn: ConnectionFactory;
  readonly #groups: GroupLookup;
  readonly #cfg: MailServiceConfig;
  readonly #now: () => Date;

  constructor(deps: MailServiceDeps) {
    this.#repos = deps.repos;
    this.#box = deps.box;
    this.#conn = deps.connections;
    this.#groups = deps.groups ?? noGroups;
    this.#cfg = { ...defaultServiceConfig, ...deps.config };
    this.#now = deps.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------- Konten

  async addAccount(ctx: MailContext, input: NewAccountInput): Promise<PublicAccount> {
    const fromAddress = assertEmail(input.fromAddress);
    await this.#conn.checkEndpoint("smtp", input.smtp);
    if (input.imap) await this.#conn.checkEndpoint("imap", input.imap);
    const id = randomUUID();
    const account: MailAccount = {
      id,
      tenantId: ctx.tenantId,
      ownerUserId: ctx.userId,
      label: headerSafe(input.label, 80),
      fromAddress,
      fromName: displayName(input.fromName),
      username: input.username,
      // `id` als Kontext: der Chiffretext ist nur für genau dieses Konto gültig.
      secretEnc: this.#box.encrypt(input.password, id),
      smtp: input.smtp,
      imap: input.imap,
      createdAt: this.#now(),
    };
    await this.#repos.accounts.insert(account);
    return toPublic(account);
  }

  async listAccounts(ctx: MailContext): Promise<PublicAccount[]> {
    return (await this.#repos.accounts.listByOwner(ctx.tenantId, ctx.userId)).map(toPublic);
  }

  async deleteAccount(ctx: MailContext, id: string): Promise<void> {
    await this.#account(ctx, id);
    await this.#repos.accounts.delete(ctx.tenantId, id);
  }

  /** Testet Anmeldung an SMTP (und IMAP, falls konfiguriert). Liefert Codes, nie Servertexte. */
  async verifyAccount(
    ctx: MailContext,
    id: string,
  ): Promise<{ smtp: "ok" | MailErrorCode; imap: "ok" | MailErrorCode | null }> {
    const account = await this.#account(ctx, id);
    const password = this.#box.decrypt(account.secretEnc, account.id);
    const attempt = async (fn: () => Promise<void>) => {
      try {
        await fn();
        return "ok" as const;
      } catch (err) {
        return err instanceof MailError ? err.code : ("CONNECT" as const);
      }
    };
    const smtp = await attempt(async () => {
      const c = await this.#conn.smtp(account, password);
      try {
        await c.verify();
      } finally {
        c.close();
      }
    });
    const imap = account.imap
      ? await attempt(async () => {
          const c = await this.#conn.imap(account, password);
          await c.close();
        })
      : null;
    return { smtp, imap };
  }

  /**
   * Rotationslauf (nur Worker): verschlüsselt die Zugangsdaten aller Mandanten mit dem aktuellen Schlüssel neu.
   * Wiederaufnehmbar: umgeschlüsselte Konten fallen aus der Abfrage, ein Abbruch (Signal, Fehler, Absturz) verliert nichts;
   * der nächste Lauf macht beim Rest weiter. Ein Konto, das sich nicht entschlüsseln lässt, kommt in `failed` (nur die ID)
   * und hält die anderen nicht auf. Geändert wird per Compare-and-swap, eine gleichzeitige Änderung des Benutzers bleibt erhalten.
   */
  async rotateSecrets(signal?: AbortSignal): Promise<RotationResult> {
    const result: RotationResult = { rotated: 0, failed: [], aborted: false };
    const page = 100;
    let after: string | null = null;
    for (;;) {
      const accounts = await this.#repos.accounts.listForRotation(
        this.#box.currentKeyId,
        after,
        page,
      );
      for (const a of accounts) {
        if (signal?.aborted) return { ...result, aborted: true };
        after = a.id;
        let enc: string;
        try {
          enc = this.#box.rotate(a.secretEnc, a.id);
        } catch {
          result.failed.push(a.id);
          continue;
        }
        // Datenbankfehler brechen den Lauf ab (kein Verlust, der nächste Lauf setzt fort).
        if (await this.#repos.accounts.replaceSecret(a.tenantId, a.id, a.secretEnc, enc)) {
          result.rotated++;
        }
      }
      if (accounts.length < page) return result;
    }
  }

  // ------------------------------------------------------------- Posteingang

  async inbox(ctx: MailContext, accountId: string, folder: string, page: number, pageSize: number) {
    assertFolder(folder);
    return this.#withImap(ctx, accountId, (c) => c.list(folder, page, pageSize));
  }

  /** Liest eine Mail. HTML wird serverseitig bereinigt, Remote-Bilder (Tracking) werden entfernt. */
  async readMessage(ctx: MailContext, accountId: string, folder: string, uid: number) {
    assertFolder(folder);
    const msg = await this.#withImap(ctx, accountId, (c) => c.read(folder, uid));
    if (!msg) throw new MailError("NOT_FOUND");
    return toSafeMessage(msg);
  }

  /** Antwort auf eine Mail: Empfänger, Betreff und Threading kommen vom Original, nicht vom Client. */
  async reply(
    ctx: MailContext,
    accountId: string,
    folder: string,
    uid: number,
    bodyHtml: string,
  ): Promise<{ messageId: string }> {
    assertFolder(folder);
    this.#assertBody(bodyHtml);
    const account = await this.#account(ctx, accountId);
    const original = await this.#withImap(ctx, accountId, (c) => c.read(folder, uid));
    if (!original) throw new MailError("NOT_FOUND");
    const to = assertEmail(original.from.address);

    const quoted = escapeHtml(
      original.text ?? htmlToText(sanitizeMailHtml(original.html ?? "")),
    ).replace(/\n/g, "<br>");
    const html = sanitizeMailHtml(`${bodyHtml}<blockquote>${quoted}</blockquote>`, {
      allowRemoteImages: true,
    });
    const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
    const msgId =
      original.messageId && /^<[^\s<>]{1,200}>$/.test(original.messageId)
        ? original.messageId
        : undefined;

    return this.#withSmtp(account, (c) =>
      c.send({
        from: { name: displayName(account.fromName), address: account.fromAddress },
        to: [{ name: displayName(original.from.name), address: to }],
        subject: headerSafe(subject, 200),
        html: wrapPaper(html),
        text: htmlToText(html),
        inReplyTo: msgId,
        references: [...original.references, ...(msgId ? [msgId] : [])]
          .filter((r) => /^<[^\s<>]{1,200}>$/.test(r))
          .slice(-20),
      }),
    );
  }

  // ----------------------------------------------------------------- Anhänge

  /** Speichert eine Datei einmal; Kampagnen verweisen nur per ID darauf. */
  async addAttachment(ctx: MailContext, filename: string, bytes: Buffer): Promise<AttachmentMeta> {
    const checked = checkAttachment(filename, bytes, this.#cfg.maxAttachmentBytes);
    const meta: AttachmentMeta = {
      id: randomUUID(),
      tenantId: ctx.tenantId,
      ownerUserId: ctx.userId,
      filename: checked.filename,
      contentType: checked.contentType,
      size: checked.size,
      sha256: checked.sha256,
      createdAt: this.#now(),
    };
    await this.#repos.attachments.insert(meta, checked.bytes);
    return meta;
  }

  // ------------------------------------------------------------ Adresslisten

  async createList(
    ctx: MailContext,
    input: { name: string; manual?: Recipient[]; groupIds?: string[] },
  ): Promise<AddressList> {
    const list: AddressList = {
      id: randomUUID(),
      tenantId: ctx.tenantId,
      ownerUserId: ctx.userId,
      name: headerSafe(input.name, 100),
      manual: this.#cleanRecipients(input.manual ?? []).accepted,
      groupIds: input.groupIds ?? [],
      createdAt: this.#now(),
    };
    await this.#repos.lists.insert(list);
    return list;
  }

  async updateList(
    ctx: MailContext,
    id: string,
    input: { name?: string; manual?: Recipient[]; groupIds?: string[] },
  ): Promise<AddressList> {
    const list = await this.getList(ctx, id);
    const next: AddressList = {
      ...list,
      name: input.name !== undefined ? headerSafe(input.name, 100) : list.name,
      manual: input.manual ? this.#cleanRecipients(input.manual).accepted : list.manual,
      groupIds: input.groupIds ?? list.groupIds,
    };
    await this.#repos.lists.update(next);
    return next;
  }

  async getList(ctx: MailContext, id: string): Promise<AddressList> {
    const list = await this.#repos.lists.get(ctx.tenantId, id);
    if (!list || list.ownerUserId !== ctx.userId) throw new MailError("NOT_FOUND");
    return list;
  }

  listLists = (ctx: MailContext) => this.#repos.lists.list(ctx.tenantId, ctx.userId);

  async deleteList(ctx: MailContext, id: string): Promise<void> {
    await this.getList(ctx, id);
    await this.#repos.lists.delete(ctx.tenantId, id);
  }

  // ------------------------------------------------------------- Versand

  /**
   * Testversand: rendert mit den Werten des ersten Empfängers und sendet ausschliesslich an die
   * eigene Adresse des angemeldeten Nutzers (Ziel ist nicht vom Client steuerbar).
   */
  async testSend(ctx: MailContext, input: PrepareCampaignInput): Promise<{ messageId: string }> {
    const account = await this.#account(ctx, input.accountId);
    this.#validateContent(input.subject, input.bodyHtml);
    const attachments = await this.#loadAttachments(ctx, input.attachmentIds ?? []);
    const { recipients } = await this.#collectRecipients(ctx, { ...input });
    const sample: Recipient = recipients[0] ?? { email: ctx.email };
    const mail = buildOutgoing(
      account,
      {
        subject: input.subject,
        bodyHtml: sanitizeMailHtml(input.bodyHtml, { allowRemoteImages: true }),
      },
      { ...sample, email: assertEmail(ctx.email) },
      attachments.map((a) => ({
        filename: a.meta.filename,
        contentType: a.meta.contentType,
        content: a.bytes,
      })),
      "[TEST] ",
    );
    return this.#withSmtp(account, (c) => c.send(mail));
  }

  prepareCampaign(ctx: MailContext, input: PrepareCampaignInput): Promise<PreparedCampaign> {
    return this.#prepare(ctx, input, "campaign");
  }

  async #prepare(
    ctx: MailContext,
    input: PrepareCampaignInput,
    kind: Campaign["kind"],
  ): Promise<PreparedCampaign> {
    const account = await this.#account(ctx, input.accountId);
    this.#validateContent(input.subject, input.bodyHtml);
    await this.#loadAttachments(ctx, input.attachmentIds ?? []);
    const { recipients, rejected } = await this.#collectRecipients(ctx, input);
    if (recipients.length === 0) throw new MailError("VALIDATION");

    const now = this.#now();
    const needsToken = recipients.length > this.#cfg.autoConfirmUpTo;
    const token = needsToken ? randomBytes(32).toString("base64url") : null;
    const campaignId = randomUUID();
    const scheduledAt = clampSchedule(input.sendAt, now);
    const campaign: Campaign = {
      id: campaignId,
      tenantId: ctx.tenantId,
      ownerUserId: ctx.userId,
      accountId: account.id,
      kind,
      subject: headerSafe(input.subject, 200),
      bodyHtml: sanitizeMailHtml(input.bodyHtml, { allowRemoteImages: true }),
      attachmentIds: input.attachmentIds ?? [],
      scheduledAt,
      state: needsToken ? "awaiting_confirmation" : "confirmed",
      confirmation: token
        ? {
            tokenHash: sha256(token).toString("hex"),
            expiresAt: new Date(now.getTime() + this.#cfg.confirmationTtlMs),
          }
        : undefined,
      recipientCount: recipients.length,
      createdAt: now,
      confirmedAt: needsToken ? undefined : now,
    };
    const status = needsToken ? "held" : "queued";
    await this.#repos.campaigns.create(
      campaign,
      recipients.map((r) => newDelivery(ctx.tenantId, campaignId, r, status, scheduledAt)),
    );

    const used = placeholdersIn(`${input.subject} ${input.bodyHtml}`);
    const missingValues: Record<string, number> = {};
    for (const p of used) {
      const n = recipients.filter((r) => (recipientValues(r)[p] ?? "") === "").length;
      if (n > 0) missingValues[p] = n;
    }
    return {
      campaignId,
      recipientCount: recipients.length,
      rejected,
      missingValues,
      confirmationToken: token,
      confirmed: !needsToken,
    };
  }

  /** Server-seitige Bestätigung: ohne gültiges, unverbrauchtes Token startet kein Massenversand. */
  async confirmCampaign(
    ctx: MailContext,
    campaignId: string,
    token: string,
  ): Promise<CampaignStatus> {
    const campaign = await this.#campaign(ctx, campaignId);
    const c = campaign.confirmation;
    if (campaign.state !== "awaiting_confirmation" || !c) throw new MailError("CONFLICT");
    const given = sha256(token);
    const expected = Buffer.from(c.tokenHash, "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new MailError("FORBIDDEN");
    }
    const now = this.#now();
    if (c.expiresAt < now) throw new MailError("CONFLICT");
    // Atomar: ein zweiter Aufruf mit demselben Token scheitert hier (Token ist einmalig).
    if (!(await this.#repos.campaigns.confirm(ctx.tenantId, campaignId, now))) {
      throw new MailError("CONFLICT");
    }
    return this.getCampaignStatus(ctx, campaignId);
  }

  async cancelCampaign(ctx: MailContext, campaignId: string): Promise<CampaignStatus> {
    await this.#campaign(ctx, campaignId);
    await this.#repos.campaigns.cancel(ctx.tenantId, campaignId);
    return this.getCampaignStatus(ctx, campaignId);
  }

  async getCampaignStatus(ctx: MailContext, campaignId: string): Promise<CampaignStatus> {
    const campaign = publicCampaign(await this.#campaign(ctx, campaignId));
    return { campaign, counts: await this.#repos.campaigns.counts(ctx.tenantId, campaignId) };
  }

  async listCampaigns(ctx: MailContext, limit = 50) {
    const all = await this.#repos.campaigns.list(ctx.tenantId, ctx.userId, limit);
    return all.map(publicCampaign);
  }

  async listDeliveries(ctx: MailContext, campaignId: string, offset: number, limit: number) {
    await this.#campaign(ctx, campaignId);
    const rows = await this.#repos.campaigns.listDeliveries(
      ctx.tenantId,
      campaignId,
      offset,
      limit,
    );
    // Nur Status und Fehlercode; keine Empfängerdaten ausser der Adresse.
    return rows.map((d) => ({
      id: d.id,
      email: d.recipient.email,
      status: d.status,
      attempts: d.attempts,
      lastError: d.lastError ?? null,
      sentAt: d.sentAt ?? null,
      nextAttemptAt: d.nextAttemptAt,
    }));
  }

  /** Einzelne Systemmail (z.B. Verifizierung, Einladung): geht über dieselbe Queue, ohne Bestätigung. */
  async sendTransactional(
    ctx: MailContext,
    mail: TransactionalMail,
  ): Promise<{ campaignId: string }> {
    const accountId =
      mail.accountId ?? (await this.#repos.accounts.listByOwner(ctx.tenantId, ctx.userId))[0]?.id;
    if (!accountId) throw new MailError("NOT_FOUND");
    const prepared = await this.#prepare(
      ctx,
      {
        accountId,
        subject: mail.subject,
        bodyHtml: mail.bodyHtml,
        attachmentIds: mail.attachmentIds,
        manual: [mail.to],
      },
      "transactional",
    );
    if (!prepared.confirmed) throw new MailError("INTERNAL");
    return { campaignId: prepared.campaignId };
  }

  // -------------------------------------------------------------- intern

  async #account(ctx: MailContext, id: string): Promise<MailAccount> {
    const a = await this.#repos.accounts.get(ctx.tenantId, id);
    // Fremde und unbekannte Konten sehen gleich aus (kein Existenz-Orakel).
    if (!a || a.ownerUserId !== ctx.userId) throw new MailError("NOT_FOUND");
    return a;
  }

  async #campaign(ctx: MailContext, id: string): Promise<Campaign> {
    const c = await this.#repos.campaigns.get(ctx.tenantId, id);
    if (!c || c.ownerUserId !== ctx.userId) throw new MailError("NOT_FOUND");
    return c;
  }

  async #withSmtp<T>(account: MailAccount, fn: (c: SmtpConnection) => Promise<T>): Promise<T> {
    const c = await this.#conn.smtp(account, this.#box.decrypt(account.secretEnc, account.id));
    try {
      return await fn(c);
    } finally {
      c.close();
    }
  }

  async #withImap<T>(ctx: MailContext, accountId: string, fn: (c: ImapConnection) => Promise<T>) {
    const account = await this.#account(ctx, accountId);
    if (!account.imap) throw new MailError("VALIDATION");
    const c = await this.#conn.imap(account, this.#box.decrypt(account.secretEnc, account.id));
    try {
      return await fn(c);
    } finally {
      await c.close();
    }
  }

  #assertBody(html: string) {
    if (html.trim() === "" || html.length > this.#cfg.maxBodyChars)
      throw new MailError("VALIDATION");
  }

  #validateContent(subject: string, bodyHtml: string) {
    this.#assertBody(bodyHtml);
    if (headerSafe(subject).length === 0) throw new MailError("VALIDATION");
    assertKnownPlaceholders(subject, BUILTIN_PLACEHOLDERS);
    assertKnownPlaceholders(bodyHtml, BUILTIN_PLACEHOLDERS);
  }

  async #loadAttachments(ctx: MailContext, ids: string[]) {
    if (ids.length > this.#cfg.maxAttachmentsPerMail) throw new MailError("TOO_LARGE");
    const out = [];
    let total = 0;
    for (const id of new Set(ids)) {
      const a = await this.#repos.attachments.get(ctx.tenantId, id);
      if (!a || a.meta.ownerUserId !== ctx.userId) throw new MailError("NOT_FOUND");
      total += a.meta.size;
      out.push(a);
    }
    if (total > this.#cfg.maxAttachmentBytes * 2) throw new MailError("TOO_LARGE");
    return out;
  }

  #cleanRecipients(raw: Recipient[]) {
    const accepted: Recipient[] = [];
    const rejected: PreparedCampaign["rejected"] = [];
    const seen = new Set<string>();
    for (const r of raw) {
      const email = emailSchema.safeParse(r.email);
      if (!email.success) {
        rejected.push({ email: headerSafe(String(r.email), 80), reason: "invalid" });
        continue;
      }
      if (seen.has(email.data)) {
        rejected.push({ email: email.data, reason: "duplicate" });
        continue;
      }
      seen.add(email.data);
      accepted.push({
        email: email.data,
        anrede: clean(r.anrede, 120),
        vorname: clean(r.vorname, 80),
        nachname: clean(r.nachname, 80),
        name: clean(r.name, 160),
        antwortlink: httpsUrl(r.antwortlink),
      });
    }
    return { accepted, rejected };
  }

  async #collectRecipients(ctx: MailContext, input: PrepareCampaignInput) {
    const raw: Recipient[] = [...(input.manual ?? [])];
    const groupIds = new Set(input.groupIds ?? []);
    for (const listId of new Set(input.listIds ?? [])) {
      const list = await this.getList(ctx, listId);
      raw.push(...list.manual);
      for (const g of list.groupIds) groupIds.add(g);
    }
    if (groupIds.size > 0) raw.push(...(await this.#groups.membersOf(ctx, [...groupIds])));
    if (raw.length > this.#cfg.maxRecipients * 2) throw new MailError("TOO_LARGE");
    const { accepted, rejected } = this.#cleanRecipients(raw);
    if (accepted.length > this.#cfg.maxRecipients) throw new MailError("TOO_LARGE");
    return { recipients: accepted, rejected };
  }
}

function newDelivery(
  tenantId: string,
  campaignId: string,
  recipient: Recipient,
  status: Delivery["status"],
  at: Date,
): Delivery {
  return {
    id: randomUUID(),
    tenantId,
    campaignId,
    recipient,
    status,
    attempts: 0,
    nextAttemptAt: at,
  };
}

const clean = (v: string | undefined, max: number) => {
  const s = headerSafe(v ?? "", max);
  return s === "" ? undefined : s;
};

/** Nur https-Links ohne Zugangsdaten; alles andere wird verworfen (kein javascript:, kein http). */
function httpsUrl(v: string | undefined): string | undefined {
  if (!v || v.length > 2000) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password && !/[\s"'<>]/.test(v)
      ? u.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/** Versandplan: nicht in der Vergangenheit, höchstens ein Jahr voraus. */
function clampSchedule(sendAt: Date | undefined, now: Date): Date {
  if (!sendAt || sendAt <= now) return now;
  if (sendAt.getTime() > now.getTime() + 366 * 86_400_000) throw new MailError("VALIDATION");
  return sendAt;
}

function assertFolder(folder: string) {
  if (!FOLDER.test(folder) || folder.includes("..")) throw new MailError("VALIDATION");
}

/** Nie Token-Hash oder Chiffretext nach aussen (SR-74). */
function publicCampaign(c: Campaign): Omit<Campaign, "confirmation"> {
  const out: Partial<Campaign> = { ...c };
  delete out.confirmation;
  return out as Omit<Campaign, "confirmation">;
}

function toPublic(a: MailAccount): PublicAccount {
  const out: Partial<MailAccount> = { ...a };
  delete out.secretEnc;
  return out as PublicAccount;
}

/** Anzeige-Fassung einer empfangenen Mail: bereinigtes HTML ohne Remote-Inhalte. */
function toSafeMessage(m: ReadMessage) {
  return {
    uid: m.uid,
    from: m.from,
    to: m.to,
    subject: m.subject,
    date: m.date,
    html: m.html ? sanitizeMailHtml(m.html) : null,
    text: m.text ?? null,
    attachments: m.attachments,
  };
}
