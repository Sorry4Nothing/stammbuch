import { createContext, useContext } from "react";

/** Offene Aufgabe. `due` ist ein Datum JJJJ-MM-TT. */
export interface StartTask {
  id: string;
  title: string;
  due: string;
}

/** Überfälliger oder offener Posten. Beträge in Rappen (ganze Zahl). */
export interface StartOpenItem {
  id: string;
  invoiceNumber: string;
  debtor: string;
  amountCents: number;
  due: string;
}

/** Anstehender Event. `date` JJJJ-MM-TT, `time` HH:MM, `deadline` JJJJ-MM-TT oder leer. */
export interface StartEvent {
  id: string;
  title: string;
  date: string;
  time: string;
  confirmed: number;
  deadline?: string;
}

export interface StartData {
  tasks: StartTask[];
  openItems: StartOpenItem[];
  events: StartEvent[];
}

/**
 * Datenquelle der Startseite. Eine Aggregat-Route der API (Aufgaben, offene Posten mit Schuldner,
 * Events) gibt es noch nicht; bis dahin liefert der Standard leere Listen (Leer-Zustand) und Tests
 * setzen `memoryStartService` ein.
 */
export interface StartService {
  load(signal: AbortSignal): Promise<StartData>;
}

export const emptyStartService: StartService = {
  load: async () => ({ tasks: [], openItems: [], events: [] }),
};

export const StartServiceContext = createContext<StartService>(emptyStartService);

export const useStartService = () => useContext(StartServiceContext);
