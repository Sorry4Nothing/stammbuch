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

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null;
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Einladungen pro Anfrage: so viele erlaubt die API (`inviteBody`). */
export const INVITE_BATCH = 200;
/** Seitengrösse der Mitgliederliste (Höchstwert der API). */
const MEMBER_PAGE = 200;

function eventOf(raw: Json): CalEvent {
  return {
    id: str(raw["id"]),
    title: str(raw["title"]),
    description: str(raw["description"]),
    location: str(raw["location"]),
    startsAt: str(raw["startsAt"]),
    endsAt: str(raw["endsAt"]),
    registrationDeadline: strOrNull(raw["registrationDeadline"]),
    startsAtLocal: str(raw["startsAtLocal"]),
    endsAtLocal: str(raw["endsAtLocal"]),
    registrationDeadlineLocal: strOrNull(raw["registrationDeadlineLocal"]),
    maxGuests: num(raw["maxGuests"]),
    inviteGroupId: strOrNull(raw["inviteGroupId"]),
  };
}

function rowOf(raw: Json): ParticipantRow {
  const status = raw["status"];
  return {
    invitationId: str(raw["invitationId"]),
    name: str(raw["name"]),
    email: str(raw["email"]),
    status: status === "accepted" || status === "declined" ? status : "pending",
    guests: num(raw["guests"]),
    note: str(raw["note"]),
    respondedAt: strOrNull(raw["respondedAt"]),
    ...(typeof raw["invitedAt"] === "string" ? { invitedAt: raw["invitedAt"] } : {}),
    ...(typeof raw["group"] === "string" ? { group: raw["group"] } : {}),
  };
}

/**
 * `CalendarService` gegen die Kalender-API (`/calendar/*`) und die Personenverwaltung (`/api/gruppen`,
 * `/api/mitglieder`). Gleiche Origin; die Sitzung liegt im `HttpOnly`-Cookie. Das CSRF-Token holt
 * der Dienst einmal per `GET /auth/me` und hält es nur im Speicher. Fehlertexte der API gelangen nie
 * in die Oberfläche, nur der Status.
 */
export function createHttpCalendarService(
  fetchFn: typeof fetch = (...args) => fetch(...args),
  onUnauthorized: () => void = () => undefined,
): CalendarService {
  let csrf: string | null = null;

  async function token(): Promise<string> {
    if (csrf) return csrf;
    const res = await fetchFn("/auth/me", {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok || !isRecord(body) || typeof body["csrfToken"] !== "string") {
      throw new CalendarApiError(res.status);
    }
    csrf = body["csrfToken"];
    return csrf;
  }

  async function send(
    method: "GET" | "POST" | "PATCH",
    path: string,
    payload?: object,
    signal?: AbortSignal,
    retry = true,
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (payload) headers["Content-Type"] = "application/json";
    if (method !== "GET") headers["X-CSRF-Token"] = await token();
    let res: Response;
    try {
      res = await fetchFn(path, {
        method,
        headers,
        credentials: "same-origin",
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      throw new CalendarApiError(0);
    }
    if (res.status === 401) {
      onUnauthorized();
      throw new CalendarApiError(401);
    }
    if (res.status === 403 && method !== "GET" && retry) {
      csrf = null; // Token veraltet (neue Sitzung): einmal neu holen
      return send(method, path, payload, signal, false);
    }
    if (!res.ok) throw new CalendarApiError(res.status);
    return res;
  }

  async function json(
    method: "GET" | "POST" | "PATCH",
    path: string,
    payload?: object,
    signal?: AbortSignal,
  ): Promise<Json> {
    const res = await send(method, path, payload, signal);
    const body: unknown = await res.json().catch(() => null);
    if (!isRecord(body)) throw new CalendarApiError(res.status);
    return body;
  }

  const eventPath = (id: string) => `/calendar/events/${encodeURIComponent(id)}`;

  /** Eingabe ohne Anmeldeschluss: `null` entfernt die Frist. */
  const payloadOf = (i: EventInput) => ({
    title: i.title,
    description: i.description,
    location: i.location,
    startsAt: i.startsAtLocal,
    endsAt: i.endsAtLocal,
    registrationDeadline: i.registrationDeadlineLocal,
    maxGuests: i.maxGuests,
    inviteGroupId: i.inviteGroupId,
  });

  return {
    async listEvents(fromLocal, toLocal, signal) {
      const q = new URLSearchParams({ from: fromLocal, to: toLocal, limit: "1000" });
      const body = await json("GET", `/calendar/events?${q}`, undefined, signal);
      return list(body["events"]).map(eventOf);
    },

    async getEvent(id) {
      const body = await json("GET", eventPath(id));
      if (!isRecord(body["event"])) throw new CalendarApiError(200);
      return eventOf(body["event"]);
    },

    async saveEvent(id, input) {
      const body = id
        ? await json("PATCH", eventPath(id), payloadOf(input))
        : await json("POST", "/calendar/events", payloadOf(input));
      if (!isRecord(body["event"])) throw new CalendarApiError(200);
      return eventOf(body["event"]);
    },

    async participants(id): Promise<Participants> {
      const body = await json("GET", `${eventPath(id)}/participants`);
      const s = isRecord(body["summary"]) ? body["summary"] : {};
      return {
        summary: {
          invited: num(s["invited"]),
          accepted: num(s["accepted"]),
          declined: num(s["declined"]),
          pending: num(s["pending"]),
          attendees: num(s["attendees"]),
        },
        rows: list(body["participants"]).map(rowOf),
      };
    },

    async exportParticipants(id) {
      const res = await send("GET", `${eventPath(id)}/participants.xlsx`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `teilnehmer-${id}.xlsx`;
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },

    async groups(): Promise<GroupOption[]> {
      const body = await json("GET", "/api/gruppen");
      return list(body["items"]).map((g) => ({
        id: str(g["id"]),
        name: str(g["name"]),
        members: num(g["mitglieder"]),
      }));
    },

    async recipients(groupId): Promise<Recipient[]> {
      const out: Recipient[] = [];
      let cursor: string | null = null;
      do {
        const q = new URLSearchParams({ gruppeId: groupId, limit: String(MEMBER_PAGE) });
        if (cursor) q.set("cursor", cursor);
        const body = await json("GET", `/api/mitglieder?${q}`);
        for (const m of list(body["items"])) {
          const email = str(m["email"]).trim();
          if (!email) continue;
          const name = `${str(m["vorname"])} ${str(m["nachname"])}`.trim();
          const memberId = str(m["id"]);
          out.push({ email, name: name || email, ...(memberId ? { memberId } : {}) });
        }
        cursor = strOrNull(body["nextCursor"]);
      } while (cursor);
      return out;
    },

    async invite(id, recipients): Promise<InviteResult> {
      const total: InviteResult = { sent: 0, skipped: 0, failed: 0 };
      for (let i = 0; i < recipients.length; i += INVITE_BATCH) {
        const body = await json("POST", `${eventPath(id)}/invitations`, {
          recipients: recipients.slice(i, i + INVITE_BATCH),
        });
        total.sent += arrayLength(body["sent"]);
        total.skipped += arrayLength(body["skipped"]);
        total.failed += arrayLength(body["failed"]);
      }
      return total;
    },

    async resend(id): Promise<InviteResult> {
      const body = await json("POST", `${eventPath(id)}/invitations/resend`);
      return {
        sent: arrayLength(body["sent"]),
        skipped: arrayLength(body["skipped"]),
        failed: arrayLength(body["failed"]),
      };
    },

    async sendTest(id) {
      await send("POST", `${eventPath(id)}/invitations/test`);
    },
  };
}

const arrayLength = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
