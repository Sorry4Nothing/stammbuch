import { parseAddress } from "./format";
import {
  MailServiceError,
  type AddressListDetail,
  type AddressListSummary,
  type BulkInput,
  type CampaignStatus,
  type CampaignSummary,
  type Delivery,
  type DraftInput,
  type MailAccount,
  type MailFolder,
  type MailGroup,
  type MailMessage,
  type MailService,
  type MessageSummary,
  type PersonHit,
  type SingleMail,
} from "./mailService";

export interface MemoryMessage extends MailMessage {
  seen: boolean;
  answered: boolean;
}

export interface MemoryCampaign {
  status: CampaignStatus;
  deliveries: Delivery[];
  token?: string;
}

export interface MemoryMailData {
  accounts: MailAccount[];
  messages: Partial<Record<MailFolder, MemoryMessage[]>>;
  lists: AddressListDetail[];
  groups: MailGroup[];
  people: PersonHit[];
  campaigns: MemoryCampaign[];
}

/** Was der Dienst entgegengenommen hat, damit Tests es prüfen können. */
export interface MemoryMailLog {
  sent: SingleMail[];
  replies: { uid: number; body: string }[];
  drafts: DraftInput[];
  tests: BulkInput[];
  prepared: BulkInput[];
}

export interface MemoryMailService extends MailService {
  log: MemoryMailLog;
}

const unavailable = () => new MailServiceError("unavailable", 503);

const emptyCounts = () => ({ held: 0, queued: 0, sending: 0, sent: 0, failed: 0, cancelled: 0 });

/**
 * In-Memory-Dienst für Tests und Entwicklung. Verhält sich wie die API: ein Empfänger braucht keine
 * Bestätigung, mehrere schon (Einmal-Schlüssel), `cancel` löscht den Versand.
 * `fail` lässt lesende Aufrufe mit einem Serverfehler scheitern.
 */
