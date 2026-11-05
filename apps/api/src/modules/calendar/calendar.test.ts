import rateLimit from "@fastify/rate-limit";
import ExcelJS from "exceljs";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { errorHandler, notFoundHandler } from "../../lib/errors.js";
import { type CalendarEvent, hashToken, localToDate, toLocalString } from "./domain.js";
import { eventToIcs, neutralize, participantsWorkbook } from "./export.js";
import { createCalendarModule } from "./index.js";
import { InMemoryCalendarRepository } from "./memory.js";
import type { MailMessage, Principal } from "./ports.js";

describe("Zeitzone Europe/Zurich", () => {
  it("rechnet Winter- und Sommerzeit korrekt nach UTC", () => {
    expect(localToDate("2026-12-01T18:00")?.toISOString()).toBe("2026-12-01T17:00:00.000Z");
    expect(localToDate("2026-07-01T18:00")?.toISOString()).toBe("2026-07-01T16:00:00.000Z");
  });

  it("lehnt nicht existierende Zeiten ab (Sprung auf Sommerzeit)", () => {
    expect(localToDate("2026-03-29T02:30")).toBeNull();
    expect(localToDate("2026-02-30T10:00")).toBeNull();
  });

  it("wählt bei der doppelten Herbststunde die erste und gibt lokal dasselbe zurück", () => {
    const d = localToDate("2026-10-25T02:30");
    expect(d?.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(toLocalString(d!)).toBe("2026-10-25T02:30");
  });
});

describe("Excel-Export", () => {
  it("neutralisiert Zeichen am Anfang, die eine Formel einleiten", () => {
    for (const v of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=x", "\r=x"]) {
      expect(neutralize(v)).toBe(`'${v}`);
    }
    expect(neutralize("Anna =Muster")).toBe("Anna =Muster");
  });

  it("schreibt böse Werte als Text, nie als Formel", async () => {
    const event: CalendarEvent = {
      id: "e1",
      tenantId: "t1",
      title: '=HYPERLINK("http://boese.example")',
      description: "",
      location: "",
      startsAt: new Date("2026-12-01T17:00:00Z"),
      endsAt: new Date("2026-12-01T19:00:00Z"),
      registrationDeadline: null,
      maxGuests: 1,
      createdBy: "u1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const buf = await participantsWorkbook(event, {
      rows: [
        {
          invitationId: "i1",
          name: "=cmd|' /C calc'!A0",
          email: "+a@example.org",
          status: "accepted",
          guests: 1,
          note: "@SUM(1+1)",
          respondedAt: new Date("2026-11-01T10:00:00Z"),
        },
      ],
      summary: { invited: 1, accepted: 1, declined: 0, pending: 0, attendees: 2 },
    });
    expect(buf.subarray(0, 2).toString()).toBe("PK");

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Teilnehmer")!;
    const cells = [ws.getCell("A1"), ws.getCell("A7"), ws.getCell("B7"), ws.getCell("E7")];
    for (const c of cells) {
      expect(c.type).toBe(ExcelJS.ValueType.String);
      expect(String(c.value).startsWith("'")).toBe(true);
    }
    expect(ws.getCell("C7").value).toBe("Zusage");
    expect(ws.getCell("F7").value).toBe("01.11.2026 11:00");
  });
});

