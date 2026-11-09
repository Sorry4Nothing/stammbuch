import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { useAuth } from "../../auth/auth";
import { createHttpTasksService } from "./httpTasksService";
import type { Task, TaskList, TaskStatus } from "./model";

/**
 * Vertrag zwischen der Aufgabenseite und dem Backend. Umsetzung gegen die API: `httpTasksService.ts`,
 * im Speicher (Tests und Entwicklung): `memoryTasksService.ts`. Fehler als `TasksApiError` werfen.
 */
export interface TasksService {
  list(status: TaskStatus, signal?: AbortSignal): Promise<TaskList>;
  create(input: { title: string; due: string }): Promise<Task>;
  /** Erledigt eine offene Aufgabe. Aufgaben werden nie gelöscht. */
  complete(id: string): Promise<void>;
  /** Macht eine erledigte Aufgabe wieder offen («Rückgängig»). */
  reopen(id: string): Promise<void>;
}

const TasksContext = createContext<TasksService | null>(null);

/** Setzt einen Dienst für den Teilbaum (Tests, Entwicklung). Ohne Provider gilt die API. */
export function TasksProvider({
  service,
  children,
}: {
  service: TasksService;
  children: ReactNode;
}) {
  return <TasksContext.Provider value={service}>{children}</TasksContext.Provider>;
}

export function useTasks(): TasksService {
  const injected = useContext(TasksContext);
  const auth = useAuth();
  const expired = useRef(auth.markExpired);
  expired.current = auth.markExpired;
  const authService = auth.service;
  const http = useMemo(
    () =>
      createHttpTasksService({
        csrfToken: () => authService.csrfToken?.() ?? null,
        onUnauthorized: () => expired.current(),
      }),
    [authService],
  );
  return injected ?? http;
}
