/** Ordner der Seitenleiste. Der Name des IMAP-Ordners ist Sache des Dienstes. */
export type MailFolder = "inbox" | "drafts" | "sent" | "trash";

export const MAIL_FOLDERS: readonly MailFolder[] = ["inbox", "drafts", "sent", "trash"];

export interface MailAccount {
  id: string;
  label: string;
  fromAddress: string;
  fromName: string | null;
}

/** Zähler der Seitenleiste. Fehlt ein Zähler, kennt der Dienst ihn nicht: dann bleibt er weg. */
export interface MailCounts {
  /** Ungelesene Mails im Posteingang. */
  inbox?: number;
  drafts?: number;
  sent?: number;
  trash?: number;
  lists?: number;
  plan?: number;
  status?: number;
}

export interface MessageSummary {
  uid: number;
  from: string;
  subject: string;
  /** ISO-Zeitpunkt oder `null`, wenn der Server keinen liefert. */
  receivedAt: string | null;
  seen: boolean;
  answered: boolean;
  attachments: number;
}

export interface InboxPage {
  /** Alle Mails im Ordner. */
  total: number;
  /** Ungelesene Mails im Ordner, `null`, wenn unbekannt. */
  unread: number | null;
  messages: MessageSummary[];
}

export interface Address {
  name: string | null;
  address: string;
}

export interface MailAttachmentInfo {
  filename: string;
  contentType: string;
  size: number;
}

export interface MailMessage {
  uid: number;
  from: Address;
  to: Address[];
  subject: string;
  receivedAt: string | null;
  /** Grösse in Byte, `null`, wenn unbekannt. */
  sizeBytes: number | null;
  /** Klartext der Mail. HTML wird nie als Markup angezeigt, sondern vorher in Text gewandelt. */
  text: string;
  attachments: MailAttachmentInfo[];
}

export interface AttachmentRef {
  id: string;
  filename: string;
  size: number;
}

export interface SingleMail {
  accountId: string;
  /** Eine Adresse, mit oder ohne Namen: `Anna Beispiel <anna@example.ch>`. */
  to: string;
  subject: string;
  /** Klartext; der Dienst macht daraus den Mailinhalt. */
  body: string;
  attachmentIds: string[];
}

export interface DraftInput {
  accountId: string;
  to: string;
  subject: string;
  body: string;
  attachmentIds: string[];
}

export type ListKind = "manual" | "group" | "groups";

/** Eine Zeile der Adressliste (Design 7.8). Zahlen sind `null`, wenn der Dienst sie nicht kennt. */
export interface AddressListSummary {
  id: string;
  name: string;
  kind: ListKind;
  /** «Vorstand und 3 weitere» oder «Manuell gepflegt». */
  source: string;
  persons: number | null;
  withoutEmail: number | null;
  recipients: number | null;
  /** ISO-Datum der letzten Verwendung, `null`, wenn unbekannt. */
  lastUsedAt: string | null;
}

export interface ListEntry {
  /** Stabiler Schlüssel in der Oberfläche. */
  key: string;
  name: string;
  email: string | null;
  group: string | null;
  /** Anrede, Vor- und Nachname für Platzhalter. */
  anrede?: string;
  vorname?: string;
  nachname?: string;
}

export interface AddressListDetail extends AddressListSummary {
  description: string;
  entries: ListEntry[];
  groupIds: string[];
}

export interface SaveListInput {
  id?: string;
  name: string;
  description: string;
  entries: ListEntry[];
  groupIds: string[];
}

export interface MailGroup {
  id: string;
  name: string;
  persons: number;
  /** `null`, wenn der Dienst die Adressen der Gruppe nicht zählt. */
  withoutEmail: number | null;
}

export interface PersonHit {
  key: string;
  name: string;
  email: string | null;
  group: string | null;
  anrede?: string;
  vorname?: string;
  nachname?: string;
}

export interface BulkInput {
  accountId: string;
  listId: string;
  subject: string;
  /** Klartext mit `{{anrede}}`, `{{name}}` und `{{antwortlink}}`. */
  body: string;
  attachmentIds: string[];
  /** ISO-Zeitpunkt oder `null` = sofort nach der Bestätigung. */
  sendAt: string | null;
}

export interface PreparedBulk {
  campaignId: string;
  recipientCount: number;
  /** Platzhalter und Zahl der Empfänger ohne Wert dafür. */
  missingValues: Record<string, number>;
  /** `true` bei nur einem Empfänger: der Versand läuft ohne Bestätigung. */
  confirmed: boolean;
  /** Einmal-Schlüssel für `confirm`. */
  confirmationToken: string | null;
}

