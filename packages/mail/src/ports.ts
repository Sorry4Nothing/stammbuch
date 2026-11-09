import type {
  Campaign,
  DeliveryCounts,
  Endpoint,
  FolderCount,
  GroupInfo,
  InboxPage,
  MailAccount,
  MailContext,
  OutgoingMail,
  PersonRef,
  ReadMessage,
  Recipient,
} from "./types.js";

/** Quelle für Gruppen und Personen (Personenmodul, #3). Muss Mandant und Berechtigung selbst durchsetzen. */
export interface GroupLookup {
  membersOf(ctx: MailContext, groupIds: string[]): Promise<Recipient[]>;
  /** Gruppen des Mandanten mit der Zahl aktiver Personen und derer ohne E-Mail-Adresse. */
  groups(ctx: MailContext): Promise<GroupInfo[]>;
  /** Löst Personen-IDs auf; unbekannte oder fremde IDs fehlen in der Antwort. */
  people(ctx: MailContext, ids: string[]): Promise<PersonRef[]>;
}

export interface SmtpConnection {
  send(mail: OutgoingMail): Promise<{ messageId: string }>;
  verify(): Promise<void>;
  close(): void;
}

export interface ImapConnection {
  list(folder: string, page: number, pageSize: number): Promise<InboxPage>;
  read(folder: string, uid: number): Promise<ReadMessage | null>;
  /** Zähler der genannten Ordner; fehlende Ordner werden ausgelassen. */
  counts(folders: string[]): Promise<FolderCount[]>;
  /** Setzt das Flag «gelesen». */
  markSeen(folder: string, uids: number[]): Promise<void>;
  /** Verschiebt in den Papierkorb; im Papierkorb selbst löscht es endgültig. Ohne Papierkorb: `NOT_FOUND`. */
  remove(folder: string, uids: number[]): Promise<void>;
  /**
   * Legt die Mail als Entwurf im Entwurfsordner des Servers ab. Mit `replaces` (Message-ID eines früheren Entwurfs) wird
   * erst der neue Entwurf angelegt und danach der alte endgültig gelöscht: schlägt das Löschen fehl, bleibt höchstens
   * eine Kopie zu viel, nie ein verlorener Entwurf.
   */
  saveDraft(mail: OutgoingMail, replaces?: string): Promise<void>;
  close(): Promise<void>;
}

/** Baut geprüfte Verbindungen (SSRF-Schutz, TLS-Pflicht). Austauschbar für Tests. */
export interface ConnectionFactory {
  smtp(account: MailAccount, password: string): Promise<SmtpConnection>;
  imap(account: MailAccount, password: string): Promise<ImapConnection>;
  /** Prüft nur die Endpunkt-Angabe (Host, Port), ohne zu verbinden. */
  checkEndpoint(kind: "smtp" | "imap", endpoint: Endpoint): Promise<void>;
}

export interface TransactionalMail {
  /** Standard: erstes Konto des Nutzers. */
  accountId?: string | undefined;
  to: Recipient;
  subject: string;
  /** HTML mit Platzhaltern; wird beim Versand sanitisiert. */
  bodyHtml: string;
  attachmentIds?: string[] | undefined;
}

export interface PrepareCampaignInput {
  accountId: string;
  subject: string;
  bodyHtml: string;
  attachmentIds?: string[] | undefined;
  /** Empfänger aus Adresslisten, Gruppen und von Hand; wird dedupliziert. */
  listIds?: string[] | undefined;
  groupIds?: string[] | undefined;
  manual?: Recipient[] | undefined;
  /** Versandplan; leer = sofort nach Bestätigung. */
  sendAt?: Date | undefined;
}

export interface PreparedCampaign {
  campaignId: string;
  recipientCount: number;
  /** Ungültige oder doppelte Adressen, die nicht aufgenommen wurden. */
  rejected: { email: string; reason: "invalid" | "duplicate" }[];
  /** Platzhalter, die in der Vorlage vorkommen, aber für N Empfänger keinen Wert haben. */
  missingValues: Record<string, number>;
  /** Einmal sichtbar. Ohne dieses Token startet der Versand nicht. Null bei Einzelempfänger (bereits freigegeben). */
  confirmationToken: string | null;
  confirmed: boolean;
}

export interface CampaignStatus {
  campaign: Omit<Campaign, "confirmation">;
  counts: DeliveryCounts;
}

/**
 * Schnittstelle für andere Module (Auth #4: Verifizierungs-/Reset-Mails, Kalender #11: Einladungen).
 * Alle Aufrufe sind mandantengebunden über `ctx`. Versand läuft asynchron über die Queue im Worker.
 */
export interface MailPort {
  sendTransactional(ctx: MailContext, mail: TransactionalMail): Promise<{ campaignId: string }>;
  prepareCampaign(ctx: MailContext, input: PrepareCampaignInput): Promise<PreparedCampaign>;
  confirmCampaign(ctx: MailContext, campaignId: string, token: string): Promise<CampaignStatus>;
  cancelCampaign(ctx: MailContext, campaignId: string): Promise<CampaignStatus>;
  getCampaignStatus(ctx: MailContext, campaignId: string): Promise<CampaignStatus>;
}
