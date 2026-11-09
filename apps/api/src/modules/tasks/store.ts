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

export interface DoneTasks {
  /** Die zuletzt erledigten Aufgaben, neueste zuerst. */
  items: (Task & { doneAt: Date })[];
  /** Alle erledigten Aufgaben. */
  total: number;
}

/**
 * Persistenz der Aufgaben. Jede Methode ist auf den Mandanten begrenzt (SR-11): eine ID aus einem fremden
 * Mandanten verhält sich wie «nicht vorhanden». Aufgaben werden erledigt, nie gelöscht.
 */
export interface TaskStore {
  create(task: Task): Promise<void>;
  listOpen(tenantId: string, today: string, limit: number): Promise<OpenTasks>;
  listDone(tenantId: string, limit: number): Promise<DoneTasks>;
  /** `false`, wenn es die offene Aufgabe in diesem Mandanten nicht gibt. */
  complete(tenantId: string, id: string, at: Date): Promise<boolean>;
  /** Macht eine erledigte Aufgabe wieder offen. `false`, wenn es die erledigte Aufgabe nicht gibt. */
  reopen(tenantId: string, id: string): Promise<boolean>;
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

  async listDone(tenantId: string, limit: number): Promise<DoneTasks> {
    const done = [...this.tasks.values()]
      .filter((t): t is Task & { doneAt: Date } => t.tenantId === tenantId && !!t.doneAt)
      .sort((a, b) => b.doneAt.getTime() - a.doneAt.getTime() || byDue(a, b));
    return { items: done.slice(0, limit).map((t) => ({ ...t })), total: done.length };
  }

  async complete(tenantId: string, id: string, at: Date) {
    const t = this.tasks.get(id);
    if (!t || t.tenantId !== tenantId || t.doneAt) return false;
    t.doneAt = at;
    return true;
  }

  async reopen(tenantId: string, id: string) {
    const t = this.tasks.get(id);
    if (!t || t.tenantId !== tenantId || !t.doneAt) return false;
    t.doneAt = null;
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

  async listDone(tenantId: string, limit: number): Promise<DoneTasks> {
    return this.db.withKunde(tenantId, async (trx) => {
      const done = () =>
        trx
          .selectFrom("aufgabe")
          .where("kunde_id", "=", tenantId)
          .where("erledigt_am", "is not", null);
      const [rows, count] = await Promise.all([
        done()
          .select(["id", "titel", "faellig_am", "erstellt_von", "erledigt_am"])
          .orderBy("erledigt_am", "desc")
          .orderBy("id")
          .limit(limit)
          .execute(),
        done()
          .select((eb) => eb.fn.countAll<string>().as("total"))
          .executeTakeFirstOrThrow(),
      ]);
      return {
        items: rows.flatMap((r) =>
          r.erledigt_am
            ? [
                {
                  id: r.id,
                  tenantId,
                  title: r.titel,
                  due: r.faellig_am,
                  createdBy: r.erstellt_von,
                  doneAt: r.erledigt_am,
                },
              ]
            : [],
        ),
        total: Number(count.total),
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

  async reopen(tenantId: string, id: string) {
    const res = await this.db.withKunde(tenantId, (trx) =>
      trx
        .updateTable("aufgabe")
        .set({ erledigt_am: null })
        .where("id", "=", id)
        .where("kunde_id", "=", tenantId)
        .where("erledigt_am", "is not", null)
        .executeTakeFirst(),
    );
    return res.numUpdatedRows > 0n;
  }
}
