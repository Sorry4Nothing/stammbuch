import type { MailErrorCode } from "./net-guard.js";

/** Wer handelt: kommt aus der Authentifizierung (#4), nie aus dem Request-Body. */
export interface MailContext {
  tenantId: string;
  userId: string;
  /** Eigene Adresse des Nutzers; einziges Ziel des Testversands. */
  email: string;
}

export type Security = "tls" | "starttls";
export interface Endpoint {
  host: string;
  port: number;
  security: Security;
}

export interface MailAccount {
  id: string;
  tenantId: string;
  ownerUserId: string;
  label: string;
  fromAddress: string;
  fromName?: string | undefined;
  username: string;
  /** AES-256-GCM-Chiffretext des (App-)Passworts. Verlässt nie die Persistenzschicht und die Services. */
  secretEnc: string;
  smtp: Endpoint;
  imap?: Endpoint | undefined;
  createdAt: Date;
}

export type PublicAccount = Omit<MailAccount, "secretEnc">;

export interface Recipient {
  email: string;
  anrede?: string | undefined;
  vorname?: string | undefined;
  nachname?: string | undefined;
  name?: string | undefined;
  /** Persönlicher Antwortlink (https), vom Aufrufer erzeugt, z.B. für Einladungen (#11). */
  antwortlink?: string | undefined;
}

export interface AttachmentMeta {
  id: string;
  tenantId: string;
  ownerUserId: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  createdAt: Date;
}

export interface AddressList {
  id: string;
  tenantId: string;
  ownerUserId: string;
  name: string;
  manual: Recipient[];
  groupIds: string[];
  createdAt: Date;
}

export type CampaignState = "awaiting_confirmation" | "confirmed" | "cancelled";
export type CampaignKind = "campaign" | "transactional";

export interface Campaign {
  id: string;
  tenantId: string;
  ownerUserId: string;
  accountId: string;
  kind: CampaignKind;
  subject: string;
  bodyHtml: string;
  attachmentIds: string[];
  scheduledAt: Date;
  state: CampaignState;
  /** Einmal-Token für die Bestätigung: nur der Hash wird gespeichert. */
  confirmation?: { tokenHash: string; expiresAt: Date } | undefined;
  recipientCount: number;
  createdAt: Date;
  confirmedAt?: Date | undefined;
}

export type DeliveryStatus = "held" | "queued" | "sending" | "sent" | "failed" | "cancelled";

export interface Delivery {
  id: string;
  tenantId: string;
  campaignId: string;
  recipient: Recipient;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: Date;
  leaseUntil?: Date | undefined;
  /** Nur ein fester Code, nie der Rohtext des Servers (SR-50, SR-51). */
  lastError?: MailErrorCode | undefined;
  sentAt?: Date | undefined;
  messageId?: string | undefined;
}

export type DeliveryCounts = Record<DeliveryStatus, number>;

export interface OutgoingMail {
  from: { name?: string | undefined; address: string };
  to: { name?: string | undefined; address: string }[];
  subject: string;
  html: string;
  text: string;
  inReplyTo?: string | undefined;
  references?: string[] | undefined;
  attachments?: { filename: string; contentType: string; content: Buffer }[] | undefined;
}

export interface MessageSummary {
  uid: number;
  from: string;
  subject: string;
  date: string | null;
  seen: boolean;
}

export interface InboxPage {
  total: number;
  messages: MessageSummary[];
}

export interface ReadMessage {
  uid: number;
  from: { name?: string | undefined; address: string };
  to: { name?: string | undefined; address: string }[];
  subject: string;
  date: string | null;
  messageId?: string | undefined;
  references: string[];
  /** Roh vom Server; der Service sanitisiert, bevor etwas nach aussen geht. */
  html?: string | undefined;
  text?: string | undefined;
  attachments: { filename: string; contentType: string; size: number }[];
}
