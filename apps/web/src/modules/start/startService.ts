import { createContext, useContext } from "react";
import { createHttpStartService } from "./httpStartService";

/** Offene Aufgabe. `due` ist ein Datum JJJJ-MM-TT. */
export interface StartTask {
  id: string;
  title: string;
  due: string;
}

/** Überfälliger oder offener Posten. Beträge in Rappen (ganze Zahl), `currency` ISO-Code (Standard CHF). */
export interface StartOpenItem {
  id: string;
  invoiceNumber: string;
  debtor: string;
  amountCents: number;
  currency?: string;
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
 * Datenquelle der Startseite. Standard ist die API (`createHttpStartService`); Tests setzen
 * `memoryStartService` oder `emptyStartService` (Leer-Zustand) ein.
 */
export interface StartService {
  load(signal: AbortSignal): Promise<StartData>;
}

export const emptyStartService: StartService = {
  load: async () => ({ tasks: [], openItems: [], events: [] }),
};

export const StartServiceContext = createContext<StartService>(createHttpStartService());

export const useStartService = () => useContext(StartServiceContext);
