import { describe, expect, it, vi } from "vitest";
import { createHttpNavCounters } from "../../shell/navCounters";
import { createHttpStartService, StartApiError } from "./httpStartService";

const NOW = Date.UTC(2026, 10, 2, 8, 0); // 02.11.2026 09:00 in Zürich

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const event = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Event ${id}`,
  description: "",
  location: "",
  startsAt: "2026-11-14T16:00:00.000Z",
  endsAt: "2026-11-14T19:00:00.000Z",
  startsAtLocal: "2026-11-14T17:00",
  endsAtLocal: "2026-11-14T20:00",
  registrationDeadline: null,
  registrationDeadlineLocal: null,
  maxGuests: 0,
  ...over,
});

/** Antworten der API je Pfad; `calls` hält die angefragten Pfade fest. */
function api(over: Record<string, () => Response> = {}) {
  const calls: string[] = [];
  const routes: Record<string, () => Response> = {
    "/tasks": () =>
      json({
        items: [{ id: "t1", title: "Duplikate prüfen", due: "2026-11-06" }],
        total: 1,
        dueCount: 0,
      }),
    "/invoices/open-items": () =>
      json({
        items: [
          {
            id: "i1",
            number: "RE-2026-0001",
            debtor: "Erika Beispiel",
            openCents: 26594,
            currency: "CHF",
            dueDate: "2026-10-01",
          },
        ],
        total: 1,
        overdue: 1,
      }),
    "/calendar/events": () =>
      json({
        events: [
          event("e1", { registrationDeadlineLocal: "2026-11-06T23:59" }),
          event("e2", { title: "Helferessen", startsAtLocal: "2026-11-21T19:00" }),
        ],
      }),
    "/calendar/events/e1/participants": () =>
      json({
        summary: { invited: 90, accepted: 86, declined: 2, pending: 2, attendees: 90 },
        participants: [],
      }),
    "/calendar/events/e2/participants": () =>
      json({
        summary: { invited: 30, accepted: 24, declined: 0, pending: 6, attendees: 24 },
        participants: [],
      }),
    ...over,
  };
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    expect(init?.method ?? "GET").toBe("GET");
    const handler = routes[url.split("?")[0]!];
    return handler ? handler() : json({}, 404);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("createHttpStartService", () => {
  it("setzt Aufgaben, offene Posten mit Schuldner und Events mit Zusagen zusammen", async () => {
    const { fetchFn, calls } = api();
    const data = await createHttpStartService(fetchFn, undefined, () => NOW).load(
      new AbortController().signal,
    );
    expect(data.tasks).toEqual([{ id: "t1", title: "Duplikate prüfen", due: "2026-11-06" }]);
    expect(data.openItems).toEqual([
      {
        id: "i1",
        invoiceNumber: "RE-2026-0001",
        debtor: "Erika Beispiel",
        amountCents: 26594,
        currency: "CHF",
        due: "2026-10-01",
      },
    ]);
    expect(data.events).toEqual([
      {
        id: "e1",
        title: "Event e1",
        date: "2026-11-14",
        time: "17:00",
        confirmed: 86,
        deadline: "2026-11-06",
      },
      { id: "e2", title: "Helferessen", date: "2026-11-21", time: "19:00", confirmed: 24 },
    ]);
    // Der Zeitraum beginnt jetzt (Ortszeit) und reicht 90 Tage weit.
    const range = calls.find((c) => c.startsWith("/calendar/events?"))!;
    const q = new URLSearchParams(range.split("?")[1]);
    expect(q.get("from")).toBe("2026-11-02T09:00");
    expect(q.get("to")).toBe("2027-01-31T00:00");
  });

  it("leere Antworten ergeben leere Listen", async () => {
    const { fetchFn } = api({
      "/tasks": () => json({ items: [], total: 0, dueCount: 0 }),
      "/invoices/open-items": () => json({ items: [], total: 0, overdue: 0 }),
      "/calendar/events": () => json({ events: [] }),
    });
    const data = await createHttpStartService(fetchFn, undefined, () => NOW).load(
      new AbortController().signal,
    );
    expect(data).toEqual({ tasks: [], openItems: [], events: [] });
  });

  it.each([
    "/tasks",
    "/invoices/open-items",
    "/calendar/events",
    "/calendar/events/e1/participants",
  ])("scheitert, wenn %s nicht antwortet, statt Teildaten zu zeigen", async (path) => {
    const { fetchFn } = api({
      [path]: () => json({ error: { code: "INTERNAL", message: "x" } }, 500),
    });
    await expect(
      createHttpStartService(fetchFn, undefined, () => NOW).load(new AbortController().signal),
    ).rejects.toBeDefined();
  });

  it("meldet Netzwerkfehler und ungültige Antworten als StartApiError ohne Text der API", async () => {
    const offline = vi.fn(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    ) as unknown as typeof fetch;
    await expect(
      createHttpStartService(offline, undefined, () => NOW).load(new AbortController().signal),
    ).rejects.toMatchObject({ status: 0 });
    const { fetchFn } = api({ "/tasks": () => new Response("kein json", { status: 200 }) });
    await expect(
      createHttpStartService(fetchFn, undefined, () => NOW).load(new AbortController().signal),
    ).rejects.toBeInstanceOf(StartApiError);
  });
});

describe("createHttpNavCounters", () => {
  it("liefert fällige Aufgaben, überfällige Rechnungen und ungelesene Mails", async () => {
    const { fetchFn } = api({
      "/tasks": () => json({ items: [], total: 5, dueCount: 3 }),
      "/invoices/open-items": () => json({ items: [], total: 4, overdue: 1 }),
      "/mail/unread-count": () => json({ unread: 12 }),
    });
    const counts = await createHttpNavCounters(fetchFn).load(new AbortController().signal);
    expect(counts).toEqual({
      start: { count: 3, label: "3 fällige Aufgaben" },
      invoices: { count: 1, label: "1 überfällige Rechnung" },
      mail: { count: 12, label: "12 ungelesene Mails" },
    });
  });

  it("lässt einen Zähler weg, dessen Quelle fehlschlägt oder Unsinn liefert", async () => {
    const { fetchFn } = api({
      "/tasks": () => json({}, 500),
      "/invoices/open-items": () => json({ overdue: "viele" }),
      "/mail/unread-count": () => json({ unread: null }), // kein Konto antwortet: keine Zahl
    });
    expect(await createHttpNavCounters(fetchFn).load(new AbortController().signal)).toEqual({});
  });
});
