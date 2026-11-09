import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { validate } from "../../lib/validate.js";
import { eventToIcs, participantsWorkbook } from "./export.js";
import type { Authenticator, Principal } from "./ports.js";
import {
  eventBody,
  eventDto,
  eventPatchBody,
  idParams,
  inviteBody,
  listQuery,
  respondBody,
  tokenParams,
} from "./schemas.js";
import { CalendarError, type CalendarService, type PublicView } from "./service.js";

export interface CalendarRouteOptions {
  service: CalendarService;
  authenticate: Authenticator;
  now: () => Date;
  /** Anfragen pro Minute und IP auf den öffentlichen Antwortrouten (SR-71). */
  publicRateLimitMax: number;
}

declare module "fastify" {
  interface FastifyRequest {
    calendarPrincipal?: Principal;
  }
}

const noStore = (reply: FastifyReply) => reply.header("cache-control", "no-store");

function publicDto(v: PublicView) {
  return {
    event: eventDto(v.event),
    open: v.open,
    invitee: v.invitee,
    response: v.response
      ? { status: v.response.status, guests: v.response.guests, note: v.response.note }
      : null,
  };
}

function who(request: FastifyRequest): Principal {
  // Der onRequest-Hook setzt den Principal oder bricht ab; fehlt er, ist das ein Programmfehler.
  if (!request.calendarPrincipal) throw new CalendarError(404, "Nicht gefunden");
  return request.calendarPrincipal;
}

/** Routen unter /calendar. Admin-Routen verlangen Anmeldung, die Antwortrouten nur das Token. */
export function registerCalendarRoutes(app: FastifyInstance, opts: CalendarRouteOptions) {
  const { service } = opts;

  app.register(
    async (admin) => {
      admin.decorateRequest("calendarPrincipal", undefined);
      // Fail secure: ohne gültige Anmeldung kein Zugriff (SR-10, SR-54).
      admin.addHook("onRequest", async (request, reply) => {
        const principal = await opts.authenticate(request).catch(() => null);
        if (!principal) {
          return reply
            .status(401)
            .send({ error: { code: "UNAUTHORIZED", message: "Nicht angemeldet." } });
        }
        request.calendarPrincipal = principal;
      });

      admin.get("/events", async (request, reply) => {
        const q = validate(listQuery, request.query);
        if (q.to <= q.from || q.to.getTime() - q.from.getTime() > 400 * 86_400_000) {
          throw new CalendarError(400, "Ungültiger Zeitraum");
        }
        const events = await service.listEvents(who(request), q);
        return noStore(reply).send({ events: events.map(eventDto) });
      });

      admin.post("/events", async (request, reply) => {
        const body = validate(eventBody, request.body);
        const event = await service.createEvent(who(request), body);
        return noStore(reply)
          .status(201)
          .send({ event: eventDto(event) });
      });

      admin.get("/events/:id", async (request, reply) => {
        const { id } = validate(idParams, request.params);
        return noStore(reply).send({ event: eventDto(await service.getEvent(who(request), id)) });
      });

      admin.patch("/events/:id", async (request, reply) => {
        const { id } = validate(idParams, request.params);
        const body = validate(eventPatchBody, request.body);
        const event = await service.updateEvent(who(request), id, body);
        return noStore(reply).send({ event: eventDto(event) });
      });

      admin.post(
        "/events/:id/invitations",
        { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
        async (request, reply) => {
          const { id } = validate(idParams, request.params);
          const body = validate(inviteBody, request.body);
          return noStore(reply).send(await service.invite(who(request), id, body.recipients));
        },
      );

      // Erneut senden und Testmail: eng begrenzt, weil jeder Aufruf Mails auslöst (SR-71).
      admin.post(
        "/events/:id/invitations/resend",
        { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
        async (request, reply) => {
          const { id } = validate(idParams, request.params);
          return noStore(reply).send(await service.resend(who(request), id));
        },
      );

      admin.post(
        "/events/:id/invitations/test",
        { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
        async (request, reply) => {
          const { id } = validate(idParams, request.params);
          await service.sendTest(who(request), id);
          return noStore(reply).status(204).send();
        },
      );

      admin.get("/events/:id/participants", async (request, reply) => {
        const { id } = validate(idParams, request.params);
        const list = await service.participants(who(request), id);
        return noStore(reply).send({
          summary: list.summary,
          participants: list.rows.map((r) => ({
            invitationId: r.invitationId,
            name: r.name,
            email: r.email,
            status: r.status,
            guests: r.guests,
            note: r.note,
            respondedAt: r.respondedAt?.toISOString() ?? null,
            invitedAt: r.invitedAt.toISOString(),
            group: r.group,
          })),
        });
      });

      admin.get("/events/:id/participants.xlsx", async (request, reply) => {
        const { id } = validate(idParams, request.params);
        const event = await service.getEvent(who(request), id);
        const list = await service.participants(who(request), id);
        const buffer = await participantsWorkbook(event, list);
        return noStore(reply)
          .header(
            "content-type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          )
          .header("content-disposition", `attachment; filename="teilnehmer-${event.id}.xlsx"`)
          .send(buffer);
      });

      admin.get("/events/:id/event.ics", async (request, reply) => {
        const { id } = validate(idParams, request.params);
        const event = await service.getEvent(who(request), id);
        return noStore(reply)
          .header("content-type", "text/calendar; charset=utf-8")
          .header("content-disposition", `attachment; filename="event-${event.id}.ics"`)
          .send(eventToIcs(event, opts.now()));
      });
    },
    { prefix: "/calendar" },
  );

  // Öffentlich, aber nur mit gültigem Token. Jeder Tokenfehler ist dieselbe 404-Antwort,
  // enge Rate-Limits bremsen das Raten (SR-05, SR-71).
  app.register(
    async (pub) => {
      const limit = {
        config: { rateLimit: { max: opts.publicRateLimitMax, timeWindow: "1 minute" } },
      };

      pub.get("/responses/:token", limit, async (request, reply) => {
        const { token } = validate(tokenParams, request.params);
        return noStore(reply).send(publicDto(await service.publicView(token)));
      });

      pub.post("/responses/:token", limit, async (request, reply) => {
        const { token } = validate(tokenParams, request.params);
        const body = validate(respondBody, request.body);
        return noStore(reply).send(publicDto(await service.publicRespond(token, body)));
      });
    },
    { prefix: "/calendar/public" },
  );
}
