import type { Datenbank } from "@stammbuch/db";

export interface Task {
  id: string;
  tenantId: string;
  title: string;
  /** Fälligkeit als JJJJ-MM-TT. */
  due: string;
  createdBy: string;
}

export interface OpenTasks {
  /** Die ersten offenen Aufgaben nach Fälligkeit, dann Titel. */
  items: Task[];
  /** Alle offenen Aufgaben. */
  total: number;
  /** Davon heute oder früher fällig. */
  dueCount: number;
}

/**
 * Persistenz der Aufgaben. Jede Methode ist auf den Mandanten begrenzt (SR-11): eine ID aus einem fremden
 * Mandanten verhält sich wie «nicht vorhanden». Aufgaben werden erledigt, nie gelöscht.
 */
export interface TaskStore {
  create(task: Task): Promise<void>;
  listOpen(tenantId: string, today: string, limit: number): Promise<OpenTasks>;
  /** `false`, wenn es die offene Aufgabe in diesem Mandanten nicht gibt. */
  complete(tenantId: string, id: string, at: Date): Promise<boolean>;
}

const byDue = (a: Task, b: Task) =>
  a.due.localeCompare(b.due) || a.title.localeCompare(b.title, "de-CH");

/** Flüchtiger Speicher für Tests und Entwicklung ohne Datenbank. */
export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, Task & { doneAt: Date | null }>();

  async create(task: Task) {
    this.tasks.set(task.id, { ...task, doneAt: null });
  }

  async listOpen(tenantId: string, today: string, limit: number): Promise<OpenTasks> {
    const open = [...this.tasks.values()]
      .filter((t) => t.tenantId === tenantId && !t.doneAt)
      .sort(byDue);
    return {
      items: open.slice(0, limit).map((t) => ({
        id: t.id,
        tenantId: t.tenantId,
        title: t.title,
        due: t.due,
        createdBy: t.createdBy,
      })),
      total: open.length,
      dueCount: open.filter((t) => t.due <= today).length,
    };
  }

  async complete(tenantId: string, id: string, at: Date) {
    const t = this.tasks.get(id);
    if (!t || t.tenantId !== tenantId || t.doneAt) return false;
    t.doneAt = at;
    return true;
  }
}

/** PostgreSQL: jede Abfrage in `withKunde(tenantId)`, Row-Level-Security trennt die Kunden zusätzlich (SR-11). */
export class PostgresTaskStore implements TaskStore {
  constructor(private readonly db: Datenbank) {}

  async create(t: Task) {
    await this.db.withKunde(t.tenantId, (trx) =>
      trx
        .insertInto("aufgabe")
        .values({
          id: t.id,
          kunde_id: t.tenantId,
          titel: t.title,
          faellig_am: t.due,
          erstellt_von: t.createdBy,
        })
        .execute(),
    );
  }

  async listOpen(tenantId: string, today: string, limit: number): Promise<OpenTasks> {
    return this.db.withKunde(tenantId, async (trx) => {
      const open = () =>
        trx.selectFrom("aufgabe").where("kunde_id", "=", tenantId).where("erledigt_am", "is", null);
      const [rows, counts] = await Promise.all([
        open()
          .select(["id", "titel", "faellig_am", "erstellt_von"])
          .orderBy("faellig_am")
          .orderBy("titel")
          .orderBy("id")
          .limit(limit)
          .execute(),
        open()
          .select((eb) => [
            eb.fn.countAll<string>().as("total"),
            eb.fn.countAll<string>().filterWhere("faellig_am", "<=", today).as("due"),
          ])
          .executeTakeFirstOrThrow(),
      ]);
      return {
        items: rows.map((r) => ({
          id: r.id,
          tenantId,
          title: r.titel,
          due: r.faellig_am,
          createdBy: r.erstellt_von,
        })),
        total: Number(counts.total),
        dueCount: Number(counts.due),
      };
    });
  }

  async complete(tenantId: string, id: string, at: Date) {
    const res = await this.db.withKunde(tenantId, (trx) =>
      trx
        .updateTable("aufgabe")
        .set({ erledigt_am: at })
        .where("id", "=", id)
        .where("kunde_id", "=", tenantId)
        .where("erledigt_am", "is", null)
        .executeTakeFirst(),
    );
    return res.numUpdatedRows > 0n;
  }
}
