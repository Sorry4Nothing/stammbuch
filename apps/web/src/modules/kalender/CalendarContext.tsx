import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAuth } from "../../auth/auth";
import type { CalendarService } from "./calendarService";
import { createHttpCalendarService } from "./httpCalendarService";

interface CalendarEnv {
  service: CalendarService;
  /** Aktuelle Zeit in Millisekunden. */
  now: number;
}

const CalendarContext = createContext<CalendarEnv | null>(null);

interface ProviderProps {
  /** Ohne Angabe: Dienst gegen die API. Tests und die Entwicklung übergeben `createMemoryCalendarService()`. */
  service?: CalendarService;
  /** Feste Uhrzeit für Tests. */
  now?: number;
  children: ReactNode;
}

export function CalendarProvider({ service, now, children }: ProviderProps) {
  const auth = useAuth();
  const { markExpired } = auth;
  const http = useMemo(
    () => service ?? createHttpCalendarService(undefined, markExpired),
    [service, markExpired],
  );
  const value = useMemo<CalendarEnv>(
    () => ({ service: http, now: now ?? auth.now }),
    [http, now, auth.now],
  );
  return <CalendarContext.Provider value={value}>{children}</CalendarContext.Provider>;
}

export function useCalendar(): CalendarEnv {
  const ctx = useContext(CalendarContext);
  if (!ctx) throw new Error("useCalendar braucht einen CalendarProvider");
  return ctx;
}
