import { TasksApiError, type Task, type TaskStatus } from "./model";
import type { TasksService } from "./service";

/** Aufgaben im Speicher für Tests und Entwicklung ohne API. Gleiche Sortierung wie die API. */
export function createMemoryTasksService(
  seed: Task[] = [],
  now: () => Date = () => new Date(),
): TasksService {
  let nextId = 1;
  const tasks = new Map(seed.map((t) => [t.id, { ...t }]));
  return {
    async list(status: TaskStatus) {
      const all = [...tasks.values()].filter((t) => Boolean(t.doneAt) === (status === "done"));
      all.sort(
        status === "done"
          ? (a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? "")
          : (a, b) => a.due.localeCompare(b.due) || a.title.localeCompare(b.title, "de-CH"),
      );
      return { items: all.map((t) => ({ ...t })), total: all.length };
    },
    async create(input) {
      const task: Task = { id: `neu-${nextId++}`, title: input.title.trim(), due: input.due };
      tasks.set(task.id, task);
      return { ...task };
    },
    async complete(id) {
      const task = tasks.get(id);
      if (!task || task.doneAt) throw new TasksApiError(404);
      task.doneAt = now().toISOString();
    },
    async reopen(id) {
      const task = tasks.get(id);
      if (!task || !task.doneAt) throw new TasksApiError(404);
      delete task.doneAt;
    },
  };
}
