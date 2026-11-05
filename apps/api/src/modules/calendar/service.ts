import { randomUUID } from "node:crypto";
import {
  type CalendarEvent,
  type EventResponse,
  type Invitation,
  type ResponseStatus,
  TOKEN_PATTERN,
  formatLocal,
  generateToken,
  hashToken,
} from "./domain.js";
import type { CalendarRepository, MailPort, Principal } from "./ports.js";

/** Fachlicher Fehler mit HTTP-Status. Der zentrale Fehlerhandler gibt nur Code und festen Text aus. */
export class CalendarError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

const notFound = () => new CalendarError(404, "Nicht gefunden");

export interface EventFields {
  title: string;
  description: string;
  location: string;
  startsAt: Date;
  endsAt: Date;
  registrationDeadline: Date | null;
  maxGuests: number;
}

function checkFields(f: EventFields) {
  if (f.endsAt <= f.startsAt) throw new CalendarError(400, "Ende liegt vor dem Beginn");
  if (f.registrationDeadline && f.registrationDeadline > f.startsAt) {
    throw new CalendarError(400, "Anmeldeschluss liegt nach dem Beginn");
  }
}

export interface Recipient {
  email: string;
  name: string;
}

export interface InviteResult {
  sent: string[];
  skipped: string[];
  failed: string[];
}

export interface ParticipantRow {
  invitationId: string;
  name: string;
  email: string;
  status: ResponseStatus | "pending";
  guests: number;
  note: string;
  respondedAt: Date | null;
}

export interface ParticipantList {
  rows: ParticipantRow[];
  summary: {
    invited: number;
    accepted: number;
    declined: number;
    pending: number;
    attendees: number;
  };
}

export interface PublicView {
  event: CalendarEvent;
  open: boolean;
  invitee: { name: string };
  response: EventResponse | null;
}

export interface CalendarDeps {
  repo: CalendarRepository;
  mail: MailPort;
  now: () => Date;
  /** Basis-URL der Weboberfläche, ohne Schrägstrich am Ende. */
  publicBaseUrl: string;
}

export class CalendarService {
  constructor(private readonly deps: CalendarDeps) {}

