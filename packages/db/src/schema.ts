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

// --- Rechnungen (Migrationen 2026110413xx) -------------------------------------------------------
// Rappen sind bigint: der Treiber liefert sie als String (mit Number() umwandeln), beim Schreiben geht Number.
// Datumsspalten (date) mit `::text` lesen, damit sie nicht in lokale Zeitzonen umgerechnet werden.

type Rappen = ColumnType<string, number | string, number | string>;
type Datum = ColumnType<string, string, string>;
type Json = ColumnType<unknown, string, string>;

export interface RechnungTable {
  id: string;
  kunde_id: string;
  art: "rechnung" | "gutschrift";
  status: "entwurf" | "versendet" | "bezahlt" | "storniert";
  nummer: string | null;
  laufnummer: number | null;
  kundennummer: string | null;
  debitor: Json;
  waehrung: "CHF" | "EUR";
  rechnungsdatum: Datum;
  faelligkeitsdatum: Datum;
  jahr: ColumnType<number, never, never>;
  mwst_modus: "ohne" | "exklusiv";
  runden_5: boolean;
  betreff: string;
  notizen: string;
  netto_rappen: Rappen;
  mwst_rappen: Rappen;
  brutto_rappen: Rappen;
  rundung_rappen: Rappen;
  total_rappen: Rappen;
  mwst_saetze: Json;
  referenz_art: "QRR" | "SCOR" | "NON" | null;
  referenz: string | null;
  gutschrift_zu: string | null;
  sammellauf_id: string | null;
  zahler_key: string | null;
  versendet_am: ColumnType<Date | null, Date | string | null, Date | string | null>;
  erstellt_am: Zeitpunkt;
  geaendert_am: Zeitpunkt;
  version: number;
}

export interface RechnungPositionTable {
  rechnung_id: string;
  pos: number;
  kunde_id: string;
  beschreibung: string;
  menge_milli: number;
  einzelpreis_rappen: Rappen;
  mwst_satz_bp: number;
}

export interface RechnungZahlungTable {
  id: string;
  lfd: Generated<string>;
  kunde_id: string;
  rechnung_id: string;
  betrag_rappen: Rappen;
  bezahlt_am: Datum;
  erfasst_am: Zeitpunkt;
  erfasst_von: string;
}

export interface MahnungTable {
  id: string;
  kunde_id: string;
  rechnung_id: string;
  stufe: number;
  titel: string;
  ausgestellt_am: Datum;
  faellig_am: Datum;
  gebuehr_rappen: Rappen;
  offen_rappen: Rappen;
  total_rappen: Rappen;
  erstellt_am: Zeitpunkt;
}

export interface NummernkreisTable {
  kunde_id: string;
  art: "rechnung" | "gutschrift";
  jahr: number;
  letzte_nummer: number;
}

export interface RechnungEinstellungTable {
  kunde_id: string;
  empfaenger: Json;
  iban: string;
  mwst_nummer: string | null;
  kontakt_zeilen: Json;
  nummer_praefix: string;
  gutschrift_praefix: string;
  referenz_praefix: string;
  zahlungsfrist_tage: number;
  mwst_modus: "ohne" | "exklusiv";
  mwst_satz_bp: number;
  runden_5: boolean;
  mahnstufen: Json;
  sammelrechnung: boolean;
  geaendert_am: Generated<Date>;
}

export interface Database {
  kunde: KundeTable;
  benutzer: BenutzerTable;
  sitzung: SitzungTable;
  audit_log: AuditLogTable;
  rechnung: RechnungTable;
  rechnung_position: RechnungPositionTable;
  rechnung_zahlung: RechnungZahlungTable;
  mahnung: MahnungTable;
  nummernkreis: NummernkreisTable;
  rechnung_einstellung: RechnungEinstellungTable;
}

export type Kunde = Selectable<KundeTable>;
export type Benutzer = Selectable<BenutzerTable>;
export type NeuerBenutzer = Insertable<BenutzerTable>;
export type BenutzerAenderung = Updateable<BenutzerTable>;
