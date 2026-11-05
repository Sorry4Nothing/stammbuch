import type { FastifyRequest } from "fastify";
import type { CalendarEvent, EventResponse, Invitation } from "./domain.js";

export interface MailMessage {
  to: { email: string; name: string };
  subject: string;
  text: string;
}

/**
 * Anbindung an das Mail-Modul. `who` ist die einladende Person: gesendet wird über deren Mailkonto.
 * Wirft, wenn die Mail nicht in die Versandqueue kommt.
 */
export interface MailPort {
  send(who: Principal, message: MailMessage): Promise<void>;
}

/**
 * Persistenz des Kalenders. Alle Abfragen aus dem Request-Pfad tragen die `tenantId`
 * (Mandantentrennung, SR-11). Das Löschen nach Ablauf gehört bewusst nicht dazu: Das macht der
 * Worker mit eigener Datenbankrolle (`CalendarRetentionPort`), die API kann keine Events löschen.
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
  deleteInvitation(tenantId: string, id: string): Promise<void>;
  getInvitationByTokenHash(tokenHash: string): Promise<Invitation | null>;
  listInvitations(tenantId: string, eventId: string): Promise<Invitation[]>;

  /** Eine Rückmeldung pro Einladung: eine neue ersetzt die alte. */
  upsertResponse(response: EventResponse): Promise<void>;
  listResponses(tenantId: string, eventId: string): Promise<EventResponse[]>;
}

/** Wer die Anfrage stellt. Kommt aus der Auth-Schicht (SR-10), nie aus dem Request-Body. */
export interface Principal {
  userId: string;
  tenantId: string;
}

/** Liefert null, wenn nicht angemeldet. Der Standard ist fail secure (immer null). */
export type Authenticator = (request: FastifyRequest) => Promise<Principal | null>;
