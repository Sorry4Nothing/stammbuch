import type {
  AccountRepository,
  AddressListRepository,
  AttachmentRepository,
  CampaignRepository,
  DeliveryResult,
  MailRepositories,
} from "./repositories.js";
import type {
  AddressList,
  AttachmentMeta,
  Campaign,
  Delivery,
  DeliveryCounts,
  MailAccount,
} from "./types.js";

const copy = <T>(v: T): T => structuredClone(v);

/** Mandantengebundene Map: Zugriff auf fremde Mandanten liefert nichts. */
class TenantMap<T extends { id: string; tenantId: string }> {
  readonly rows = new Map<string, T>();
  put(row: T) {
    this.rows.set(row.id, copy(row));
  }
  get(tenantId: string, id: string): T | null {
    const row = this.rows.get(id);
    return row && row.tenantId === tenantId ? copy(row) : null;
  }
  all(): T[] {
    return [...this.rows.values()].map(copy);
  }
}

class MemoryAccounts implements AccountRepository {
  readonly #m = new TenantMap<MailAccount>();
  insert = async (a: MailAccount) => this.#m.put(a);
  update = async (a: MailAccount) => this.#m.put(a);
  get = async (t: string, id: string) => this.#m.get(t, id);
  listByOwner = async (t: string, owner: string) =>
    this.#m
      .all()
      .filter((a) => a.tenantId === t && a.ownerUserId === owner)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  listForRotation = async (keyId: string, after: string | null, limit: number) =>
    this.#m
      .all()
      .filter((a) => a.secretEnc.split(".")[1] !== keyId && (after === null || a.id > after))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  replaceSecret = async (t: string, id: string, expected: string, enc: string) => {
    const a = this.#m.get(t, id);
    if (a?.secretEnc !== expected) return false;
    this.#m.put({ ...a, secretEnc: enc });
    return true;
  };
  delete = async (t: string, id: string) => this.#m.get(t, id) !== null && this.#m.rows.delete(id);
}

class MemoryAttachments implements AttachmentRepository {
  readonly #m = new TenantMap<AttachmentMeta>();
  readonly #bytes = new Map<string, Buffer>();
  insert = async (meta: AttachmentMeta, bytes: Buffer) => {
    this.#m.put(meta);
    this.#bytes.set(meta.id, Buffer.from(bytes));
  };
  get = async (t: string, id: string) => {
    const meta = this.#m.get(t, id);
    const bytes = this.#bytes.get(id);
    return meta && bytes ? { meta, bytes: Buffer.from(bytes) } : null;
  };
}

class MemoryLists implements AddressListRepository {
  readonly #m = new TenantMap<AddressList>();
  insert = async (l: AddressList) => this.#m.put(l);
  update = async (l: AddressList) => this.#m.put(l);
  get = async (t: string, id: string) => this.#m.get(t, id);
  list = async (t: string, owner: string) =>
    this.#m.all().filter((l) => l.tenantId === t && l.ownerUserId === owner);
  delete = async (t: string, id: string) => this.#m.get(t, id) !== null && this.#m.rows.delete(id);
  markUsed = async (t: string, ids: string[], at: Date) => {
    for (const id of ids) {
      const l = this.#m.get(t, id);
      if (l) this.#m.put({ ...l, lastUsedAt: at });
    }
  };
}

class MemoryCampaigns implements CampaignRepository {
  readonly #campaigns = new TenantMap<Campaign>();
  readonly #deliveries = new Map<string, Delivery>();

