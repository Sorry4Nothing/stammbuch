import { createContext, useContext, useEffect, useRef, useState } from "react";
import { getJson } from "../modules/start/httpStartService";
import { tp } from "../i18n";

/** Zähler eines Moduls in der Seitenleiste; `label` ist der Text für Screenreader («3 überfällige Rechnungen»). */
export interface NavCount {
  count: number;
  label: string;
}

/** Zähler je Modul-ID. Fehlt ein Modul, zeigt die Seitenleiste nichts. */
export type NavCounts = Record<string, NavCount>;

export interface NavCountersService {
  load(signal: AbortSignal): Promise<NavCounts>;
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;

/**
 * Zähler gegen die API: fällige Aufgaben (Startseite), überfällige Rechnungen (Rechnungen) und ungelesene Mails
 * (Mail). Ein Zähler, dessen Quelle nicht antwortet, fehlt einfach; die Seitenleiste zeigt nie eine geschätzte
 * Zahl. Die Mailzahl puffert der Server eine Minute (kein IMAP-Abruf pro Seitenansicht); ohne Zahl (`null`,
 * kein Konto antwortet) bleibt der Zähler weg.
 */
export function createHttpNavCounters(
  fetchFn: typeof fetch = (...args) => fetch(...args),
): NavCountersService {
  return {
    async load(signal) {
      const [tasks, items, mail] = await Promise.allSettled([
        getJson(fetchFn, "/tasks?limit=1", signal),
        getJson(fetchFn, "/invoices/open-items?limit=1", signal),
        getJson(fetchFn, "/mail/unread-count", signal),
      ]);
      const out: NavCounts = {};
      const due = tasks.status === "fulfilled" ? num(tasks.value["dueCount"]) : undefined;
      if (due !== undefined) out["start"] = { count: due, label: tp("shell.count.tasks", due) };
      const overdue = items.status === "fulfilled" ? num(items.value["overdue"]) : undefined;
      if (overdue !== undefined) {
        out["invoices"] = { count: overdue, label: tp("shell.count.invoices", overdue) };
      }
      const unread = mail.status === "fulfilled" ? num(mail.value["unread"]) : undefined;
      if (unread !== undefined)
        out["mail"] = { count: unread, label: tp("shell.count.mail", unread) };
      return out;
    },
  };
}

/** Keine Zähler (Tests und Entwicklung ohne API). */
export const emptyNavCounters: NavCountersService = { load: async () => ({}) };

export const NavCountersContext = createContext<NavCountersService>(createHttpNavCounters());

/** Frühestens nach so vielen Millisekunden fragt die Seitenleiste erneut. */
export const NAV_COUNTERS_MIN_INTERVAL_MS = 60_000;

/**
 * Lädt die Zähler beim Start und bei jedem Wechsel von `trigger` (z. B. aktiver Tab), höchstens einmal pro
 * Minute. Bewusst kein Zeitgeber im Hintergrund: Anfragen halten die Sitzung wach und würden die Leerlaufsperre
 * aushebeln (SR-02). Fehler lassen den letzten Stand stehen.
 */
export function useNavCounts(trigger: string | undefined): NavCounts {
  const service = useContext(NavCountersContext);
  const [counts, setCounts] = useState<NavCounts>({});
  const lastLoad = useRef(0);
  const unmounted = useRef(new AbortController());
  // Erst beim Entfernen der Seitenleiste abbrechen, nicht bei jedem Auslöser (sonst bliebe die Anfrage unbeantwortet).
  useEffect(() => {
    const ctl = (unmounted.current = new AbortController());
    return () => {
      ctl.abort();
      lastLoad.current = 0; // StrictMode lädt dann erneut
    };
  }, []);
  useEffect(() => {
    const at = Date.now();
    if (at - lastLoad.current < NAV_COUNTERS_MIN_INTERVAL_MS) return;
    lastLoad.current = at;
    const signal = unmounted.current.signal;
    service.load(signal).then(
      (c) => !signal.aborted && setCounts(c),
      () => undefined,
    );
  }, [service, trigger]);
  return counts;
}