describe("ICS-Export", () => {
  it("escaped Sonderzeichen, nutzt UTC und CRLF", () => {
    const ics = eventToIcs(
      {
        id: "e1",
        tenantId: "t",
        title: "Fest; mit, Komma",
        description: "Zeile 1\nZeile 2",
        location: "Saal",
        startsAt: new Date("2026-12-01T17:00:00Z"),
        endsAt: new Date("2026-12-01T19:00:00Z"),
        registrationDeadline: null,
        maxGuests: 0,
        createdBy: "u",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      new Date("2026-11-04T08:00:00Z"),
    );
    expect(ics).toContain("DTSTART:20261201T170000Z\r\n");
    expect(ics).toContain("SUMMARY:Fest\\; mit\\, Komma\r\n");
    expect(ics).toContain("DESCRIPTION:Zeile 1\\nZeile 2\r\n");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });
});

// --- API -------------------------------------------------------------------------------------

const NOW = new Date("2026-11-04T10:00:00Z");

async function setup(overrides: { now?: () => Date; failMail?: boolean; publicMax?: number } = {}) {
  const repo = new InMemoryCalendarRepository();
  const mails: MailMessage[] = [];
  const senders: Principal[] = [];
  const mod = createCalendarModule({
    repo,
    now: overrides.now ?? (() => NOW),
    publicBaseUrl: "https://app.example.org/",
    publicRateLimitMax: overrides.publicMax ?? 10,
    mail: {
      send: async (who, m) => {
        if (overrides.failMail) throw new Error("smtp down");
        senders.push(who);
        mails.push(m);
      },
    },
    // Test-Auth: Header `x-user: <mandant>:<nutzer>`
    authenticate: async (req) => {
      const h = req.headers["x-user"];
      if (typeof h !== "string") return null;
      const [tenantId, userId] = h.split(":");
      return tenantId && userId ? { tenantId, userId } : null;
    },
  });
  const app = Fastify();
  await app.register(rateLimit, { max: 1000, timeWindow: "1 minute" });
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  await app.register(async (s) => mod.register(s));
  return { app, repo, mails, senders };
}

const A = { "x-user": "tenantA:anna" };
const B = { "x-user": "tenantB:ben" };

const eventInput = {
  title: "Sommerfest",
  location: "Vereinshaus",
  startsAt: "2026-12-01T18:00",
  endsAt: "2026-12-01T22:00",
  registrationDeadline: "2026-11-20T12:00",
  maxGuests: 2,
};

async function createEvent(app: Awaited<ReturnType<typeof setup>>["app"], headers = A) {
  const res = await app.inject({
    method: "POST",
    url: "/calendar/events",
    headers,
    payload: eventInput,
  });
  expect(res.statusCode).toBe(201);
  return res.json().event as { id: string };
}

function tokenFrom(mail: MailMessage): string {
  const m = /\/antwort\/([A-Za-z0-9_-]{43})/.exec(mail.text);
  if (!m?.[1]) throw new Error("kein Token in der Mail");
  return m[1];
}

describe("Admin-Routen", () => {
  it("lehnt ohne Anmeldung ab (fail secure)", async () => {
    const { app } = await setup();
    for (const [method, url] of [
      ["GET", "/calendar/events?from=2026-12-01T00:00&to=2026-12-31T00:00"],
      ["POST", "/calendar/events"],
      ["GET", "/calendar/events/6f1c2b4e-8a3d-4e5f-9a1b-0c2d3e4f5a6b"],
      ["GET", "/calendar/events/6f1c2b4e-8a3d-4e5f-9a1b-0c2d3e4f5a6b/participants.xlsx"],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHORIZED");
    }
  });

  it("legt Events in Zürcher Zeit an und ändert sie", async () => {
    const { app } = await setup();
    const { id } = await createEvent(app);
    const get = await app.inject({ method: "GET", url: `/calendar/events/${id}`, headers: A });
    expect(get.json().event).toMatchObject({
      startsAt: "2026-12-01T17:00:00.000Z",
      startsAtLocal: "2026-12-01T18:00",
      timeZone: "Europe/Zurich",
      registrationDeadlineLocal: "2026-11-20T12:00",
    });
    expect(get.json().event).not.toHaveProperty("tenantId");

    const patch = await app.inject({
      method: "PATCH",
      url: `/calendar/events/${id}`,
      headers: A,
      payload: { title: "Winterfest", registrationDeadline: null, tenantId: "tenantB" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().event).toMatchObject({ title: "Winterfest", registrationDeadline: null });
  });

  it("prüft Zeiten und Eingaben", async () => {
    const { app } = await setup();
    const post = (payload: object) =>
      app.inject({ method: "POST", url: "/calendar/events", headers: A, payload });
    expect((await post({ ...eventInput, endsAt: "2026-12-01T17:00" })).statusCode).toBe(400);
    expect(
      (await post({ ...eventInput, registrationDeadline: "2026-12-02T10:00" })).statusCode,
    ).toBe(400);
    expect((await post({ ...eventInput, startsAt: "morgen" })).statusCode).toBe(400);
    expect((await post({ ...eventInput, title: "" })).statusCode).toBe(400);
    expect((await post({ ...eventInput, title: "a\r\nBcc: x" })).statusCode).toBe(400);
    const bad = await post({ ...eventInput, startsAt: "2026-03-29T02:30" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toBe("Ungültige Anfrage.");
  });

  it("trennt Mandanten: fremde Events sind 404 (SR-11)", async () => {
    const { app } = await setup();
    const { id } = await createEvent(app);
    for (const [method, url] of [
      ["GET", `/calendar/events/${id}`],
      ["GET", `/calendar/events/${id}/participants`],
      ["GET", `/calendar/events/${id}/participants.xlsx`],
      ["GET", `/calendar/events/${id}/event.ics`],
    ] as const) {
      expect((await app.inject({ method, url, headers: B })).statusCode, url).toBe(404);
    }
    const patch = await app.inject({
      method: "PATCH",
      url: `/calendar/events/${id}`,
      headers: B,
      payload: { title: "gekapert" },
    });
    expect(patch.statusCode).toBe(404);
    const list = await app.inject({
      method: "GET",
      url: "/calendar/events?from=2026-12-01T00:00&to=2026-12-31T00:00",
      headers: B,
    });
    expect(list.json().events).toEqual([]);
  });

  it("listet Events im Monat", async () => {
    const { app } = await setup();
    await createEvent(app);
    const list = await app.inject({
      method: "GET",
      url: "/calendar/events?from=2026-12-01T00:00&to=2027-01-01T00:00",
      headers: A,
    });
    expect(list.json().events).toHaveLength(1);
    const tooLong = await app.inject({
      method: "GET",
      url: "/calendar/events?from=2026-01-01T00:00&to=2028-01-01T00:00",
      headers: A,
    });
    expect(tooLong.statusCode).toBe(400);
  });
});

describe("Einladungen und Rückmeldungen", () => {
  async function invited() {
    const ctx = await setup();
    const { id } = await createEvent(ctx.app);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/calendar/events/${id}/invitations`,
      headers: A,
      payload: { recipients: [{ email: "Anna@Example.org", name: "Anna Muster" }] },
    });
    expect(res.json()).toEqual({ sent: ["anna@example.org"], skipped: [], failed: [] });
    const mail = ctx.mails[0]!;
    return { ...ctx, id, mail, token: tokenFrom(mail) };
  }

  it("versendet über den MailPort und speichert nur den Token-Hash", async () => {
    const { repo, mail, token, senders } = await invited();
    expect(senders).toEqual([{ tenantId: "tenantA", userId: "anna" }]);
    expect(mail.to).toEqual({ email: "anna@example.org", name: "Anna Muster" });
    expect(mail.text).toContain(`https://app.example.org/antwort/${token}`);
    expect(mail.text).toContain("01.12.2026 18:00 Uhr");
    const stored = JSON.stringify([...repo.invitations.values()]);
    expect(stored).not.toContain(token);
    expect(stored).toContain(hashToken(token));
  });

  it("erzeugt pro Einladung ein eigenes Token und überspringt Doppelte", async () => {
    const { app, mails, id } = await invited();
    const res = await app.inject({
      method: "POST",
      url: `/calendar/events/${id}/invitations`,
      headers: A,
      payload: {
        recipients: [
          { email: "anna@example.org", name: "Anna" },
          { email: "ben@example.org", name: "Ben" },
          { email: "carl@example.org", name: "Carl" },
        ],
      },
    });
    expect(res.json()).toMatchObject({ skipped: ["anna@example.org"], failed: [] });
    expect(new Set(mails.map(tokenFrom)).size).toBe(3);
  });

  it("nimmt die Einladung zurück, wenn der Versand scheitert", async () => {
    const { app, repo } = await setup({ failMail: true });
    const { id } = await createEvent(app);
    const res = await app.inject({
      method: "POST",
      url: `/calendar/events/${id}/invitations`,
      headers: A,
      payload: { recipients: [{ email: "anna@example.org", name: "Anna" }] },
    });
    expect(res.json()).toEqual({ sent: [], skipped: [], failed: ["anna@example.org"] });
    expect(repo.invitations.size).toBe(0);
  });

  it("zeigt und speichert die Antwort per Token, Teilnehmerliste live", async () => {
    const { app, token, id } = await invited();
    const view = await app.inject({ method: "GET", url: `/calendar/public/responses/${token}` });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({
      open: true,
      invitee: { name: "Anna Muster" },
      response: null,
      event: { title: "Sommerfest" },
    });

    const yes = await app.inject({
      method: "POST",
      url: `/calendar/public/responses/${token}`,
      payload: { status: "accepted", guests: 2, note: "Vegetarisch", tenantId: "x" },
    });
    expect(yes.statusCode).toBe(200);
    expect(yes.json().response).toEqual({ status: "accepted", guests: 2, note: "Vegetarisch" });

    let list = await app.inject({
      method: "GET",
      url: `/calendar/events/${id}/participants`,
      headers: A,
    });
    expect(list.json().summary).toEqual({
      invited: 1,
      accepted: 1,
      declined: 0,
      pending: 0,
      attendees: 3,
    });

    // Ändern ersetzt die alte Antwort.
    await app.inject({
      method: "POST",
      url: `/calendar/public/responses/${token}`,
      payload: { status: "declined", guests: 2 },
    });
    list = await app.inject({
      method: "GET",
      url: `/calendar/events/${id}/participants`,
      headers: A,
    });
    expect(list.json().summary).toEqual({
      invited: 1,
      accepted: 0,
      declined: 1,
      pending: 0,
      attendees: 0,
    });
    expect(list.json().participants[0]).toMatchObject({ status: "declined", guests: 0 });
  });

  it("lehnt zu viele Begleitpersonen ab", async () => {
    const { app, token } = await invited();
    const res = await app.inject({
      method: "POST",
      url: `/calendar/public/responses/${token}`,
      payload: { status: "accepted", guests: 3 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("verrät nicht, ob ein Token existiert (keine Enumeration)", async () => {
    const { app, token } = await invited();
    const wrongSameShape = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    const responses = await Promise.all(
      [wrongSameShape, "kurz", "x".repeat(43), "../etc/passwd", "a".repeat(99)].map((t) =>
        app.inject({ method: "GET", url: `/calendar/public/responses/${t}` }),
      ),
    );
    for (const r of responses) {
      expect(r.statusCode).toBe(404);
      expect(r.body).toBe(responses[0]!.body);
    }
    const post = await app.inject({
      method: "POST",
      url: `/calendar/public/responses/${wrongSameShape}`,
      payload: { status: "accepted" },
    });
    expect(post.statusCode).toBe(404);
    expect(post.body).toBe(responses[0]!.body);
  });

  it("limitiert die öffentliche Route (SR-71)", async () => {
    const { app } = await setup({ publicMax: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push(
        (await app.inject({ method: "GET", url: `/calendar/public/responses/${"a".repeat(43)}` }))
          .statusCode,
      );
    }
    expect(codes).toEqual([404, 404, 404, 429, 429]);
  });

  it("schliesst die Anmeldung nach dem Anmeldeschluss", async () => {
    let now = NOW;
    const ctx = await setup({ now: () => now });
    const { id } = await createEvent(ctx.app);
    await ctx.app.inject({
      method: "POST",
      url: `/calendar/events/${id}/invitations`,
      headers: A,
      payload: { recipients: [{ email: "anna@example.org", name: "Anna" }] },
    });
    const token = tokenFrom(ctx.mails[0]!);
    now = new Date("2026-11-20T11:01:00Z"); // 12:01 Zürcher Zeit, Frist war 12:00
    const view = await ctx.app.inject({
      method: "GET",
      url: `/calendar/public/responses/${token}`,
    });
    expect(view.json().open).toBe(false);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/calendar/public/responses/${token}`,
      payload: { status: "accepted" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  it("lädt Excel und ICS herunter", async () => {
    const { app, id } = await invited();
    const xlsx = await app.inject({
      method: "GET",
      url: `/calendar/events/${id}/participants.xlsx`,
      headers: A,
    });
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers["content-type"]).toContain("spreadsheetml.sheet");
    expect(xlsx.headers["content-disposition"]).toContain("attachment");
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe("PK");

    const ics = await app.inject({
      method: "GET",
      url: `/calendar/events/${id}/event.ics`,
      headers: A,
    });
    expect(ics.headers["content-type"]).toContain("text/calendar");
    expect(ics.body).toContain("SUMMARY:Sommerfest");
  });

  it("lädt nicht zu beendeten Events ein", async () => {
    let now = NOW;
    const ctx = await setup({ now: () => now });
    const { id } = await createEvent(ctx.app);
    now = new Date("2026-12-02T00:00:00Z");
    const res = await ctx.app.inject({
      method: "POST",
      url: `/calendar/events/${id}/invitations`,
      headers: A,
      payload: { recipients: [{ email: "anna@example.org", name: "Anna" }] },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("Repository: Löschung", () => {
  it("entfernt nur Event, Einladungen und Antworten des einen Events", async () => {
    const { app, repo } = await setup();
    const one = await createEvent(app);
    const two = await createEvent(app);
    for (const { id } of [one, two]) {
      await app.inject({
        method: "POST",
        url: `/calendar/events/${id}/invitations`,
        headers: A,
        payload: { recipients: [{ email: "anna@example.org", name: "Anna" }] },
      });
    }
    await repo.deleteEventData(one.id);
    expect([...repo.events.keys()]).toEqual([two.id]);
    expect([...repo.invitations.values()].map((i) => i.eventId)).toEqual([two.id]);
    expect(await repo.findEventIdsEndedBefore(new Date("2027-01-01"))).toEqual([two.id]);
    expect(await repo.findEventIdsEndedBefore(new Date("2026-12-01T20:59:00Z"))).toEqual([]);
  });
});
