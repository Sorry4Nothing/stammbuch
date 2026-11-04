import type { FastifyRequest } from "fastify";
import type { CalendarEvent, EventResponse, Invitation } from "./domain.js";

export interface MailMessage {
  to: { email: string; name: string };
  subject: string;
  text: string;
}

/** Anbindung an das Mail-Modul (Phase 4). Wirft, wenn der Versand fehlschlägt. */
export interface MailPort {
  send(message: MailMessage): Promise<void>;
}

/**
 * Persistenz des Kalenders. Alle Abfragen aus dem Request-Pfad tragen die `tenantId`
 * (Mandantentrennung, SR-11). Die DB-Implementierung (#3) muss parametrisierte Queries
 * und für `deleteEventData` eine Transaktion verwenden.
 */
export interface CalendarRepository {
  insertEvent(event: CalendarEvent): Promise<void>;
  updateEvent(event: CalendarEvent): Promise<void>;
  getEvent(tenantId: string, id: string): Promise<CalendarEvent | null>;
  /** Events, die im Zeitraum [from, to) beginnen, aufsteigend nach Beginn. */
  listEvents(
    tenantId: string,
    range: { from: Date; to: Date; limit: number },
  ): Promise<CalendarEvent[]>;

  insertInvitation(invitation: Invitation): Promise<void>;
  deleteInvitation(id: string): Promise<void>;
  getInvitationByTokenHash(tokenHash: string): Promise<Invitation | null>;
  listInvitations(tenantId: string, eventId: string): Promise<Invitation[]>;

  /** Eine Rückmeldung pro Einladung: eine neue ersetzt die alte. */
  upsertResponse(response: EventResponse): Promise<void>;
  listResponses(tenantId: string, eventId: string): Promise<EventResponse[]>;

  /** Mandantenübergreifend, nur für den Lösch-Job. IDs der Events mit `endsAt <= cutoff`. */
  findEventIdsEndedBefore(cutoff: Date): Promise<string[]>;
  /**
   * Löscht Kalendereintrag, Einladungen und Zu-/Absagen eines Events und sonst nichts.
   * Rechnungen und Buchhaltung gehören nie dazu.
   */
  deleteEventData(eventId: string): Promise<void>;
}

/** Wer die Anfrage stellt. Kommt aus der Auth-Schicht (SR-10), nie aus dem Request-Body. */
export interface Principal {
  userId: string;
  tenantId: string;
}

/** Liefert null, wenn nicht angemeldet. Der Standard ist fail secure (immer null). */
export type Authenticator = (request: FastifyRequest) => Promise<Principal | null>;
