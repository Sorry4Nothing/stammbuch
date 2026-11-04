import rateLimit from "@fastify/rate-limit";
import { Datenbank } from "@stammbuch/db";
import { createTestDatabase, withCredentials } from "@stammbuch/db/testing";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorHandler, notFoundHandler } from "../../lib/errors.js";
import { type CalendarEvent, type EventResponse, type Invitation, hashToken } from "./domain.js";
import { createCalendarModule } from "./index.js";
import type { MailMessage } from "./ports.js";
import { PostgresCalendarRepository } from "./postgres.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const userA = "aaaaaaaa-0000-4000-8000-000000000001";
const userB = "bbbbbbbb-0000-4000-8000-000000000001";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const at = (iso: string) => new Date(iso);
const event = (n: number, tenantId = A, createdBy = userA): CalendarEvent => ({
  id: uuid(n),
  tenantId,
  title: `Event ${n}`,
  description: "Beschreibung",
  location: "Saal",
  startsAt: at("2026-12-01T17:00:00Z"),
  endsAt: at("2026-12-01T20:00:00Z"),
  registrationDeadline: null,
  maxGuests: 2,
  createdBy,
  createdAt: at("2026-11-01T10:00:00Z"),
  updatedAt: at("2026-11-01T10:00:00Z"),
});
const invitation = (n: number, e: CalendarEvent, email: string): Invitation => ({
  id: uuid(n),
  tenantId: e.tenantId,
  eventId: e.id,
  email,
  name: "Anna",
  tokenHash: hashToken(`token-${n}`),
  createdAt: at("2026-11-02T10:00:00Z"),
});
const wholeYear = { from: at("2026-01-01T00:00:00Z"), to: at("2027-01-01T00:00:00Z"), limit: 50 };

