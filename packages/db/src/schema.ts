import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

// Von Hand gepflegt, muss zu migrations/ passen. Geldbeträge: nur ganzzahlige Rappen oder NUMERIC (nie float).

type Zeitpunkt = ColumnType<Date, Date | string, Date | string>;
// pg liefert bigint als string (kein Genauigkeitsverlust). Beträge sind ganze Rappen und werden beim Lesen
// in number gewandelt. date liefert die Datenbank-Klasse als 'YYYY-MM-DD'-String (keine Zeitzonen-Verschiebung).
type Rappen = ColumnType<string, number | string, number | string>;
type Datum = ColumnType<string, string, string>;

export interface KundeTable {
  id: Generated<string>;
  name: string;
  slug: ColumnType<string | null, string | null | undefined, string | null>;
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
  /** Nur der Eigentümer setzt `chief_admin` (kein Spaltenrecht für die Anwendungsrolle). */
  rolle: Generated<"user" | "chief_admin">;
  /** Verschlüsseltes TOTP-Geheimnis (AES-256-GCM). `null` = 2FA noch nicht eingerichtet. */
  totp_secret_enc: string | null;
  /** bigint kommt als String aus pg. */
  totp_letzter_zaehler: string | null;
  totp_eingerichtet_am: Date | null;
}

export interface WiederherstellungscodeTable {
  id: Generated<string>;
  kunde_id: string;
  benutzer_id: string;
  /** HMAC-SHA-256 (hex), nie der Code selbst. */
  code_hmac: string;
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
  /** `pending` = Passwort geprüft, zweiter Faktor fehlt. */
  phase: "pending" | "full";
  csrf_token: string;
  zuletzt_gesehen_am: Zeitpunkt;
  totp_pending_enc: string | null;
  mfa_fehlversuche: Generated<number>;
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

// --- Rechnungen (Migrationen 2026110413xx) -------------------------------------------------------
// Rappen sind bigint: der Treiber liefert sie als String (mit Number() umwandeln), beim Schreiben geht Number.
// Datumsspalten (date) mit `::text` lesen, damit sie nicht in lokale Zeitzonen umgerechnet werden.

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

// Personen-Modul (Migrationen 2026110412xx)

/** Von der Datenbank berechnet (GENERATED/Trigger): lesbar, nie schreibbar. */
type Berechnet<T> = ColumnType<T, never, never>;
type Optional<T> = ColumnType<T | null, T | null | undefined, T | null>;

export interface FirmaTable {
  kunde_id: string;
  id: Generated<string>;
  name: string;
  uid: Optional<string>;
  mwst_nr: Optional<string>;
  strasse: string;
  hausnr: Optional<string>;
  zusatz: Optional<string>;
  plz: string;
  ort: string;
  land: Generated<string>;
  email: Optional<string>;
  telefon: Optional<string>;
  status: "ausstehend" | "freigegeben" | "abgelehnt" | "zusammengefuehrt";
  zusammengefuehrt_mit: Optional<string>;
  erstellt_am: Generated<Date>;
  name_sort: Berechnet<string>;
  suchtext: Berechnet<string>;
}

export interface GruppeTable {
  kunde_id: string;
  id: Generated<string>;
  name: string;
}

export interface MitgliedTable {
  kunde_id: string;
  id: Generated<string>;
  typ: "einzel" | "firma";
  status: Generated<"aktiv" | "archiviert">;
  anrede: Optional<"frau" | "herr" | "divers">;
  vorname: string;
  nachname: string;
  email: Optional<string>;
  telefon: Optional<string>;
  mobil: Optional<string>;
  strasse: Optional<string>;
  hausnr: Optional<string>;
  zusatz: Optional<string>;
  plz: Optional<string>;
  ort: Optional<string>;
  land: Optional<string>;
  notiz: Optional<string>;
  funktion: Optional<string>;
  firma_id: Optional<string>;
  erstellt_am: Generated<Date>;
  geaendert_am: Generated<Date>;
  nachname_sort: Berechnet<string>;
  vorname_sort: Berechnet<string>;
  /** Vom Trigger gepflegt. */
  suchtext: Berechnet<string>;
}

export interface GruppeMitgliedschaftTable {
  kunde_id: string;
  mitglied_id: string;
  gruppe_id: string;
}

export interface RegistrierungOffenTable {
  token_hash: string;
  kunde_id: string;
  art: "person" | "firma";
  daten: unknown;
  ablauf_am: Zeitpunkt;
}

/**
 * Tabellen ohne Mandantenbezug. Die Anwendungsrolle hat KEINE Rechte darauf (RLS ohne Richtlinie), sie
 * stehen darum nicht in `Database`: Zugriff nur über die SECURITY-DEFINER-Funktionen (siehe README).
 */
export interface AuthSperreTable {
  schluessel: string;
  fehlversuche: number;
  letzter_fehler: Date;
  gesperrt_bis: Date | null;
}

export interface AuthEreignisTable {
  id: Generated<string>;
  zeitpunkt: Generated<Date>;
  aktion: string;
  ergebnis: "success" | "failure";
  ip: string | null;
  benutzer_id: string | null;
  details: Generated<Record<string, unknown>>;
}

export interface Database {
  kunde: KundeTable;
  benutzer: BenutzerTable;
  sitzung: SitzungTable;
  audit_log: AuditLogTable;
  kalender_event: KalenderEventTable;
  kalender_einladung: KalenderEinladungTable;
  kalender_antwort: KalenderAntwortTable;
  buchhaltung_konto: BuchhaltungKontoTable;
  buchhaltung_buchung: BuchhaltungBuchungTable;
  buchhaltung_buchungszeile: BuchhaltungBuchungszeileTable;
  buchhaltung_offener_posten: BuchhaltungOffenerPostenTable;
  buchhaltung_guthaben: BuchhaltungGuthabenTable;
  buchhaltung_zuordnung: BuchhaltungZuordnungTable;
  buchhaltung_periodenereignis: BuchhaltungPeriodenereignisTable;
  buchhaltung_protokoll: BuchhaltungProtokollTable;
  buchhaltung_idempotenz: BuchhaltungIdempotenzTable;
  rechnung: RechnungTable;
  rechnung_position: RechnungPositionTable;
  rechnung_zahlung: RechnungZahlungTable;
  mahnung: MahnungTable;
  nummernkreis: NummernkreisTable;
  rechnung_einstellung: RechnungEinstellungTable;
  wiederherstellungscode: WiederherstellungscodeTable;
  firma: FirmaTable;
  gruppe: GruppeTable;
  mitglied: MitgliedTable;
  gruppe_mitgliedschaft: GruppeMitgliedschaftTable;
  registrierung_offen: RegistrierungOffenTable;
}

export type Kunde = Selectable<KundeTable>;
export type Benutzer = Selectable<BenutzerTable>;
export type NeuerBenutzer = Insertable<BenutzerTable>;
export type BenutzerAenderung = Updateable<BenutzerTable>;
export type KalenderEvent = Selectable<KalenderEventTable>;
export type KalenderEinladung = Selectable<KalenderEinladungTable>;
export type KalenderAntwort = Selectable<KalenderAntwortTable>;
