import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { notFound, unauthenticated } from "../../lib/http-error.js";
import { validate } from "../../lib/validate.js";
import type { ApiModule } from "../types.js";
import { MemoryTaskStore, PostgresTaskStore, type Task, type TaskStore } from "./store.js";

export const name = "tasks";

export interface TasksPrincipal {
  userId: string;
  tenantId: string;
}
export type TasksAuthenticator = (request: FastifyRequest) => Promise<TasksPrincipal | null>;

export interface TasksModuleOptions {
  store?: TaskStore;
  /** Standard: niemand angemeldet (fail secure). */
  authenticate?: TasksAuthenticator;
  now?: () => Date;
  /**
   * Protokolliert Anlegen, Erledigen und Wiederöffnen (SR-52). `target` ist die Aufgaben-ID, nie der Titel (SR-50).
   * Ein Fehler bricht die Anfrage ab, damit nichts unprotokolliert bleibt.
   */
  audit?: (who: TasksPrincipal, action: string, target: string) => Promise<void>;
}

/** Steuerzeichen sind in einzeiligen Feldern verboten (Header- und Log-Injektion). */
const title = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((s) => !/\p{Cc}/u.test(s));

const createBody = z.strictObject({ title, due: z.iso.date() });
const idParams = z.object({ id: z.uuid() });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  status: z.enum(["open", "done"]).default("open"),
});

/** Ausgabe: nur die Felder, die der Client braucht (SR-74), ohne Mandanten-ID. */
const dto = (t: Task) => ({ id: t.id, title: t.title, due: t.due });

const doneDto = (t: Task & { doneAt: Date }) => ({ ...dto(t), doneAt: t.doneAt.toISOString() });

/** Heutiges Datum in der Schweiz (Fälligkeiten zählen nach Ortszeit). */
const todayIn = (now: Date) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(now);

/**
 * Aufgaben des Kunden unter `/tasks`: offene Aufgaben listen, anlegen, erledigen. Die Startseite und der
 * Navigationszähler lesen sie. Jede Route verlangt eine Sitzung (SR-10, SR-54).
 */
export function createTasksModule(options: TasksModuleOptions = {}): ApiModule {
  const store = options.store ?? new MemoryTaskStore();
  const now = options.now ?? (() => new Date());
  const authenticate = options.authenticate ?? (() => Promise.resolve(null));
  const audit = options.audit ?? (async () => undefined);

  return {
    name,
    register(app: FastifyInstance) {
      const principals = new WeakMap<FastifyRequest, TasksPrincipal>();
      app.addHook("onRequest", async (request) => {
        const principal = await authenticate(request).catch(() => null);
        if (!principal) throw unauthenticated();
        principals.set(request, principal);
      });
      const who = (request: FastifyRequest) => {
        const p = principals.get(request);
        if (!p) throw unauthenticated();
        return p;
      };

      app.get("/tasks", async (request, reply) => {
        const p = who(request);
        const q = validate(listQuery, request.query);
        if (q.status === "done") {
          const done = await store.listDone(p.tenantId, q.limit);
          return reply
            .header("cache-control", "no-store")
            .send({ items: done.items.map(doneDto), total: done.total });
        }
        const open = await store.listOpen(p.tenantId, todayIn(now()), q.limit);
        return reply
          .header("cache-control", "no-store")
          .send({ items: open.items.map(dto), total: open.total, dueCount: open.dueCount });
      });

      app.post(
        "/tasks",
        { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
        async (request, reply) => {
          const p = who(request);
          const body = validate(createBody, request.body);
          const task: Task = {
            id: randomUUID(),
            tenantId: p.tenantId,
            title: body.title,
            due: body.due,
            createdBy: p.userId,
          };
          await store.create(task);
          await audit(p, "aufgabe.anlegen", task.id);
          return reply.status(201).send(dto(task));
        },
      );

      app.post(
        "/tasks/:id/done",
        { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
        async (request, reply) => {
          const p = who(request);
          const { id } = validate(idParams, request.params);
          if (!(await store.complete(p.tenantId, id, now()))) throw notFound();
          await audit(p, "aufgabe.erledigen", id);
          return reply.status(204).send();
        },
      );

      // «Rückgängig» nach dem Erledigen; nur dieselbe Mandantengrenze und dieselbe Rate wie «done».
      app.post(
        "/tasks/:id/reopen",
        { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
        async (request, reply) => {
          const p = who(request);
          const { id } = validate(idParams, request.params);
          if (!(await store.reopen(p.tenantId, id))) throw notFound();
          await audit(p, "aufgabe.wiederoeffnen", id);
          return reply.status(204).send();
        },
      );
    },
  };
}

/**
 * Standardverdrahtung: Anmeldung über `app.authenticateRequest` (nur Rolle user: der Chef-Admin sieht keine
 * Kundendaten), Speicher auf `app.db`; ohne Datenbank (nur Entwicklung und Tests) flüchtig.
 */
export const register: ApiModule["register"] = (app) =>
  createTasksModule({
    ...(app.db ? { store: new PostgresTaskStore(app.db) } : {}),
    authenticate: async (request) => {
      const auth = await app.authenticateRequest(request);
      return auth?.rolle === "user" ? { userId: auth.userId, tenantId: auth.tenantId } : null;
    },
    // Ins Protokoll des Kunden (Einstellungen, Protokoll). Akteur-E-Mail aus dem Benutzerverzeichnis.
    audit: async (who, action, target) => {
      const { audit, clock, users } = app.platform;
      const user = await users.get(who.tenantId, who.userId);
      await audit.append(who.tenantId, {
        id: randomUUID(),
        at: clock().toISOString(),
        actorId: who.userId,
        actor: user?.email ?? "",
        action,
        target,
      });
    },
  }).register(app);
