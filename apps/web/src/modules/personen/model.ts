/** Datenmodell des Personen-Moduls (Design Gruppe 3). Unabhängig von der API-Form der Antworten. */

export type PersonTyp = "einzel" | "firma";
export type PersonStatus = "aktiv" | "ausstehend" | "ausgetreten";
export type Anrede = "frau" | "herr" | "divers";
export type FirmaStatus = "ausstehend" | "freigegeben" | "abgelehnt";
export type FirmaQuelle = "manuell" | "selbst";

/**
 * Welche Angaben der angebundene Dienst liefert. Fehlt etwas (z. B. weil die API es nicht kennt),
 * zeigt die Oberfläche die zugehörigen Felder und Bereiche nicht an, statt Eingaben zu verwerfen.
 */
export interface Features {
  /** Mitgliedsnr., Geburtsdatum, Eintritt, bevorzugter Kanal, Gruppe seit. */
  personExtras: boolean;
  /** Rechnungen, Debitorenkonto, Mails und Verlauf bei Person und Firma. */
  finanzen: boolean;
  /** Gruppen: Beschreibung, angelegt, zuletzt geändert, Adresslisten. */
  gruppenDetails: boolean;
  /** Firma: Kontaktperson, Rechnungs-E-Mail, Bemerkung, Quelle, erfasst von, Mitgliederzahl. */
  firmaExtras: boolean;
  /** Duplikate: Liste über das ganze Register und Zusammenführen mit Wertwahl. */
  duplikate: boolean;
  /** Importoptionen: Duplikate prüfen, bestehende aktualisieren, Gruppe für alle. */
  importOptionen: boolean;
  /** Status «Ausstehend» bei Personen. */
  statusAusstehend: boolean;
}

export interface Page<T> {
  items: T[];
  /** Cursor für die nächste Seite, `null` am Ende. */
  next: string | null;
  /** Gesamtzahl, falls der Dienst sie kennt. */
  total: number | null;
}

export interface PersonRow {
  id: string;
  nr: string | null;
  /** Person: «Vorname Nachname». Firmenmitglied: Firmenname. */
  name: string;
  typ: PersonTyp;
  ort: string | null;
  gruppeId: string | null;
  gruppeName: string | null;
  status: PersonStatus;
}

export interface Rechnung {
  nr: string;
  /** ISO-Datum. */
  datum: string;
  /** Betrag in Rappen. */
  betrag: number;
  status: "offen" | "bezahlt";
}

export interface Debitorenkonto {
  /** Beträge in Rappen. */
  offen: number;
  bezahltJahr: number;
  mahnstufe: string;
  letzteZahlung: string | null;
}

export interface VerlaufEintrag {
  datum: string;
  text: string;
}

export interface Finanzen {
  rechnungen: Rechnung[];
  konto: Debitorenkonto;
  mails: number;
  verlauf: VerlaufEintrag[];
}

export interface PersonDetail extends PersonRow {
  anrede: Anrede | null;
  vorname: string;
  nachname: string;
  email: string | null;
  telefon: string | null;
  strasse: string | null;
  plz: string | null;
  ortAdresse: string | null;
  notiz: string | null;
  funktion: string | null;
  firmaId: string | null;
  firmaName: string | null;
  /** ISO-Datum, nur mit `personExtras`. */
  geburtsdatum: string | null;
  eintritt: string | null;
  kanal: string | null;
  gruppeSeit: string | null;
}

export interface PersonInput {
  typ: PersonTyp;
  anrede?: Anrede;
  vorname: string;
  nachname: string;
  email?: string;
  telefon?: string;
  strasse?: string;
  plz?: string;
  ort?: string;
  /** ISO-Datum. */
  geburtsdatum?: string;
  eintritt?: string;
  gruppeId?: string;
  notiz?: string;
  firmaId?: string;
  funktion?: string;
}

export interface PersonQuery {
  q?: string;
  typ?: PersonTyp;
  /** Gruppen-ID oder `"ohne"`. */
  gruppeId?: string;
  status?: PersonStatus;
  firmaId?: string;
  cursor?: string;
}

