export interface Task {
  id: string;
  title: string;
  /** Fälligkeit als JJJJ-MM-TT. */
  due: string;
  /** Zeitpunkt der Erledigung (ISO), nur bei erledigten Aufgaben. */
  doneAt?: string;
}

export type TaskStatus = "open" | "done";

export interface TaskList {
  /** Offene nach Fälligkeit, erledigte zuletzt erledigte zuerst. */
  items: Task[];
  /** Alle Aufgaben dieses Status; kann grösser sein als `items`. */
  total: number;
}

/** Fehler der Schnittstelle: nur der HTTP-Status, nie Text oder Inhalt der API. `400` heisst ungültige Eingabe. */
export class TasksApiError extends Error {
  constructor(readonly status: number) {
    super(`Aufgaben-API (${status})`);
  }
}

/** Längster Titel, den die API annimmt. */
export const TITLE_MAX = 200;
