import {
  CalendarApiError,
  type CalEvent,
  type CalendarService,
  type EventInput,
  type GroupOption,
  type InviteResult,
  type ParticipantRow,
  type Participants,
  type Recipient,
} from "./calendarService";
import { instantOf } from "./time";

const iso = (local: string) => new Date(instantOf(local)).toISOString();

export function eventFromInput(id: string, input: EventInput): CalEvent {
  return {
    id,
    title: input.title,
    description: input.description,
    location: input.location,
    startsAt: iso(input.startsAtLocal),
    endsAt: iso(input.endsAtLocal),
    registrationDeadline: input.registrationDeadlineLocal
      ? iso(input.registrationDeadlineLocal)
      : null,
    startsAtLocal: input.startsAtLocal,
    endsAtLocal: input.endsAtLocal,
    registrationDeadlineLocal: input.registrationDeadlineLocal,
    maxGuests: input.maxGuests,
    inviteGroupId: input.inviteGroupId,
  };
}

export interface MemorySeed {
  events?: CalEvent[];
  /** Teilnehmer je Event-ID. */
  participants?: Record<string, ParticipantRow[]>;
  groups?: (GroupOption & { recipients: Recipient[] })[];
}

export function summarize(rows: ParticipantRow[]): Participants {
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

/** Flüchtiger Speicher für Tests und die Entwicklung ohne API. */
export function createMemoryCalendarService(seed: MemorySeed = {}): CalendarService & {
  events: CalEvent[];
  sent: Recipient[];
  exported: string[];
  resent: string[];
  tested: string[];
} {
  const events = [...(seed.events ?? [])];
  const rows = { ...seed.participants };
  const groups = seed.groups ?? [];
  const sent: Recipient[] = [];
  const exported: string[] = [];
  const resent: string[] = [];
  const tested: string[] = [];
  let counter = 0;

  const find = (id: string) => {
    const e = events.find((x) => x.id === id);
    if (!e) throw new CalendarApiError(404);
    return e;
  };

  return {
    events,
    sent,
    exported,
    resent,
    tested,
    listEvents: (from, to) =>
      Promise.resolve(
        events
          .filter((e) => e.startsAtLocal >= from && e.startsAtLocal < to)
          .sort((a, b) => a.startsAtLocal.localeCompare(b.startsAtLocal)),
      ),
    getEvent: (id) => Promise.resolve(find(id)),
    saveEvent(id, input) {
      if (id) {
        const i = events.findIndex((e) => e.id === id);
        if (i < 0) return Promise.reject(new CalendarApiError(404));
        events[i] = eventFromInput(id, input);
        return Promise.resolve(events[i]!);
      }
      const created = eventFromInput(`ev-${++counter}`, input);
      events.push(created);
      return Promise.resolve(created);
    },
    participants: (id) => {
      find(id);
      return Promise.resolve(summarize(rows[id] ?? []));
    },
    exportParticipants: (id) => {
      exported.push(id);
      return Promise.resolve();
    },
    groups: () => Promise.resolve(groups.map(({ id, name, members }) => ({ id, name, members }))),
    recipients: (groupId) =>
      Promise.resolve(groups.find((g) => g.id === groupId)?.recipients ?? []),
    invite(id, recipients): Promise<InviteResult> {
      find(id);
      sent.push(...recipients);
      return Promise.resolve({ sent: recipients.length, skipped: 0, failed: 0 });
    },
    resend(id): Promise<InviteResult> {
      find(id);
      resent.push(id);
      const pending = (rows[id] ?? []).filter((r) => r.status === "pending").length;
      return Promise.resolve({ sent: pending, skipped: 0, failed: 0 });
    },
    sendTest(id) {
      find(id);
      tested.push(id);
      return Promise.resolve();
    },
  };
}
