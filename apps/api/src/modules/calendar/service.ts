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
import type { CalendarRepository, Lookup, MailPort, Principal } from "./ports.js";

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
  inviteGroupId: string | null;
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
  /** Mitglied der Personenverwaltung; unbekannte oder fremde IDs werden ignoriert. */
  memberId?: string;
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
  invitedAt: Date;
  /** Gruppe des Mitglieds; null bei freien Adressen und Mitgliedern ohne Gruppe. */
  group: string | null;
  /** Mitgliedsnummer; null bei freien Adressen. */
  memberNo: string | null;
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
  lookup: Lookup;
  mail: MailPort;
  now: () => Date;
  /** Basis-URL der Weboberfläche, ohne Schrägstrich am Ende. */
  publicBaseUrl: string;
}

export class CalendarService {
  constructor(private readonly deps: CalendarDeps) {}

  /** Die Adressliste muss eine Gruppe des eigenen Mandanten sein (SR-11). */
  private async checkGroup(who: Principal, groupId: string | null) {
    if (groupId && !(await this.deps.lookup.groupExists(who.tenantId, groupId))) {
      throw new CalendarError(400, "Unbekannte Adressliste");
    }
  }

  async createEvent(who: Principal, fields: EventFields): Promise<CalendarEvent> {
    checkFields(fields);
    await this.checkGroup(who, fields.inviteGroupId);
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
    if (next.inviteGroupId !== current.inviteGroupId) {
      await this.checkGroup(who, next.inviteGroupId);
    }
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
    const memberIds = [...new Set(recipients.flatMap((r) => (r.memberId ? [r.memberId] : [])))];
    const known = await this.deps.lookup.describeMembers(who.tenantId, memberIds);

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
        memberId: r.memberId && known.has(r.memberId) ? r.memberId : null,
        tokenHash: hashToken(token),
        createdAt: this.deps.now(),
      };
      await this.deps.repo.insertInvitation(invitation);
      try {
        await this.deps.mail.send(who, {
          to: { email, name: r.name },
          subject: `Einladung: ${event.title}`,
          text: this.inviteText(event, r.name, `${this.deps.publicBaseUrl}/antwort/${token}`),
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

  /**
   * Testmail an die angemeldete Person: derselbe Text wie die Einladung, aber ohne Antwortlink (es gibt
   * keine Einladung, also auch kein Token). Es wird nichts gespeichert.
   */
  async sendTest(who: Principal, eventId: string): Promise<void> {
    const event = await this.getEvent(who, eventId);
    const me = await this.deps.lookup.userContact(who.tenantId, who.userId);
    if (!me) throw notFound();
    await this.deps.mail.send(who, {
      to: me,
      subject: `Test: Einladung: ${event.title}`,
      text: this.inviteText(
        event,
        me.name,
        "(Hier steht in der echten Einladung der persönliche Link.)",
      ),
    });
  }

  /**
   * Antwortlinks erneut senden an alle, die noch nicht geantwortet haben. Gespeichert ist nur der Hash,
   * der alte Link ist nicht wiederherstellbar: Jede Einladung bekommt ein neues Token, der alte Link wird
   * ungültig. Scheitert die Mail, gilt der alte Hash wieder (der frühere Link bleibt gültig).
   */
  async resend(who: Principal, eventId: string): Promise<InviteResult> {
    const event = await this.getEvent(who, eventId);
    if (event.endsAt <= this.deps.now()) throw new CalendarError(409, "Event ist beendet");
    if (!this.isOpen(event)) throw new CalendarError(409, "Anmeldung geschlossen");

    const [invitations, responses] = await Promise.all([
      this.deps.repo.listInvitations(who.tenantId, eventId),
      this.deps.repo.listResponses(who.tenantId, eventId),
    ]);
    const answered = new Set(responses.map((r) => r.invitationId));
    const result: InviteResult = { sent: [], skipped: [], failed: [] };

    for (const i of invitations) {
      if (answered.has(i.id)) continue;
      const token = generateToken();
      await this.deps.repo.updateInvitationTokenHash(who.tenantId, i.id, hashToken(token));
      try {
        await this.deps.mail.send(who, {
          to: { email: i.email, name: i.name },
          subject: `Erinnerung: Einladung: ${event.title}`,
          text: this.inviteText(event, i.name, `${this.deps.publicBaseUrl}/antwort/${token}`),
        });
        result.sent.push(i.email);
      } catch {
        await this.deps.repo.updateInvitationTokenHash(who.tenantId, i.id, i.tokenHash);
        result.failed.push(i.email);
      }
    }
    return result;
  }

  private inviteText(event: CalendarEvent, name: string, link: string): string {
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
    lines.push(link);
    return lines.join("\n");
  }

  async participants(who: Principal, eventId: string): Promise<ParticipantList> {
    await this.getEvent(who, eventId);
    const [invitations, responses] = await Promise.all([
      this.deps.repo.listInvitations(who.tenantId, eventId),
      this.deps.repo.listResponses(who.tenantId, eventId),
    ]);
    const byInvitation = new Map(responses.map((r) => [r.invitationId, r]));
    const members = await this.deps.lookup.describeMembers(
      who.tenantId,
      invitations.flatMap((i) => (i.memberId ? [i.memberId] : [])),
    );
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
          invitedAt: i.createdAt,
          group: (i.memberId && members.get(i.memberId)?.group) || null,
          memberNo: (i.memberId && members.get(i.memberId)?.mitgliedsnr) || null,
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
