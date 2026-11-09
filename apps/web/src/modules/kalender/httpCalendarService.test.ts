import { describe, expect, it, vi } from "vitest";
import { CalendarApiError } from "./calendarService";
import { INVITE_BATCH, createHttpCalendarService } from "./httpCalendarService";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Fetch-Attrappe: antwortet je Pfad aus der Tabelle und merkt sich die Aufrufe. */
function fakeFetch(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const path = url.split("?")[0]!;
    const handler = routes[`${call.method} ${path}`];
    if (!handler) return reply(404, {});
    return handler(call);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const event = {
  id: "e1",
  title: "GV",
  description: "",
  location: "Saal",
  startsAt: "2026-11-14T16:00:00.000Z",
  endsAt: "2026-11-14T19:30:00.000Z",
  startsAtLocal: "2026-11-14T17:00",
  endsAtLocal: "2026-11-14T20:30",
  registrationDeadline: null,
  registrationDeadlineLocal: null,
  maxGuests: 2,
};

describe("createHttpCalendarService", () => {
  it("liest Events im Zeitraum", async () => {
    const { fn, calls } = fakeFetch({
      "GET /calendar/events": () => reply(200, { events: [event] }),
    });
    const list = await createHttpCalendarService(fn).listEvents(
      "2026-10-26T00:00",
      "2026-12-07T00:00",
    );
    expect(list).toHaveLength(1);
    expect(list[0]!.startsAtLocal).toBe("2026-11-14T17:00");
    expect(calls[0]!.url).toContain("from=2026-10-26T00%3A00");
    expect(calls[0]!.headers["X-CSRF-Token"]).toBeUndefined();
  });

  it("holt das CSRF-Token einmal und sendet es bei Schreibzugriffen", async () => {
    const { fn, calls } = fakeFetch({
      "GET /auth/me": () => reply(200, { csrfToken: "tok" }),
      "POST /calendar/events": () => reply(201, { event }),
      "PATCH /calendar/events/e1": () => reply(200, { event }),
    });
    const service = createHttpCalendarService(fn);
    const input = {
      title: "GV",
      description: "",
      location: "Saal",
      startsAtLocal: "2026-11-14T17:00",
      endsAtLocal: "2026-11-14T20:30",
      registrationDeadlineLocal: "2026-11-06T23:59",
      maxGuests: 2,
    };
    await service.saveEvent(null, input);
    await service.saveEvent("e1", input);
    expect(calls.filter((c) => c.url === "/auth/me")).toHaveLength(1);
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => c.headers["X-CSRF-Token"])).toEqual(["tok", "tok"]);
    expect(writes[0]!.body).toMatchObject({
      startsAt: "2026-11-14T17:00",
      endsAt: "2026-11-14T20:30",
      registrationDeadline: "2026-11-06T23:59",
    });
  });

  it("holt das Token bei 403 neu und wiederholt einmal", async () => {
    let tokens = 0;
    let posts = 0;
    const { fn } = fakeFetch({
      "GET /auth/me": () => reply(200, { csrfToken: `t${++tokens}` }),
      "POST /calendar/events": (c) =>
        ++posts === 1 && c.headers["X-CSRF-Token"] === "t1"
          ? reply(403, {})
          : reply(201, { event }),
    });
    const saved = await createHttpCalendarService(fn).saveEvent(null, {
      title: "GV",
      description: "",
      location: "",
      startsAtLocal: "2026-11-14T17:00",
      endsAtLocal: "2026-11-14T20:30",
      registrationDeadlineLocal: null,
      maxGuests: 0,
    });
    expect(saved.id).toBe("e1");
    expect(tokens).toBe(2);
  });

  it("meldet 401 und wirft den Status, nie den Text der Antwort", async () => {
    const onUnauthorized = vi.fn();
    const { fn } = fakeFetch({
      "GET /calendar/events/e1": () => reply(401, { error: { message: "geheim" } }),
    });
    const err = await createHttpCalendarService(fn, onUnauthorized)
      .getEvent("e1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalendarApiError);
    expect((err as CalendarApiError).status).toBe(401);
    expect((err as Error).message).not.toContain("geheim");
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("übersetzt Teilnehmer und Zusammenfassung", async () => {
    const { fn } = fakeFetch({
      "GET /calendar/events/e1/participants": () =>
        reply(200, {
          summary: { invited: 2, accepted: 1, declined: 0, pending: 1, attendees: 2 },
          participants: [
            {
              invitationId: "i1",
              name: "Anna Beispiel",
              email: "anna@example.ch",
              status: "accepted",
              guests: 1,
              note: "",
              respondedAt: "2026-11-02T13:28:00.000Z",
            },
            {
              invitationId: "i2",
              name: "Beat Demo",
              email: "beat@example.ch",
              status: "pending",
              guests: 0,
              note: "",
              respondedAt: null,
            },
          ],
        }),
    });
    const p = await createHttpCalendarService(fn).participants("e1");
    expect(p.summary.attendees).toBe(2);
    expect(p.rows.map((r) => r.status)).toEqual(["accepted", "pending"]);
  });

  it("sendet Einladungen in Päckchen zu höchstens 200 und summiert", async () => {
    const sizes: number[] = [];
    const { fn } = fakeFetch({
      "GET /auth/me": () => reply(200, { csrfToken: "tok" }),
      "POST /calendar/events/e1/invitations": (c) => {
        const n = (c.body as { recipients: unknown[] }).recipients.length;
        sizes.push(n);
        return reply(200, { sent: Array(n - 1).fill("x"), skipped: ["y"], failed: [] });
      },
    });
    const recipients = Array.from({ length: 450 }, (_, i) => ({
      email: `p${i}@example.ch`,
      name: `P ${i}`,
    }));
    const result = await createHttpCalendarService(fn).invite("e1", recipients);
    expect(sizes).toEqual([INVITE_BATCH, INVITE_BATCH, 50]);
    expect(result).toEqual({ sent: 447, skipped: 3, failed: 0 });
  });

  it("liest die Empfänger einer Gruppe seitenweise und lässt Personen ohne Adresse aus", async () => {
    let page = 0;
    const { fn, calls } = fakeFetch({
      "GET /api/mitglieder": () =>
        ++page === 1
          ? reply(200, {
              items: [
                { vorname: "Anna", nachname: "Beispiel", email: "anna@example.ch" },
                { vorname: "Ohne", nachname: "Adresse", email: null },
              ],
              nextCursor: "c2",
            })
          : reply(200, {
              items: [{ vorname: "Beat", nachname: "Demo", email: "beat@example.ch" }],
              nextCursor: null,
            }),
    });
    const list = await createHttpCalendarService(fn).recipients("g1");
    expect(list).toEqual([
      { email: "anna@example.ch", name: "Anna Beispiel" },
      { email: "beat@example.ch", name: "Beat Demo" },
    ]);
    expect(calls[0]!.url).toContain("gruppeId=g1");
    expect(calls[1]!.url).toContain("cursor=c2");
  });

  it("meldet Netzwerkfehler als Status 0", async () => {
    const fn = (() => Promise.reject(new TypeError("offline"))) as unknown as typeof fetch;
    const err = await createHttpCalendarService(fn)
      .getEvent("e1")
      .catch((e: unknown) => e);
    expect((err as CalendarApiError).status).toBe(0);
  });
});