export type CampaignState = "draft" | "planned" | "sending" | "sent" | "cancelled";

export interface CampaignSummary {
  id: string;
  subject: string;
  /** Name der Adressliste, `null`, wenn der Dienst ihn nicht kennt. */
  listName: string | null;
  recipientCount: number;
  scheduledAt: string;
  state: CampaignState;
  attachmentCount: number;
  confirmedAt: string | null;
  confirmedBy: string | null;
}

export type DeliveryStatus = "held" | "queued" | "sending" | "sent" | "failed" | "cancelled";

export type DeliveryCounts = Record<DeliveryStatus, number>;

export interface CampaignStatus {
  campaign: CampaignSummary;
  counts: DeliveryCounts;
}

export interface Delivery {
  id: string;
  /** Name des Empfängers, `null`, wenn der Dienst ihn nicht liefert. */
  name: string | null;
  email: string;
  status: DeliveryStatus;
  at: string | null;
  /** Fester Fehlercode des Mailservers, nie dessen Rohtext. */
  reason: string | null;
}

export type MailErrorKind =
  | "unsupported"
  | "validation"
  | "forbidden"
  | "notFound"
  | "conflict"
  | "tooLarge"
  | "mailServer"
  | "unavailable";

/** Fehler des Mail-Dienstes. Nur die Art, nie der Text der Antwort (SR-51). */
export class MailServiceError extends Error {
  constructor(
    readonly kind: MailErrorKind,
    readonly status?: number,
  ) {
    super(`Mail-Dienst: ${kind}${status ? ` (${status})` : ""}`);
  }
}

/**
 * Datenquelle des Mail-Moduls. `createHttpMailService` spricht die Routen unter `/mail` an (Modul
 * `apps/api/src/modules/mail`) und die Gruppen des Personenmoduls. Funktionen ohne Route (Entwürfe,
 * Löschen, Gelesen-Markierung, Pausieren, Zeitpunkt ändern) wirft er als `MailServiceError("unsupported")`.
 */
export interface MailService {
  accounts(signal?: AbortSignal): Promise<MailAccount[]>;
  counts(signal?: AbortSignal): Promise<MailCounts>;
  inbox(
    accountId: string,
    folder: MailFolder,
    page: number,
    pageSize: number,
    signal?: AbortSignal,
  ): Promise<InboxPage>;
  read(
    accountId: string,
    folder: MailFolder,
    uid: number,
    signal?: AbortSignal,
  ): Promise<MailMessage>;
  markRead(accountId: string, folder: MailFolder, uids: number[]): Promise<void>;
  deleteMessages(accountId: string, folder: MailFolder, uids: number[]): Promise<void>;
  reply(
    accountId: string,
    folder: MailFolder,
    uid: number,
    body: string,
    attachmentIds: string[],
  ): Promise<void>;
  send(mail: SingleMail): Promise<void>;
  saveDraft(draft: DraftInput): Promise<void>;
  uploadAttachment(file: File): Promise<AttachmentRef>;

  lists(signal?: AbortSignal): Promise<AddressListSummary[]>;
  list(id: string, signal?: AbortSignal): Promise<AddressListDetail>;
  saveList(input: SaveListInput): Promise<AddressListDetail>;
  groups(signal?: AbortSignal): Promise<MailGroup[]>;
  searchPeople(query: string, signal?: AbortSignal): Promise<PersonHit[]>;

  /** Beispielwerte für die Vorschau (Design 7.5): erster Empfänger der Liste, `null`, wenn unbekannt. */
  previewRecipient(listId: string, signal?: AbortSignal): Promise<ListEntry | null>;
  testSend(input: BulkInput): Promise<{ sentAt: string }>;
  prepare(input: BulkInput): Promise<PreparedBulk>;
  confirm(campaignId: string, token: string): Promise<CampaignStatus>;
  cancel(campaignId: string): Promise<void>;
  campaigns(signal?: AbortSignal): Promise<CampaignSummary[]>;
  campaignStatus(campaignId: string, signal?: AbortSignal): Promise<CampaignStatus>;
  deliveries(
    campaignId: string,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Delivery[]>;
  reschedule(campaignId: string, sendAt: string): Promise<void>;
  sendNow(campaignId: string): Promise<void>;
  pause(campaignId: string): Promise<void>;
}
