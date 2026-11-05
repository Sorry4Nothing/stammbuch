import type {
  AddressList,
  AttachmentMeta,
  Campaign,
  Delivery,
  DeliveryCounts,
  DeliveryStatus,
  MailAccount,
} from "./types.js";

/**
 * Persistenz-Schnittstellen. Jede Methode ist mandantengebunden (`tenantId`), ausser den
 * ausdrücklich internen Worker-Methoden. Die SQL-Umsetzung (#3) muss `claim` atomar
 * ausführen (`UPDATE ... WHERE status = 'queued' ... RETURNING`).
 */
export interface AccountRepository {
  insert(account: MailAccount): Promise<void>;
  get(tenantId: string, id: string): Promise<MailAccount | null>;
  listByOwner(tenantId: string, ownerUserId: string): Promise<MailAccount[]>;
  update(account: MailAccount): Promise<void>;
  delete(tenantId: string, id: string): Promise<boolean>;
  /** Für den Rotationslauf (intern). */
  listAll(): Promise<MailAccount[]>;
}

export interface AttachmentRepository {
  insert(meta: AttachmentMeta, bytes: Buffer): Promise<void>;
  get(tenantId: string, id: string): Promise<{ meta: AttachmentMeta; bytes: Buffer } | null>;
}

export interface AddressListRepository {
  insert(list: AddressList): Promise<void>;
  get(tenantId: string, id: string): Promise<AddressList | null>;
  list(tenantId: string, ownerUserId: string): Promise<AddressList[]>;
  update(list: AddressList): Promise<void>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

export interface DeliveryResult {
  status: Extract<DeliveryStatus, "sent" | "queued" | "failed">;
  sentAt?: Date;
  messageId?: string;
  lastError?: Delivery["lastError"];
  nextAttemptAt?: Date;
}

export interface CampaignRepository {
  create(campaign: Campaign, deliveries: Delivery[]): Promise<void>;
  get(tenantId: string, id: string): Promise<Campaign | null>;
  list(tenantId: string, ownerUserId: string, limit: number): Promise<Campaign[]>;
  /** Atomar: awaiting_confirmation -> confirmed, held -> queued. False, wenn der Zustand nicht passt. */
  confirm(tenantId: string, id: string, now: Date): Promise<boolean>;
  /** Atomar: Kampagne abbrechen, held/queued -> cancelled. False, wenn schon abgebrochen. */
  cancel(tenantId: string, id: string): Promise<boolean>;
  counts(tenantId: string, id: string): Promise<DeliveryCounts>;
  listDeliveries(tenantId: string, id: string, offset: number, limit: number): Promise<Delivery[]>;

  // Intern für den Worker.
  getById(id: string): Promise<Campaign | null>;
  listDue(now: Date, limit: number): Promise<Delivery[]>;
  /** Atomar: queued (fällig) oder sending mit abgelaufener Sperre -> sending, attempts + 1. */
  claim(id: string, now: Date, leaseUntil: Date): Promise<Delivery | null>;
  finish(id: string, result: DeliveryResult): Promise<void>;
  countSentSince(tenantId: string, since: Date): Promise<number>;
}

export interface MailRepositories {
  accounts: AccountRepository;
  attachments: AttachmentRepository;
  lists: AddressListRepository;
  campaigns: CampaignRepository;
}
