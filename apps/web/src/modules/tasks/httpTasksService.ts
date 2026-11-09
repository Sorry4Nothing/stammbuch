import { TasksApiError, type Task, type TaskList, type TaskStatus } from "./model";
import type { TasksService } from "./service";

interface Options {
  /** CSRF-Token der Sitzung für schreibende Anfragen. */
  csrfToken: () => string | null;
  /** Wird bei 401 aufgerufen (Sitzung abgelaufen). */
  onUnauthorized: () => void;
  fetchFn?: typeof fetch;
}

/** Höchstwert der API je Abfrage. */
const LIMIT = 200;

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null;
const str = (v: unknown) => (typeof v === "string" ? v : "");

const taskOf = (r: unknown): Task | null => {
  if (!isRecord(r) || !str(r["id"]) || !str(r["title"])) return null;
  const doneAt = str(r["doneAt"]);
  return {
    id: str(r["id"]),
    title: str(r["title"]),
    due: str(r["due"]),
    ...(doneAt ? { doneAt } : {}),
  };
};

/**
 * `TasksService` gegen die API (`/tasks`, gleiche Origin, Cookie-Sitzung). Schreibende Anfragen tragen das
 * CSRF-Token. Fehler enthalten nur den Status, nie Text der API.
 */
export function createHttpTasksService(options: Options): TasksService {
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function send(
    method: "GET" | "POST",
    path: string,
    payload?: unknown,
    signal?: AbortSignal,
  ) {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    const token = options.csrfToken();
    if (token && method !== "GET") headers["X-CSRF-Token"] = token;
    let res: Response;
    try {
      res = await fetchFn(path, {
        method,
        headers,
        credentials: "same-origin",
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new TasksApiError(0);
    }
    if (res.status === 401) options.onUnauthorized();
    if (!res.ok) throw new TasksApiError(res.status);
    return res.status === 204 ? null : await res.json().catch(() => null);
  }

  return {
    async list(status: TaskStatus, signal): Promise<TaskList> {
      const body = await send("GET", `/tasks?status=${status}&limit=${LIMIT}`, undefined, signal);
      if (!isRecord(body) || !Array.isArray(body["items"])) throw new TasksApiError(200);
      const items = body["items"].map(taskOf).filter((t): t is Task => t !== null);
      const total = body["total"];
      return { items, total: typeof total === "number" ? total : items.length };
    },

    async create(input) {
      const task = taskOf(await send("POST", "/tasks", input));
      if (!task) throw new TasksApiError(201);
      return task;
    },

    async complete(id) {
      await send("POST", `/tasks/${encodeURIComponent(id)}/done`);
    },
  };
}