export type SammelAktion =
  "gruppe_zuweisen" | "gruppe_entfernen" | "archivieren" | "wiederherstellen";

export interface Gruppe {
  id: string;
  name: string;
  mitglieder: number;
  beschreibung: string | null;
  /** ISO-Datum. */
  angelegt: string | null;
  geaendert: string | null;
  /** Namen der Adresslisten, die die Gruppe nutzen. */
  adresslisten: string[] | null;
}

export interface Firma {
  id: string;
  name: string;
  uid: string | null;
  mwstNr: string | null;
  strasse: string;
  plz: string;
  ort: string;
  email: string | null;
  telefon: string | null;
  status: FirmaStatus;
  /** ISO-Zeitpunkt. */
  erstelltAm: string;
  quelle: FirmaQuelle | null;
  /** Anzahl Firmenmitglieder. */
  mitglieder: number | null;
  erfasstVon: string | null;
  kontaktperson: string | null;
  rechnungsEmail: string | null;
  notiz: string | null;
}

export interface FirmaInput {
  name: string;
  uid?: string;
  mwstNr?: string;
  strasse: string;
  plz: string;
  ort: string;
  email?: string;
  telefon?: string;
  kontaktperson?: string;
  rechnungsEmail?: string;
  notiz?: string;
}

export interface FirmaQuery {
  q?: string;
  quelle?: FirmaQuelle;
  /** Ohne Angabe nur freigegebene Firmen (das Register), `alle` auch ausstehende und abgelehnte. */
  status?: FirmaStatus | "alle";
  cursor?: string;
}

export interface FirmaDuplikat {
  firma: Firma;
  /** 0 bis 1. */
  score: number;
  gruende: Array<"uid" | "mwst" | "name" | "name_aehnlich" | "adresse">;
}

export interface DuplikatEintrag {
  id: string;
  name: string;
  nr: string | null;
  /** Anzahl Rechnungen, nur mit `features.finanzen`. */
  rechnungen: number | null;
  /** Anzahl Firmenmitglieder, wo der Dienst keine Rechnungen kennt. */
  mitglieder?: number | null;
  felder: Record<string, string>;
}

export type DuplikatStatus = "offen" | "kein_duplikat";

export interface Duplikat {
  id: string;
  art: "person" | "firma";
  a: DuplikatEintrag;
  b: DuplikatEintrag;
  trefferBei: Array<"name" | "uid" | "mwst">;
  /** 0 bis 100. */
  aehnlichkeit: number;
  status: DuplikatStatus;
}

export interface MergeInput {
  /** Behaltener Eintrag, der andere wird entfernt. */
  behaltenId: string;
  entfernenId: string;
  /** Gewählte Werte je Feld. */
  werte: Record<string, string>;
}

export interface ImportDatei {
  name: string;
  /** Zeilen der Datei ohne Kopfzeile. */
  zeilen: string[][];
  spalten: string[];
}

export type ImportZiel =
  "vorname" | "nachname" | "strasse" | "plzOrt" | "email" | "gruppe" | "ignorieren";

export interface ImportOptionen {
  ersteZeileNamen: boolean;
  duplikatePruefen: boolean;
  aktualisieren: boolean;
  gruppeFuerAlle: string | null;
}

export interface ImportAuftrag {
  datei: ImportDatei;
  zuordnung: ImportZiel[];
  optionen: ImportOptionen;
}

export interface ImportErgebnis {
  zeilen: number;
  neu: number;
  duplikate: number;
  fehlerhaft: number;
  /** Nur Zeilennummer und Feldnamen, keine Werte. */
  fehler: Array<{ zeile: number; felder: string[] }>;
}

/** Feldweise Fehler einer Eingabe, wie sie die Prüfung des Dienstes meldet. */
export class FieldErrors extends Error {
  constructor(readonly fields: Record<string, string>) {
    super("Ungültige Angaben");
  }
}

export interface BulkResult {
  ok: number;
  fehler: number;
}

/** Die API hat mit einem Fehlerstatus geantwortet. Nie mit Text der Antwort (Datenschutz). */
export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`Unerwartete Antwort der API (${status})`);
  }
}
