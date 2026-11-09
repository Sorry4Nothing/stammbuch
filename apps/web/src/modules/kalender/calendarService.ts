/**
 * Schnittstelle des Kalender-Moduls zum Backend. Die Oberfläche kennt nur diesen Vertrag;
 * `httpCalendarService.ts` setzt ihn gegen die API um, `memoryCalendarService.ts` dient Tests
 * und der Entwicklung. Zeiten sind Wandzeiten in Europe/Zurich (`JJJJ-MM-TTTHH:mm`).
 */

export interface CalEvent {
  id: string;
  title: string;
  description: string;
  location: string;
  /** Zeitpunkte als ISO-8601 (UTC), zum Vergleichen mit der aktuellen Zeit. */
  startsAt: string;
  endsAt: string;
  registrationDeadline: string | null;
  /** Wandzeiten in Zürich, zum Anzeigen und Bearbeiten. */
  startsAtLocal: string;
  endsAtLocal: string;
  registrationDeadlineLocal: string | null;
  /** Erlaubte Begleitpersonen pro Zusage (0 = keine). */
  maxGuests: number;
  /** Adressliste («Einladung an»): ID einer Gruppe; `null`, wenn keine gewählt ist. */
  inviteGroupId: string | null;
}

export interface EventInput {
  title: string;
  description: string;
  location: string;
  startsAtLocal: string;
  endsAtLocal: string;
  registrationDeadlineLocal: string | null;
  maxGuests: number;
  inviteGroupId: string | null;
}

export type AnswerStatus = "accepted" | "declined";

export interface ParticipantRow {
  invitationId: string;
  name: string;
  email: string;
  status: AnswerStatus | "pending";
  guests: number;
  note: string;
  /** ISO-8601; `null`, solange keine Rückmeldung vorliegt. */
  respondedAt: string | null;
  /** Wann die Einladung erzeugt wurde (ISO-8601). */
  invitedAt?: string;
  /** Gruppe des Mitglieds; fehlt bei freien Adressen. */
  group?: string;
  /** Die API liefert die Mitgliedsnummer noch nicht (sie steht erst mit der Personenverwaltung bereit); die Oberfläche zeigt dann «–». */
  memberNo?: string;
}

export interface ParticipantSummary {
  invited: number;
  accepted: number;
  declined: number;
  pending: number;
  /** Zusagen plus Begleitpersonen. */
  attendees: number;
}

export interface Participants {
  summary: ParticipantSummary;
  rows: ParticipantRow[];
}

export interface GroupOption {
  id: string;
  name: string;
  members: number;
}

export interface Recipient {
  email: string;
  name: string;
  /** Mitglied der Personenverwaltung; die API ordnet daran die Gruppe in der Teilnehmerliste zu. */
  memberId?: string;
}

export interface InviteResult {
  sent: number;
  /** Adresse hatte für diesen Event schon eine Einladung. */
  skipped: number;
  failed: number;
}

export interface CalendarService {
  /** Events, die im Zeitraum [from, to) beginnen. */
  listEvents: (fromLocal: string, toLocal: string, signal?: AbortSignal) => Promise<CalEvent[]>;
  getEvent: (id: string) => Promise<CalEvent>;
  /** `id === null` legt an, sonst ändert. */
  saveEvent: (id: string | null, input: EventInput) => Promise<CalEvent>;
  participants: (id: string) => Promise<Participants>;
  /** Lädt die Teilnehmerliste als .xlsx herunter. */
  exportParticipants: (id: string) => Promise<void>;
  /** Adresslisten für «Einladung an» (Gruppen der Personenverwaltung). */
  groups: () => Promise<GroupOption[]>;
  /** Empfänger einer Adressliste (nur Mitglieder mit E-Mail-Adresse). */
  recipients: (groupId: string) => Promise<Recipient[]>;
  invite: (id: string, recipients: Recipient[]) => Promise<InviteResult>;
  /** Antwortlinks erneut an alle senden, die noch nicht geantwortet haben (jeder bekommt einen neuen Link). */
  resend: (id: string) => Promise<InviteResult>;
  /** Schickt die Einladung als Testmail an die angemeldete Person. */
  sendTest: (id: string) => Promise<void>;
}

/** Fehler der Schnittstelle. `status` ist der HTTP-Status, `0` bei Netzwerkfehlern. */
export class CalendarApiError extends Error {
  constructor(readonly status: number) {
    super(`Kalender-API (${status})`);
  }
}
