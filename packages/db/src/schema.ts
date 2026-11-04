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

export interface CamtImportTable {
  id: string;
  kunde_id: string;
  datei_hash: string;
  art: "camt.053" | "camt.054";
  version: string;
  nachricht_id: string;
  zaehler: ColumnType<Record<string, number>, string, never>;
  importiert_am: ColumnType<Date, Date | string, never>;
  importiert_von: string | null;
}

export interface CamtZahlungTable {
  id: string;
  lfd: ColumnType<string, never, never>;
  kunde_id: string;
  import_id: string;
  buchungsschluessel: string;
  status: "MATCHED" | "REST" | "MANUAL";
  rest_grund: string | null;
  offener_posten_id: string | null;
  // Buchungsdatum, Betrag, Währung, Richtung, Storno: nur zum Filtern und Prüfen (CHECK). Gelesen wird
  // `transaktion`: pg liefert date als lokales Date und bigint als string.
  buchungsdatum: ColumnType<never, string, never>;
  betrag_rappen: ColumnType<never, number, never>;
  waehrung: ColumnType<never, string, never>;
  richtung: ColumnType<never, "CREDIT" | "DEBIT", never>;
  storno: ColumnType<never, boolean, never>;
  transaktion: ColumnType<Record<string, unknown>, string, never>;
  erstellt_am: Generated<Date>;
  zugeordnet_von: ColumnType<string | null, string | null | undefined, string | null>;
  zugeordnet_am: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface Database {
  kunde: KundeTable;
  benutzer: BenutzerTable;
  sitzung: SitzungTable;
  audit_log: AuditLogTable;
  camt_import: CamtImportTable;
  camt_zahlung: CamtZahlungTable;
}

export type Kunde = Selectable<KundeTable>;
export type Benutzer = Selectable<BenutzerTable>;
export type NeuerBenutzer = Insertable<BenutzerTable>;
export type BenutzerAenderung = Updateable<BenutzerTable>;
