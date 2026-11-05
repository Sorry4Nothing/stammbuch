import type { Datenbank } from "@stammbuch/db";

/** 24 Stunden nach Event-Ende (projektplan.md, 3.7). */
export const RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Der Job bekommt absichtlich nur diese zwei Operationen: Er kann damit weder Rechnungen noch
 * Buchhaltung lesen oder löschen (projektplan.md, Abschnitt 6). Die API-Implementierung
 * `CalendarRepository` (apps/api/src/modules/calendar) erfüllt diese Schnittstelle.
 */
export interface CalendarRetentionPort {
  /** IDs der Events mit `endsAt <= cutoff`, mandantenübergreifend. */
  findEventIdsEndedBefore(cutoff: Date): Promise<string[]>;
  /** Löscht Kalendereintrag, Einladungen und Zu-/Absagen des Events (eine Transaktion). */
  deleteEventData(eventId: string): Promise<void>;
}

/**
 * Löscht alle Events, deren Ende mehr als 24 Stunden zurückliegt. Ein Fehler bei einem Event
 * stoppt die anderen nicht, wird gemeldet und beim nächsten Durchlauf erneut versucht.
 * Gibt die Zahl der gelöschten Events zurück.
 */
export async function purgeEndedEvents(
  port: CalendarRetentionPort,
  now: Date,
  onError: (eventId: string, err: unknown) => void,
): Promise<number> {
  const ids = await port.findEventIdsEndedBefore(new Date(now.getTime() - RETENTION_MS));
  let deleted = 0;
  for (const id of ids) {
    try {
      await port.deleteEventData(id);
      deleted++;
    } catch (err) {
      onError(id, err);
    }
  }
  return deleted;
}

/**
 * Anbindung an PostgreSQL. `db` verbindet als Rolle `stammbuch_worker` (DATABASE_URL): Sie hat keinen
 * Tabellenzugriff, nur diese zwei Datenbankfunktionen. Rechnungen und Buchhaltung sind unerreichbar.
 */
export function postgresRetentionPort(
  db: Pick<Datenbank, "findeAbgelaufeneKalenderEvents" | "loescheKalenderEvent">,
): CalendarRetentionPort {
  return {
    findEventIdsEndedBefore: (cutoff) => db.findeAbgelaufeneKalenderEvents(cutoff),
    deleteEventData: (eventId) => db.loescheKalenderEvent(eventId),
  };
}