  async createEvent(who: Principal, fields: EventFields): Promise<CalendarEvent> {
    checkFields(fields);
    const now = this.deps.now();
    const event: CalendarEvent = {
      ...fields,
      id: randomUUID(),
      tenantId: who.tenantId,
      createdBy: who.userId,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.repo.insertEvent(event);
    return event;
  }

  async updateEvent(who: Principal, id: string, patch: Partial<EventFields>) {
    const current = await this.getEvent(who, id);
    // `undefined` im Patch heisst «nicht ändern», `null` beim Anmeldeschluss heisst «entfernen».
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next: CalendarEvent = { ...current, ...defined, updatedAt: this.deps.now() };
    checkFields(next);
    await this.deps.repo.updateEvent(next);
    return next;
  }

  async getEvent(who: Principal, id: string): Promise<CalendarEvent> {
    // Fremder Mandant und unbekannte ID sind nicht unterscheidbar (SR-11).
    const event = await this.deps.repo.getEvent(who.tenantId, id);
    if (!event) throw notFound();
    return event;
  }

  listEvents(who: Principal, range: { from: Date; to: Date; limit: number }) {
    return this.deps.repo.listEvents(who.tenantId, range);
  }

  async invite(who: Principal, eventId: string, recipients: Recipient[]): Promise<InviteResult> {
    const event = await this.getEvent(who, eventId);
    if (event.endsAt <= this.deps.now()) throw new CalendarError(409, "Event ist beendet");

    const existing = new Set(
      (await this.deps.repo.listInvitations(who.tenantId, eventId)).map((i) => i.email),
    );
    const result: InviteResult = { sent: [], skipped: [], failed: [] };

    for (const r of recipients) {
      const email = r.email.toLowerCase();
      if (existing.has(email)) {
        result.skipped.push(email);
        continue;
      }
      existing.add(email);

      const token = generateToken();
      const invitation: Invitation = {
        id: randomUUID(),
        tenantId: who.tenantId,
        eventId,
        email,
        name: r.name,
        tokenHash: hashToken(token),
        createdAt: this.deps.now(),
      };
      await this.deps.repo.insertInvitation(invitation);
      try {
        await this.deps.mail.send(who, {
          to: { email, name: r.name },
          subject: `Einladung: ${event.title}`,
          text: this.inviteText(event, r.name, token),
        });
        result.sent.push(email);
      } catch {
        // Ohne zugestellte Mail kennt niemand das Token: Einladung zurücknehmen, damit ein
        // zweiter Versuch möglich ist. Die Fehlerursache steht im Log des Mail-Moduls.
        await this.deps.repo.deleteInvitation(who.tenantId, invitation.id);
        result.failed.push(email);
      }
    }
    return result;
  }

  private inviteText(event: CalendarEvent, name: string, token: string): string {
    const lines = [
      `Guten Tag ${name}`,
      "",
      `Sie sind eingeladen: ${event.title}`,
      `Beginn: ${formatLocal(event.startsAt)} Uhr`,
      `Ende: ${formatLocal(event.endsAt)} Uhr`,
    ];
    if (event.location) lines.push(`Ort: ${event.location}`);
    if (event.registrationDeadline) {
      lines.push(`Anmeldeschluss: ${formatLocal(event.registrationDeadline)} Uhr`);
    }
    lines.push("", "Bitte melden Sie sich über diesen persönlichen Link zurück:");
    lines.push(`${this.deps.publicBaseUrl}/antwort/${token}`);
    return lines.join("\n");
  }

  async participants(who: Principal, eventId: string): Promise<ParticipantList> {
    await this.getEvent(who, eventId);
    const [invitations, responses] = await Promise.all([
      this.deps.repo.listInvitations(who.tenantId, eventId),
      this.deps.repo.listResponses(who.tenantId, eventId),
    ]);
    const byInvitation = new Map(responses.map((r) => [r.invitationId, r]));
    const rows = invitations
      .map((i): ParticipantRow => {
        const r = byInvitation.get(i.id);
        return {
          invitationId: i.id,
          name: i.name,
          email: i.email,
          status: r?.status ?? "pending",
          guests: r?.guests ?? 0,
          note: r?.note ?? "",
          respondedAt: r?.respondedAt ?? null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "de-CH"));

    const accepted = rows.filter((r) => r.status === "accepted");
    return {
      rows,
      summary: {
        invited: rows.length,
        accepted: accepted.length,
        declined: rows.filter((r) => r.status === "declined").length,
        pending: rows.filter((r) => r.status === "pending").length,
        attendees: accepted.reduce((n, r) => n + 1 + r.guests, 0),
      },
    };
  }

  // --- Öffentliche Antwort per Token -------------------------------------------------------

  /**
   * Jeder Fehlerfall (falsches Format, unbekanntes Token, gelöschtes Event) ist dieselbe 404-
   * Antwort: so lässt sich weder Token noch Adresse erraten oder abfragen (Enumeration).
   */
  private async resolve(token: string): Promise<{ invitation: Invitation; event: CalendarEvent }> {
    if (!TOKEN_PATTERN.test(token)) throw notFound();
    const invitation = await this.deps.repo.getInvitationByTokenHash(hashToken(token));
    if (!invitation) throw notFound();
    const event = await this.deps.repo.getEvent(invitation.tenantId, invitation.eventId);
    if (!event) throw notFound();
    return { invitation, event };
  }

  private isOpen(event: CalendarEvent): boolean {
    return this.deps.now() <= (event.registrationDeadline ?? event.startsAt);
  }

  async publicView(token: string): Promise<PublicView> {
    const { invitation, event } = await this.resolve(token);
    const responses = await this.deps.repo.listResponses(event.tenantId, event.id);
    return {
      event,
      open: this.isOpen(event),
      invitee: { name: invitation.name },
      response: responses.find((r) => r.invitationId === invitation.id) ?? null,
    };
  }

  async publicRespond(
    token: string,
    input: { status: ResponseStatus; guests: number; note: string },
  ): Promise<PublicView> {
    const { invitation, event } = await this.resolve(token);
    if (!this.isOpen(event)) throw new CalendarError(409, "Anmeldung geschlossen");
    const guests = input.status === "accepted" ? input.guests : 0;
    if (guests > event.maxGuests) throw new CalendarError(400, "Zu viele Begleitpersonen");

    const response: EventResponse = {
      id: randomUUID(),
      tenantId: event.tenantId,
      eventId: event.id,
      invitationId: invitation.id,
      status: input.status,
      guests,
      note: input.note,
      respondedAt: this.deps.now(),
    };
    await this.deps.repo.upsertResponse(response);
    return { event, open: true, invitee: { name: invitation.name }, response };
  }
}
