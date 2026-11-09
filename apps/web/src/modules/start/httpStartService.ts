import { createHttpCalendarService } from "../kalender/httpCalendarService";
import type { CalendarService } from "../kalender/calendarService";
import { addDays, dayOf, localOf, timeOf } from "../kalender/time";
import type { StartData, StartEvent, StartOpenItem, StartService, StartTask } from "./startService";

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null;
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Wie viele Posten die Startseite höchstens lädt (Höchstwert der API). */
const OPEN_ITEMS_LIMIT = 500;
/** Anstehende Events: so weit voraus, höchstens so viele. */
const EVENT_DAYS = 90;
const EVENT_COUNT = 10;

/** Fehler der Schnittstelle. `status` ist der HTTP-Status, `0` bei Netzwerkfehlern. Der Text der API gelangt nie in die Oberfläche. */
export class StartApiError extends Error {
  constructor(readonly status: number) {
    super(`Startseite-API (${status})`);
  }
}

/** Liest eine Route der API (nur GET, gleiche Origin, Sitzung im HttpOnly-Cookie). */
export async function getJson(
  fetchFn: typeof fetch,
  path: string,
  signal?: AbortSignal,
): Promise<Json> {
  let res: Response;
  try {
    res = await fetchFn(path, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new StartApiError(0);
  }
  if (!res.ok) throw new StartApiError(res.status);
  const body: unknown = await res.json().catch(() => null);
  if (!isRecord(body)) throw new StartApiError(res.status);
  return body;
}

const taskOf = (r: Json): StartTask => ({
  id: str(r["id"]),
  title: str(r["title"]),
  due: str(r["due"]),
});

const itemOf = (r: Json): StartOpenItem => ({
  id: str(r["id"]),
  invoiceNumber: str(r["number"]),
  debtor: str(r["debtor"]),
  amountCents: num(r["openCents"]),
  currency: str(r["currency"]) || "CHF",
  due: str(r["dueDate"]),
});

/**
 * `StartService` gegen die API: Aufgaben (`/tasks`), offene Posten mit Schuldner (`/invoices/open-items`)
 * und anstehende Events samt Zusagen (`/calendar/events`, `/calendar/events/:id/participants`). Schlägt eine
 * Quelle fehl, schlägt das Laden fehl: die Seite zeigt den Fehlerzustand statt unvollständiger Zahlen.
 */
export function createHttpStartService(
  fetchFn: typeof fetch = (...args) => fetch(...args),
  calendar: CalendarService = createHttpCalendarService(fetchFn),
  now: () => number = Date.now,
): StartService {
  return {
    async load(signal): Promise<StartData> {
      const from = localOf(now());
      const to = `${addDays(dayOf(from), EVENT_DAYS)}T00:00`;
      const [tasks, items, events] = await Promise.all([
        getJson(fetchFn, "/tasks?limit=200", signal),
        getJson(fetchFn, `/invoices/open-items?limit=${OPEN_ITEMS_LIMIT}`, signal),
        calendar.listEvents(from, to, signal).then((all) =>
          Promise.all(
            all.slice(0, EVENT_COUNT).map(async (e): Promise<StartEvent> => {
              const { summary } = await calendar.participants(e.id);
              return {
                id: e.id,
                title: e.title,
                date: dayOf(e.startsAtLocal),
                time: timeOf(e.startsAtLocal),
                confirmed: summary.accepted,
                ...(e.registrationDeadlineLocal
                  ? { deadline: dayOf(e.registrationDeadlineLocal) }
                  : {}),
              };
            }),
          ),
        ),
      ]);
      return {
        tasks: list(tasks["items"]).map(taskOf),
        openItems: list(items["items"]).map(itemOf),
        events,
      };
    },
  };
}