describe("PostgresCalendarRepository (echte Datenbank)", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let owner: pg.Client;
  let db: Datenbank;
  let repo: PostgresCalendarRepository;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject("adminUrl"), inject("templateDb"));
    owner = new pg.Client({ connectionString: testDb.adminUrl });
    await owner.connect();
    await owner.query(`INSERT INTO kunde (id, name) VALUES ('${A}', 'A'), ('${B}', 'B')`);
    await owner.query(
      `INSERT INTO benutzer (id, kunde_id, email, name, passwort_hash) VALUES
        ('${userA}', '${A}', 'a@example.test', 'A', 'h'),
        ('${userB}', '${B}', 'b@example.test', 'B', 'h')`,
    );
    db = new Datenbank(withCredentials(testDb.adminUrl, "stammbuch_app", inject("appPassword")));
    repo = new PostgresCalendarRepository(db);
  });

  afterAll(async () => {
    await db.close();
    await owner.end();
    await testDb.drop();
  });

  it("speichert, liest und ändert Events; Zeiträume und Reihenfolge stimmen", async () => {
    const e1 = { ...event(1), registrationDeadline: at("2026-11-20T11:00:00Z") };
    const e2 = {
      ...event(2),
      startsAt: at("2026-12-05T17:00:00Z"),
      endsAt: at("2026-12-05T20:00:00Z"),
    };
    await repo.insertEvent(e2);
    await repo.insertEvent(e1);

    expect(await repo.getEvent(A, e1.id)).toEqual(e1);
    const range = { from: at("2026-12-01T00:00:00Z"), to: at("2026-12-31T00:00:00Z"), limit: 10 };
    expect((await repo.listEvents(A, range)).map((e) => e.id)).toEqual([e1.id, e2.id]);
    expect((await repo.listEvents(A, { ...range, limit: 1 })).map((e) => e.id)).toEqual([e1.id]);
    expect(await repo.listEvents(A, { ...range, to: at("2026-12-02T00:00:00Z") })).toHaveLength(1);

    await repo.updateEvent({
      ...e1,
      title: "Neu",
      registrationDeadline: null,
      updatedAt: at("2026-11-03T10:00:00Z"),
    });
    expect(await repo.getEvent(A, e1.id)).toMatchObject({
      title: "Neu",
      registrationDeadline: null,
    });
    await expect(repo.updateEvent(event(99))).rejects.toThrow("Event existiert nicht");
  });

  it("trennt Mandanten: B sieht, ändert und beschreibt nichts von A", async () => {
    const e = event(10);
    await repo.insertEvent(e);
    expect(await repo.getEvent(B, e.id)).toBeNull();
    expect(await repo.listEvents(B, wholeYear)).toEqual([]);
    await expect(repo.updateEvent({ ...e, tenantId: B, createdBy: userB })).rejects.toThrow(
      "Event existiert nicht",
    );
    expect((await repo.getEvent(A, e.id))?.title).toBe("Event 10");

    await repo.insertInvitation(invitation(11, e, "x@example.test"));
    expect(await repo.listInvitations(B, e.id)).toEqual([]);
    // Fremde Einladung löschen: wirkungslos.
    await repo.deleteInvitation(B, uuid(11));
    expect(await repo.listInvitations(A, e.id)).toHaveLength(1);
    // Einladung zum Event von A unter dem Mandanten B: abgelehnt.
    await expect(
      repo.insertInvitation({ ...invitation(13, e, "y@example.test"), tenantId: B }),
    ).rejects.toThrow();
    // Event von A auf Mandant B anlegen, aber mit Benutzer von A: abgelehnt.
    await expect(repo.insertEvent({ ...event(12), tenantId: B })).rejects.toThrow();
  });

  it("löst Token ohne Mandant auf und ersetzt Antworten pro Einladung", async () => {
    const e = event(20);
    await repo.insertEvent(e);
    const i = invitation(21, e, "anna@example.test");
    await repo.insertInvitation(i);

    expect(await repo.getInvitationByTokenHash(i.tokenHash)).toEqual(i);
    expect(await repo.getInvitationByTokenHash(hashToken("unbekannt"))).toBeNull();
    expect((await repo.listInvitations(A, e.id))[0]).toEqual(i);
    // Dieselbe Adresse zweimal pro Event: die Datenbank verhindert es.
    await expect(repo.insertInvitation(invitation(22, e, "anna@example.test"))).rejects.toThrow();

    const antwort = (
      n: number,
      status: EventResponse["status"],
      guests: number,
    ): EventResponse => ({
      id: uuid(n),
      tenantId: A,
      eventId: e.id,
      invitationId: i.id,
      status,
      guests,
      note: "Notiz",
      respondedAt: at("2026-11-03T10:00:00Z"),
    });
    await repo.upsertResponse(antwort(30, "accepted", 2));
    await repo.upsertResponse(antwort(31, "declined", 0));
    const alle = await repo.listResponses(A, e.id);
    expect(alle).toHaveLength(1);
    expect(alle[0]).toMatchObject({ status: "declined", guests: 0, invitationId: i.id });
    expect(await repo.listResponses(B, e.id)).toEqual([]);
  });

  it("Routen: Einladen, Antworten per Token, Teilnehmerliste; B sieht nichts", async () => {
    const mails: MailMessage[] = [];
    const now = () => at("2026-11-04T10:00:00Z");
    const build = async (mail: (m: MailMessage) => Promise<void>) => {
      const mod = createCalendarModule({
        repo,
        now,
        publicBaseUrl: "https://app.example.org",
        mail: { send: mail },
        // Test-Auth: Header `x-user: <mandant>:<nutzer>`
        authenticate: async (req) => {
          const h = req.headers["x-user"];
          const [tenantId, userId] = typeof h === "string" ? h.split(":") : [];
          return tenantId && userId ? { tenantId, userId } : null;
        },
      });
      const app = Fastify();
      await app.register(rateLimit, { max: 1000, timeWindow: "1 minute" });
      app.setErrorHandler(errorHandler);
      app.setNotFoundHandler(notFoundHandler);
      await app.register(async (s) => mod.register(s));
      return app;
    };
    const app = await build(async (m) => void mails.push(m));
    const ha = { "x-user": `${A}:${userA}` };
    const hb = { "x-user": `${B}:${userB}` };

    const created = await app.inject({
      method: "POST",
      url: "/calendar/events",
      headers: ha,
      payload: {
        title: "Fest",
        location: "",
        startsAt: "2026-12-01T18:00",
        endsAt: "2026-12-01T22:00",
        maxGuests: 1,
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().event.id as string;

    const invited = await app.inject({
      method: "POST",
      url: `/calendar/events/${id}/invitations`,
      headers: ha,
      payload: { recipients: [{ email: "Anna@Example.test", name: "Anna" }] },
    });
    expect(invited.json()).toEqual({ sent: ["anna@example.test"], skipped: [], failed: [] });
    const token = /\/antwort\/([A-Za-z0-9_-]{43})/.exec(mails[0]!.text)![1]!;

    const answer = await app.inject({
      method: "POST",
      url: `/calendar/public/responses/${token}`,
      payload: { status: "accepted", guests: 1, note: "Freue mich" },
    });
    expect(answer.statusCode).toBe(200);
    const view = await app.inject({ method: "GET", url: `/calendar/public/responses/${token}` });
    expect(view.json().response).toEqual({ status: "accepted", guests: 1, note: "Freue mich" });

    const list = await app.inject({
      method: "GET",
      url: `/calendar/events/${id}/participants`,
      headers: ha,
    });
    expect(list.json().summary).toMatchObject({ invited: 1, accepted: 1, attendees: 2 });
    for (const url of [`/calendar/events/${id}`, `/calendar/events/${id}/participants`]) {
      expect((await app.inject({ method: "GET", url, headers: hb })).statusCode).toBe(404);
    }
    await app.close();

    // Eine fehlgeschlagene Mail nimmt die Einladung zurück (Löschen mit Mandant).
    const failing = await build(() => Promise.reject(new Error("smtp")));
    const r = await failing.inject({
      method: "POST",
      url: `/calendar/events/${id}/invitations`,
      headers: ha,
      payload: { recipients: [{ email: "ben@example.test", name: "Ben" }] },
    });
    expect(r.json().failed).toEqual(["ben@example.test"]);
    expect(await repo.listInvitations(A, id)).toHaveLength(1);
    await failing.close();
  });
});
