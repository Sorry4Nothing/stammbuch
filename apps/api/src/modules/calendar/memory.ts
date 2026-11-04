import type { CalendarEvent, EventResponse, Invitation } from "./domain.js";
import type { CalendarRepository } from "./ports.js";

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

  async deleteInvitation(id: string) {
    this.invitations.delete(id);
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

  async findEventIdsEndedBefore(cutoff: Date) {
    return [...this.events.values()].filter((e) => e.endsAt <= cutoff).map((e) => e.id);
  }

  async deleteEventData(eventId: string) {
    this.events.delete(eventId);
    for (const [id, i] of this.invitations) if (i.eventId === eventId) this.invitations.delete(id);
    for (const [id, r] of this.responses) if (r.eventId === eventId) this.responses.delete(id);
  }
}
