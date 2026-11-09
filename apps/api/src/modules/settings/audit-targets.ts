import type { Datenbank } from "@stammbuch/db";
import { sql } from "kysely";
import type { AuditEntry } from "../../platform/index.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Kind =
  "person" | "firma" | "gruppe" | "rechnung" | "aufgabe" | "event" | "buchung" | "zahlung";

/** Welches Objekt die Aktion meint, wenn das Ziel eine ID ist. */
const kindOf = (action: string): Kind | undefined => {
  if (action === "registrierung.person") return "person";
  if (action === "registrierung.firma") return "firma";
  if (action.startsWith("buchung.")) return "buchung";
  if (action.startsWith("zuordnung.")) return "zahlung";
  if (action.startsWith("mitglied.") || /^gruppe\.(zuweisen|entfernen)$/.test(action))
    return "person";
  if (action.startsWith("firma.")) return "firma";
  if (action.startsWith("gruppe.")) return "gruppe";
  if (action.startsWith("invoice.") || action === "camt.assign") return "rechnung";
  if (action.startsWith("aufgabe.")) return "aufgabe";
  if (action.startsWith("event.")) return "event";
  return undefined;
};

type Names = Map<string, string>;
type Lookup = (db: Datenbank, tenantId: string, ids: string[]) => Promise<Names>;

/** Eine Abfrage je Objektart, immer im Mandanten (RLS und `kunde_id`). */
const lookups: Record<Kind, Lookup> = {
  person: (db, t, ids) =>
    names(db, t, (trx) =>
      sql<{ id: string; label: string }>`
        SELECT id::text, mitgliedsnr || ' ' || vorname || ' ' || nachname AS label
        FROM mitglied WHERE kunde_id = ${t}::uuid AND id = ANY(${ids}::uuid[])`.execute(trx),
    ),
  firma: (db, t, ids) =>
    names(db, t, (trx) =>
      sql<{ id: string; label: string }>`
        SELECT id::text, name AS label
        FROM firma WHERE kunde_id = ${t}::uuid AND id = ANY(${ids}::uuid[])`.execute(trx),
    ),
  gruppe: (db, t, ids) =>
    names(db, t, (trx) =>
      sql<{ id: string; label: string }>`
        SELECT id::text, name AS label
        FROM gruppe WHERE kunde_id = ${t}::uuid AND id = ANY(${ids}::uuid[])`.execute(trx),
    ),
  rechnung: (db, t, ids) =>
    names(db, t, (trx) =>
      sql<{ id: string; label: string }>`
        SELECT id::text, nummer AS label
        FROM rechnung WHERE kunde_id = ${t}::uuid AND id = ANY(${ids}::uuid[]) AND nummer IS NOT NULL`.execute(
        trx,
      ),
    ),
  aufgabe: (db, t, ids) =>
    names(db, t, (trx) =>
      sql<{ id: string; label: string }>`
        SELECT id::text, titel AS label
        FROM aufgabe WHERE kunde_id = ${t}::uuid AND id = ANY(${ids}::uuid[])`.execute(trx),
    ),
  event: (db, t, ids) =>
    names(db, t, (trx) =>
      sql<{ id: string; label: string }>`
        SELECT id::text, titel AS label
        FROM kalender_event WHERE kunde_id = ${t}::uuid AND id = ANY(${ids}::uuid[])`.execute(trx),
    ),
  buchung: (db, t, ids) =>
    names(db, t, (trx) =>
      sql<{ id: string; label: string }>`
        SELECT id::text, 'Beleg ' || belegnummer::text AS label
        FROM buchhaltung_buchung WHERE kunde_id = ${t}::uuid AND id = ANY(${ids}::uuid[])`.execute(
        trx,
      ),
    ),
  // Eine Zuordnung nennt die Zahlung (Guthaben); angezeigt wird der Beleg ihrer Buchung.
  zahlung: (db, t, ids) =>
    names(db, t, (trx) =>
      sql<{ id: string; label: string }>`
        SELECT g.id::text, 'Beleg ' || b.belegnummer::text AS label
        FROM buchhaltung_guthaben g
        JOIN buchhaltung_buchung b ON b.kunde_id = g.kunde_id AND b.id = g.buchung_id
        WHERE g.kunde_id = ${t}::uuid AND g.id = ANY(${ids}::uuid[])`.execute(trx),
    ),
};

async function names(
  db: Datenbank,
  tenantId: string,
  run: (trx: Parameters<Parameters<Datenbank["withKunde"]>[1]>[0]) => Promise<{
    rows: { id: string; label: string }[];
  }>,
): Promise<Names> {
  const { rows } = await db.withKunde(tenantId, run);
  return new Map(rows.map((r) => [r.id, r.label]));
}

/**
 * Ersetzt Objekt-IDs im Ziel durch Nummer oder Name aus dem aktuellen Bestand des Mandanten. Nicht auflösbare IDs
 * (gelöscht, andere Objektart, ohne Datenbank) werden leer, nie als rohe UUID ausgegeben. Der Eintrag selbst bleibt
 * unverändert und enthält weiterhin nur die ID (SR-50).
 */
export async function resolveTargets(
  db: Datenbank | undefined,
  tenantId: string,
  entries: AuditEntry[],
): Promise<AuditEntry[]> {
  const wanted = new Map<Kind, Set<string>>();
  for (const e of entries) {
    const kind = kindOf(e.action);
    if (!kind || !UUID.test(e.target)) continue;
    wanted.set(kind, (wanted.get(kind) ?? new Set()).add(e.target.toLowerCase()));
  }
  const found = new Map<string, string>();
  if (db) {
    await Promise.all(
      [...wanted].map(async ([kind, ids]) => {
        for (const [id, label] of await lookups[kind](db, tenantId, [...ids])) found.set(id, label);
      }),
    );
  }
  return entries.map((e) =>
    UUID.test(e.target) ? { ...e, target: found.get(e.target.toLowerCase()) ?? "" } : e,
  );
}
