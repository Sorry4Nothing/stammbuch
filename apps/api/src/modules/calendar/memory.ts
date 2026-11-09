import type { CalendarEvent, EventResponse, Invitation } from "./domain.js";
import type { CalendarRepository, Lookup } from "./ports.js";

/** In-Memory-Implementierung für Tests und Entwicklung bis zur DB-Anbindung (#3). */
export class InMemoryCalendarRepository implements CalendarRepository {
  readonly events = new Map<string, CalendarEvent>();
  readonly invitations = new Map<string, Invitation>();
  readonly responses = new Map<string, EventResponse>();

  async insertEvent(event: CalendarEvent) {
    this.events.set(event.id, { ...event });
  }

  async updateEvent(event: CalendarEvent) {
    if (!this.events.has(event.id)) throw new Error("Event existiert nicht");
    this.events.set(event.id, { ...event });
  }

  async getEvent(tenantId: string, id: string) {
    const e = this.events.get(id);
    return e && e.tenantId === tenantId ? { ...e } : null;
  }

  async listEvents(tenantId: string, { from, to, limit }: { from: Date; to: Date; limit: number }) {
    return [...this.events.values()]
      .filter((e) => e.tenantId === tenantId && e.startsAt >= from && e.startsAt < to)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  async insertInvitation(invitation: Invitation) {
    this.invitations.set(invitation.id, { ...invitation });
  }

  async deleteInvitation(_tenantId: string, id: string) {
    this.invitations.delete(id);
  }

  async updateInvitationTokenHash(tenantId: string, id: string, tokenHash: string) {
    const i = this.invitations.get(id);
    if (i && i.tenantId === tenantId) this.invitations.set(id, { ...i, tokenHash });
  }

  async getInvitationByTokenHash(tokenHash: string) {
    for (const i of this.invitations.values()) if (i.tokenHash === tokenHash) return { ...i };
    return null;
  }

  async listInvitations(tenantId: string, eventId: string) {
    return [...this.invitations.values()]
      .filter((i) => i.tenantId === tenantId && i.eventId === eventId)
      .map((i) => ({ ...i }));
  }

  async upsertResponse(response: EventResponse) {
    for (const [id, r] of this.responses) {
      if (r.invitationId === response.invitationId) this.responses.delete(id);
    }
    this.responses.set(response.id, { ...response });
  }

  async listResponses(tenantId: string, eventId: string) {
    return [...this.responses.values()]
      .filter((r) => r.tenantId === tenantId && r.eventId === eventId)
      .map((r) => ({ ...r }));
  }

  // Lösch-Job (Worker), nicht Teil von CalendarRepository: nur für Tests, die den Job abbilden.
  async findEventIdsEndedBefore(cutoff: Date) {
    return [...this.events.values()].filter((e) => e.endsAt <= cutoff).map((e) => e.id);
  }

  async deleteEventData(eventId: string) {
    this.events.delete(eventId);
    for (const [id, i] of this.invitations) if (i.eventId === eventId) this.invitations.delete(id);
    for (const [id, r] of this.responses) if (r.eventId === eventId) this.responses.delete(id);
  }
}

/** Nachschlagen im Speicher (Tests, Entwicklung): Die Daten setzt der Aufrufer. */
export class InMemoryLookup implements Lookup {
  readonly groups = new Set<string>();
  /** Mitglied-ID zu Gruppenname (null: in keiner Gruppe). */
  readonly members = new Map<string, string | null>();
  /** Mitglied-ID zu Mitgliedsnummer; ohne Eintrag bleibt sie leer. */
  readonly numbers = new Map<string, string>();
  readonly users = new Map<string, { email: string; name: string }>();

  async groupExists(_tenantId: string, groupId: string) {
    return this.groups.has(groupId);
  }

  async describeMembers(_tenantId: string, memberIds: string[]) {
    const out = new Map<string, { group: string | null; mitgliedsnr: string }>();
    for (const id of memberIds) {
      if (this.members.has(id)) {
        out.set(id, {
          group: this.members.get(id) ?? null,
          mitgliedsnr: this.numbers.get(id) ?? "",
        });
      }
    }
    return out;
  }

  async userContact(_tenantId: string, userId: string) {
    return this.users.get(userId) ?? null;
  }
}
