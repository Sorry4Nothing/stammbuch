import { sql } from "kysely";
import type { Datenbank } from "@stammbuch/db";
import type { SecretBox } from "./crypto.js";

/** Was ein Rotationslauf meldet. Nie Schlüssel oder Klartext. */
export interface RotationResult {
  rotated: number;
  /** IDs, die sich nicht umschlüsseln liessen (Schlüssel fehlt, Daten beschädigt). */
  failed: string[];
  aborted: boolean;
}

/** Ein verschlüsseltes Geheimnis; die ID ist zugleich der gebundene Kontext (AAD). */
export interface RotationRow {
  id: string;
  tenantId: string;
  enc: string;
}

/** Quelle eines Rotationslaufs: seitenweise lesen, per Compare-and-swap schreiben. */
export interface RotationSource {
  /** Zeilen, die nicht mit `currentKeyId` verschlüsselt sind, aufsteigend nach ID, ab `after` (exklusiv). */
  list(currentKeyId: string, after: string | null, limit: number): Promise<RotationRow[]>;
  /** False = inzwischen geändert, nichts überschrieben. */
  replace(tenantId: string, id: string, expectedEnc: string, newEnc: string): Promise<boolean>;
}

/**
 * Rotationslauf über alle Mandanten (SR-30). Wiederaufnehmbar: umgeschlüsselte Zeilen fallen aus der Abfrage, ein
 * Abbruch (Signal, Fehler, Absturz) verliert nichts, der nächste Lauf macht beim Rest weiter. Was sich nicht
 * entschlüsseln lässt, kommt in `failed` (nur die ID) und hält die anderen nicht auf. Geschrieben wird per
 * Compare-and-swap: eine gleichzeitige Änderung des Benutzers bleibt erhalten. Datenbankfehler brechen den Lauf ab.
 */
export async function rotateAll(
  box: SecretBox,
  source: RotationSource,
  signal?: AbortSignal,
): Promise<RotationResult> {
  const result: RotationResult = { rotated: 0, failed: [], aborted: false };
  const page = 100;
  let after: string | null = null;
  for (;;) {
    const rows = await source.list(box.currentKeyId, after, page);
    for (const r of rows) {
      if (signal?.aborted) return { ...result, aborted: true };
      after = r.id;
      let enc: string;
      try {
        enc = box.rotate(r.enc, r.id);
      } catch {
        result.failed.push(r.id);
        continue;
      }
      if (await source.replace(r.tenantId, r.id, r.enc, enc)) result.rotated++;
    }
    if (rows.length < page) return result;
  }
}

export type RotationKind = "mail" | "totp";

/** Funktionsnamen je Art; feste Namen, nie Eingaben. */
const functions = {
  mail: { list: "mail_konten_zur_rotation", replace: "mail_konto_geheimnis_ersetzen" },
  totp: { list: "totp_zur_rotation", replace: "totp_geheimnis_ersetzen" },
} as const;

type Row = { id: string; kunde_id: string; geheimnis_enc: string };

/**
 * PostgreSQL-Quelle. Ohne `actorId` die Funktionen der Rolle `stammbuch_worker`; mit `actorId` (Chef-Admin aus der
 * Sitzung) die Varianten `…_chef` der Rolle `stammbuch_app`, die den Akteur in der Datenbank prüfen. Mit der jeweils
 * anderen Rolle scheitern sie an den Rechten (fail secure).
 */
export function pgRotationSource(
  db: Datenbank,
  kind: RotationKind,
  actorId: string | null,
): RotationSource {
  const f = functions[kind];
  return {
    async list(currentKeyId, after, limit) {
      const { rows } = actorId
        ? await sql<Row>`SELECT * FROM ${sql.id(`${f.list}_chef`)}(${actorId}::uuid, ${currentKeyId}, ${after}::uuid, ${limit}::integer)`.execute(
            db.kysely,
          )
        : await sql<Row>`SELECT id, kunde_id, geheimnis_enc FROM ${sql.id(f.list)}(${currentKeyId}, ${after}::uuid, ${limit}::integer)`.execute(
            db.kysely,
          );
      return rows.map((r) => ({ id: r.id, tenantId: r.kunde_id, enc: r.geheimnis_enc }));
    },
    async replace(tenantId, id, expectedEnc, newEnc) {
      const { rows } = await (
        actorId
          ? sql<{
              ok: boolean;
            }>`SELECT ${sql.id(`${f.replace}_chef`)}(${actorId}::uuid, ${tenantId}::uuid, ${id}::uuid, ${expectedEnc}, ${newEnc}) AS ok`
          : sql<{
              ok: boolean;
            }>`SELECT ${sql.id(f.replace)}(${tenantId}::uuid, ${id}::uuid, ${expectedEnc}, ${newEnc}) AS ok`
      ).execute(db.kysely);
      return rows[0]?.ok === true;
    },
  };
}

/**
 * Hält das Ergebnis fest (Worker, Rolle `stammbuch_worker`) und liefert, ob die unlesbaren Objekte zu melden sind:
 * nur bei geänderter Menge oder höchstens einmal täglich (siehe Migration `rotation_chefadmin_totp`).
 */
export async function recordRotationState(
  db: Datenbank,
  kind: RotationKind,
  now: Date,
  unreadable: string[],
): Promise<boolean> {
  const { rows } = await sql<{ melden: boolean }>`
    SELECT rotation_stand_festhalten(${kind}, ${now}::timestamptz, ${unreadable}::uuid[]) AS melden`.execute(
    db.kysely,
  );
  return rows[0]?.melden === true;
}

/** Wie `recordRotationState` für den Chef-Admin (Rolle `stammbuch_app`): meldet immer, prüft den Akteur in der Datenbank. */
export async function recordRotationStateAsChef(
  db: Datenbank,
  actorId: string,
  kind: RotationKind,
  now: Date,
  unreadable: string[],
): Promise<void> {
  await sql`SELECT rotation_stand_festhalten_chef(${actorId}::uuid, ${kind}, ${now}::timestamptz, ${unreadable}::uuid[])`.execute(
    db.kysely,
  );
}

/** Letzter Lauf und unlesbare Objekte (nur IDs) je Art, für den Chef-Admin. Arten ohne Lauf fehlen. */
export async function readRotationState(
  db: Datenbank,
  actorId: string,
): Promise<{ kind: RotationKind; ranAt: Date; unreadable: string[] }[]> {
  const { rows } = await sql<{ art: RotationKind; gelaufen_am: Date; unlesbar: string[] }>`
    SELECT * FROM rotation_stand_lesen(${actorId}::uuid)`.execute(db.kysely);
  return rows.map((r) => ({ kind: r.art, ranAt: r.gelaufen_am, unreadable: r.unlesbar }));
}