export function memoryMailService(
  data: Partial<MemoryMailData> = {},
  options: { fail?: () => boolean; now?: () => number } = {},
): MemoryMailService {
  const state = structuredClone({
    accounts: [] as MailAccount[],
    messages: {} as Partial<Record<MailFolder, MemoryMessage[]>>,
    lists: [] as AddressListDetail[],
    groups: [] as MailGroup[],
    people: [] as PersonHit[],
    campaigns: [] as MemoryCampaign[],
    ...data,
  });
  const now = options.now ?? Date.now;
  const log: MemoryMailLog = { sent: [], replies: [], drafts: [], tests: [], prepared: [] };
  let seq = 0;
  const gate = () => {
    if (options.fail?.()) throw unavailable();
  };
  const folderOf = (f: MailFolder) => (state.messages[f] ??= []);
  const find = (campaignId: string) => {
    const c = state.campaigns.find((x) => x.status.campaign.id === campaignId);
    if (!c) throw new MailServiceError("notFound", 404);
    return c;
  };
  const listOf = (id: string) => {
    const l = state.lists.find((x) => x.id === id);
    if (!l) throw new MailServiceError("notFound", 404);
    return l;
  };

  /** Zahlen einer Liste aus Personen und Gruppen. */
  const recount = (l: AddressListDetail): AddressListDetail => {
    const groups = state.groups.filter((g) => l.groupIds.includes(g.id));
    const persons = l.entries.length + groups.reduce((n, g) => n + g.persons, 0);
    const withoutEmail =
      l.entries.filter((e) => !e.email).length +
      groups.reduce((n, g) => n + (g.withoutEmail ?? 0), 0);
    return { ...l, persons, withoutEmail, recipients: persons - withoutEmail };
  };

  const summary = (l: AddressListDetail): AddressListSummary => ({
    id: l.id,
    name: l.name,
    kind: l.kind,
    source: l.source,
    persons: l.persons,
    withoutEmail: l.withoutEmail,
    recipients: l.recipients,
    lastUsedAt: l.lastUsedAt,
  });

  return {
    log,

    async accounts() {
      gate();
      return structuredClone(state.accounts);
    },

    async counts() {
      gate();
      const plan = state.campaigns.filter(
        (c) => c.status.campaign.state === "draft" || c.status.campaign.state === "planned",
      ).length;
      return {
        inbox: folderOf("inbox").filter((m) => !m.seen).length,
        drafts: folderOf("drafts").length,
        sent: folderOf("sent").length,
        trash: folderOf("trash").length,
        lists: state.lists.length,
        plan,
        status: state.campaigns.filter((c) => c.status.campaign.state === "sending").length,
      };
    },

    async inbox(_account, folder, page, pageSize) {
      gate();
      const all = [...folderOf(folder)].sort((a, b) =>
        (b.receivedAt ?? "").localeCompare(a.receivedAt ?? ""),
      );
      const messages: MessageSummary[] = all
        .slice((page - 1) * pageSize, page * pageSize)
        .map((m) => ({
          uid: m.uid,
          from: m.from.name ?? m.from.address,
          subject: m.subject,
          receivedAt: m.receivedAt,
          seen: m.seen,
          answered: m.answered,
          attachments: m.attachments.length,
        }));
      return { total: all.length, unread: all.filter((m) => !m.seen).length, messages };
    },

    async read(_account, folder, uid) {
      gate();
      const m = folderOf(folder).find((x) => x.uid === uid);
      if (!m) throw new MailServiceError("notFound", 404);
      m.seen = true;
      return structuredClone({
        uid: m.uid,
        from: m.from,
        to: m.to,
        subject: m.subject,
        receivedAt: m.receivedAt,
        sizeBytes: m.sizeBytes,
        text: m.text,
        attachments: m.attachments,
      });
    },

    async markRead(_account, folder, uids) {
      for (const m of folderOf(folder)) if (uids.includes(m.uid)) m.seen = true;
    },

    async deleteMessages(_account, folder, uids) {
      const moved = folderOf(folder).filter((m) => uids.includes(m.uid));
      state.messages[folder] = folderOf(folder).filter((m) => !uids.includes(m.uid));
      if (folder !== "trash") folderOf("trash").push(...moved);
    },

    async reply(_account, folder, uid, body) {
      const m = folderOf(folder).find((x) => x.uid === uid);
      if (!m) throw new MailServiceError("notFound", 404);
      if (body.trim() === "") throw new MailServiceError("validation", 400);
      m.answered = true;
      log.replies.push({ uid, body });
    },

    async send(mail) {
      if (!parseAddress(mail.to) || mail.subject.trim() === "" || mail.body.trim() === "") {
        throw new MailServiceError("validation", 400);
      }
      log.sent.push(mail);
    },

    async saveDraft(draft) {
      log.drafts.push(draft);
    },

    async uploadAttachment(file) {
      return { id: `att-${++seq}`, filename: file.name, size: file.size };
    },

    async lists() {
      gate();
      return state.lists.map((l) => summary(recount(l)));
    },

    async list(id) {
      gate();
      return structuredClone(recount(listOf(id)));
    },

    async saveList(input) {
      const groups = state.groups.filter((g) => input.groupIds.includes(g.id));
      const kind =
        input.entries.length > 0 || groups.length === 0
          ? "manual"
          : groups.length === 1
            ? "group"
            : "groups";
      const source =
        kind === "manual"
          ? "Manuell gepflegt"
          : kind === "group"
            ? groups[0]!.name
            : `${groups[0]!.name} und ${groups.length - 1} weitere`;
      const existing = input.id ? listOf(input.id) : undefined;
      const next: AddressListDetail = recount({
        id: input.id ?? `list-${++seq}`,
        name: input.name,
        kind,
        source,
        persons: 0,
        withoutEmail: 0,
        recipients: 0,
        lastUsedAt: existing?.lastUsedAt ?? null,
        description: input.description,
        entries: structuredClone(input.entries),
        groupIds: input.groupIds,
      });
      if (existing) state.lists[state.lists.indexOf(existing)] = next;
      else state.lists.push(next);
      return structuredClone(next);
    },

    async groups() {
      gate();
      return structuredClone(state.groups);
    },

    async searchPeople(query) {
      const needle = query.trim().toLowerCase();
      if (!needle) return [];
      return state.people.filter((p) => p.name.toLowerCase().includes(needle)).slice(0, 8);
    },

    async previewRecipient(listId) {
      return structuredClone(listOf(listId).entries.find((e) => e.email) ?? null);
    },

    async testSend(input) {
      log.tests.push(input);
      return { sentAt: new Date(now()).toISOString() };
    },

    async prepare(input) {
      const list = recount(listOf(input.listId));
      const count = list.recipients ?? 0;
      if (count === 0 || input.subject.trim() === "" || input.body.trim() === "") {
        throw new MailServiceError("validation", 400);
      }
      log.prepared.push(input);
      const id = `camp-${++seq}`;
      const confirmed = count <= 1;
      const sendAt = input.sendAt ?? new Date(now()).toISOString();
      const campaign: CampaignSummary = {
        id,
        subject: input.subject,
        listName: list.name,
        recipientCount: count,
        scheduledAt: sendAt,
        state: confirmed ? "planned" : "draft",
        attachmentCount: input.attachmentIds.length,
        confirmedAt: confirmed ? new Date(now()).toISOString() : null,
        confirmedBy: null,
      };
      const counts = { ...emptyCounts(), [confirmed ? "queued" : "held"]: count };
      state.campaigns.push({
        status: { campaign, counts },
        deliveries: [],
        ...(confirmed ? {} : { token: `token-${id}` }),
      });
      return {
        campaignId: id,
        recipientCount: count,
        missingValues: {},
        confirmed,
        confirmationToken: confirmed ? null : `token-${id}`,
      };
    },

    async confirm(campaignId, token) {
      const c = find(campaignId);
      if (c.token === undefined || c.token !== token) throw new MailServiceError("forbidden", 403);
      delete c.token;
      const { campaign } = c.status;
      const future = new Date(campaign.scheduledAt).getTime() > now();
      campaign.state = future ? "planned" : "sending";
      campaign.confirmedAt = new Date(now()).toISOString();
      c.status.counts = { ...emptyCounts(), queued: campaign.recipientCount };
      return structuredClone(c.status);
    },

    async cancel(campaignId) {
      const c = find(campaignId);
      c.status.campaign.state = "cancelled";
      c.status.counts = { ...emptyCounts(), cancelled: c.status.campaign.recipientCount };
    },

    async campaigns() {
      gate();
      return state.campaigns.map((c) => structuredClone(c.status.campaign));
    },

    async campaignStatus(campaignId) {
      gate();
      return structuredClone(find(campaignId).status);
    },

    async deliveries(campaignId, offset, limit) {
      gate();
      return structuredClone(find(campaignId).deliveries.slice(offset, offset + limit));
    },

    async reschedule(campaignId, sendAt) {
      find(campaignId).status.campaign.scheduledAt = sendAt;
    },

    async sendNow(campaignId) {
      const { campaign } = find(campaignId).status;
      campaign.scheduledAt = new Date(now()).toISOString();
      campaign.state = "sending";
    },

    async pause() {
      throw new MailServiceError("unsupported");
    },
  };
}
