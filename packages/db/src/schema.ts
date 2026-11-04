import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

// Von Hand gepflegt, muss zu migrations/ passen. Geldbeträge: nur ganzzahlige Rappen oder NUMERIC (nie float).

type Zeitpunkt = ColumnType<Date, Date | string, Date | string>;
// pg liefert bigint als string (kein Genauigkeitsverlust). Beträge sind ganze Rappen und werden beim Lesen
// in number gewandelt. date liefert die Datenbank-Klasse als 'YYYY-MM-DD'-String (keine Zeitzonen-Verschiebung).
type Rappen = ColumnType<string, number | string, never>;
type Datum = ColumnType<string, string, never>;

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

// ---- Buchhaltung (nur anhängend, ausser buchhaltung_konto: name und aktiv) ----

export interface BuchhaltungKontoTable {
  kunde_id: string;
  nummer: string;
  name: string;
  art: "asset" | "liability" | "equity" | "revenue" | "expense";
  aktiv: boolean;
}

export interface BuchhaltungBuchungTable {
  id: Generated<string>;
  kunde_id: string;
  belegnummer: Rappen;
  buchungsdatum: Datum;
  art: "manual" | "invoice" | "credit_note" | "payment" | "reversal";
  beschreibung: string;
  storno_von: string | null;
  erstellt_am: Zeitpunkt;
  erstellt_von: string;
  aufbewahren_bis: Datum;
  vorgaenger_hash: string;
  hash: string;
  transaktions_id: Generated<string>;
}

export interface BuchhaltungBuchungszeileTable {
  kunde_id: string;
  buchung_id: string;
  zeilennr: number;
  konto_nummer: string;
  seite: "debit" | "credit";
  betrag: Rappen;
  person_id: string | null;
}

export interface BuchhaltungOffenerPostenTable {
  lfd: Generated<string>;
  id: Generated<string>;
  kunde_id: string;
  person_id: string;
  referenz: string;
  belegdatum: Datum;
  faellig_am: Datum;
  betrag: Rappen;
  buchung_id: string;
  erstellt_am: Zeitpunkt;
}

export interface BuchhaltungGuthabenTable {
  lfd: Generated<string>;
  id: Generated<string>;
  kunde_id: string;
  art: "payment" | "credit_note";
  person_id: string;
  referenz: string;
  valuta: Datum;
  betrag: Rappen;
  buchung_id: string;
  erstellt_am: Zeitpunkt;
}

export interface BuchhaltungZuordnungTable {
  lfd: Generated<string>;
  id: Generated<string>;
  kunde_id: string;
  guthaben_id: string;
  posten_id: string;
  betrag: Rappen;
  aufhebung_von: string | null;
  erstellt_am: Zeitpunkt;
  erstellt_von: string;
}

export interface BuchhaltungPeriodenereignisTable {
  lfd: Generated<string>;
  kunde_id: string;
  periode: string;
  status: "closed" | "open";
  zeitpunkt: Zeitpunkt;
  akteur: string;
  grund: string | null;
}

export interface BuchhaltungProtokollTable {
  lfd: Generated<string>;
  id: Generated<string>;
  kunde_id: string;
  zeitpunkt: Zeitpunkt;
  akteur: string;
  aktion: string;
  objekt_typ: string;
  objekt_id: string;
  details: Record<string, unknown>;
}

export interface BuchhaltungIdempotenzTable {
  kunde_id: string;
  schluessel: string;
  anfrage_hash: string;
  ergebnis: unknown;
  erstellt_am: Generated<Date>;
}

export interface Database {
  kunde: KundeTable;
  benutzer: BenutzerTable;
  sitzung: SitzungTable;
  audit_log: AuditLogTable;
  buchhaltung_konto: BuchhaltungKontoTable;
  buchhaltung_buchung: BuchhaltungBuchungTable;
  buchhaltung_buchungszeile: BuchhaltungBuchungszeileTable;
  buchhaltung_offener_posten: BuchhaltungOffenerPostenTable;
  buchhaltung_guthaben: BuchhaltungGuthabenTable;
  buchhaltung_zuordnung: BuchhaltungZuordnungTable;
  buchhaltung_periodenereignis: BuchhaltungPeriodenereignisTable;
  buchhaltung_protokoll: BuchhaltungProtokollTable;
  buchhaltung_idempotenz: BuchhaltungIdempotenzTable;
}

export type Kunde = Selectable<KundeTable>;
export type Benutzer = Selectable<BenutzerTable>;
export type NeuerBenutzer = Insertable<BenutzerTable>;
export type BenutzerAenderung = Updateable<BenutzerTable>;
