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
}

export type Kunde = Selectable<KundeTable>;
export type Benutzer = Selectable<BenutzerTable>;
export type NeuerBenutzer = Insertable<BenutzerTable>;
export type BenutzerAenderung = Updateable<BenutzerTable>;
