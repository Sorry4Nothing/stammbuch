import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

// Von Hand gepflegt, muss zu migrations/ passen. Geldbeträge: nur ganzzahlige Rappen oder NUMERIC (nie float).

type Zeitpunkt = ColumnType<Date, Date | string, Date | string>;

export interface KundeTable {
  id: Generated<string>;
  name: string;
  erstellt_am: Generated<Date>;
}

export interface BenutzerTable {
  id: Generated<string>;
  kunde_id: string;
  email: string;
  name: string;
  passwort_hash: string;
  aktiv: Generated<boolean>;
  erstellt_am: Generated<Date>;
}

export interface SitzungTable {
  id: Generated<string>;
  kunde_id: string;
  benutzer_id: string;
  token_hash: Buffer;
  erstellt_am: Generated<Date>;
  laeuft_ab_am: Zeitpunkt;
  widerrufen_am: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface AuditLogTable {
  id: Generated<string>;
  kunde_id: string;
  benutzer_id: string | null;
  zeitpunkt: Generated<Date>;
  aktion: string;
  objekt_typ: string | null;
  objekt_id: string | null;
  details: Generated<Record<string, unknown>>;
}

export interface KalenderEventTable {
  id: Generated<string>;
  kunde_id: string;
  titel: string;
  beschreibung: Generated<string>;
  ort: Generated<string>;
  beginnt_am: Zeitpunkt;
  endet_am: Zeitpunkt;
  anmeldeschluss_am: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  max_begleiter: Generated<number>;
  erstellt_von: string;
  erstellt_am: Generated<Date>;
  geaendert_am: Zeitpunkt;
}

export interface KalenderEinladungTable {
  id: Generated<string>;
  kunde_id: string;
  event_id: string;
  email: string;
  name: string;
  token_hash: Buffer;
  erstellt_am: Generated<Date>;
}

export interface KalenderAntwortTable {
  id: Generated<string>;
  kunde_id: string;
  event_id: string;
  einladung_id: string;
  status: "accepted" | "declined";
  begleiter: Generated<number>;
  notiz: Generated<string>;
  geantwortet_am: Zeitpunkt;
}

export interface Database {
  kunde: KundeTable;
  benutzer: BenutzerTable;
  sitzung: SitzungTable;
  audit_log: AuditLogTable;
  kalender_event: KalenderEventTable;
  kalender_einladung: KalenderEinladungTable;
  kalender_antwort: KalenderAntwortTable;
}

export type Kunde = Selectable<KundeTable>;
export type Benutzer = Selectable<BenutzerTable>;
export type NeuerBenutzer = Insertable<BenutzerTable>;
export type BenutzerAenderung = Updateable<BenutzerTable>;
export type KalenderEvent = Selectable<KalenderEventTable>;
export type KalenderEinladung = Selectable<KalenderEinladungTable>;
export type KalenderAntwort = Selectable<KalenderAntwortTable>;
