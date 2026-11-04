import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

// Von Hand gepflegt, muss zu migrations/ passen. Geldbeträge: nur ganzzahlige Rappen oder NUMERIC (nie float).

type Zeitpunkt = ColumnType<Date, Date | string, Date | string>;

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