  async create(c: Campaign, deliveries: Delivery[]) {
    this.#campaigns.put(c);
    for (const d of deliveries) this.#deliveries.set(d.id, copy(d));
  }
  get = async (t: string, id: string) => this.#campaigns.get(t, id);
  getById = async (id: string) => {
    const c = this.#campaigns.rows.get(id);
    return c ? copy(c) : null;
  };
  list = async (t: string, owner: string, limit: number) =>
    this.#campaigns
      .all()
      .filter((c) => c.tenantId === t && c.ownerUserId === owner)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);

  #of(id: string) {
    return [...this.#deliveries.values()].filter((d) => d.campaignId === id);
  }

  async confirm(t: string, id: string, now: Date, confirmedBy?: string) {
    const c = this.#campaigns.rows.get(id);
    if (!c || c.tenantId !== t || c.state !== "awaiting_confirmation") return false;
    c.state = "confirmed";
    c.confirmedAt = now;
    c.confirmedBy = confirmedBy;
    c.confirmation = undefined;
    for (const d of this.#of(id)) if (d.status === "held") d.status = "queued";
    return true;
  }

  async pause(t: string, id: string) {
    const c = this.#campaigns.rows.get(id);
    if (!c || c.tenantId !== t || c.state !== "confirmed") return false;
    c.state = "paused";
    for (const d of this.#of(id)) if (d.status === "queued") d.status = "held";
    return true;
  }

  async reschedule(t: string, id: string, at: Date) {
    const c = this.#campaigns.rows.get(id);
    if (!c || c.tenantId !== t || c.state === "cancelled") return false;
    const resume = c.state === "paused";
    if (resume) c.state = "confirmed";
    c.scheduledAt = at;
    for (const d of this.#of(id)) {
      if (d.status !== "held" && d.status !== "queued") continue;
      d.nextAttemptAt = at;
      if (resume) d.status = "queued";
    }
    return true;
  }

  async cancel(t: string, id: string) {
    const c = this.#campaigns.rows.get(id);
    if (!c || c.tenantId !== t || c.state === "cancelled") return false;
    c.state = "cancelled";
    c.confirmation = undefined;
    for (const d of this.#of(id)) {
      if (d.status === "held" || d.status === "queued") d.status = "cancelled";
    }
    return true;
  }

  async counts(t: string, id: string) {
    const counts: DeliveryCounts = {
      held: 0,
      queued: 0,
      sending: 0,
      sent: 0,
      failed: 0,
      cancelled: 0,
    };
    if (!this.#campaigns.get(t, id)) return counts;
    for (const d of this.#of(id)) counts[d.status]++;
    return counts;
  }

  async countsFor(t: string, ids: string[]) {
    return new Map(
      await Promise.all(ids.map(async (id) => [id, await this.counts(t, id)] as const)),
    );
  }

  async listDeliveries(t: string, id: string, offset: number, limit: number) {
    if (!this.#campaigns.get(t, id)) return [];
    return this.#of(id)
      .slice(offset, offset + limit)
      .map(copy);
  }

  async listDue(now: Date, limit: number) {
    return [...this.#deliveries.values()]
      .filter((d) => isDue(d, now))
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, limit)
      .map(copy);
  }

  async claim(id: string, now: Date, leaseUntil: Date) {
    const d = this.#deliveries.get(id);
    if (!d || !isDue(d, now)) return null;
    d.status = "sending";
    d.attempts++;
    d.leaseUntil = leaseUntil;
    return copy(d);
  }

  async finish(id: string, r: DeliveryResult) {
    const d = this.#deliveries.get(id);
    if (!d) return;
    d.status = r.status;
    d.leaseUntil = undefined;
    d.lastError = r.lastError;
    if (r.sentAt) d.sentAt = r.sentAt;
    if (r.messageId) d.messageId = r.messageId;
    if (r.nextAttemptAt) d.nextAttemptAt = r.nextAttemptAt;
  }

  async countSentSince(t: string, since: Date) {
    return [...this.#deliveries.values()].filter(
      (d) => d.tenantId === t && d.status === "sent" && d.sentAt !== undefined && d.sentAt >= since,
    ).length;
  }
}

function isDue(d: Delivery, now: Date): boolean {
  return (
    (d.status === "queued" && d.nextAttemptAt <= now) ||
    (d.status === "sending" && d.leaseUntil !== undefined && d.leaseUntil < now)
  );
}

export function createMemoryRepositories(): MailRepositories {
  return {
    accounts: new MemoryAccounts(),
    attachments: new MemoryAttachments(),
    lists: new MemoryLists(),
    campaigns: new MemoryCampaigns(),
  };
}
