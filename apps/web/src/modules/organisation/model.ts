/** Datentypen der Einstellungen (Organisation, Mailkonto, Benutzer, Protokoll, Lizenz). */

export type Closing = "monthly" | "quarterly" | "yearly";

/** Alle Angaben der vier Organisations-Tabs. Leere Angaben sind leere Zeichenketten. */
export interface OrgData {
  name: string;
  legalForm: string;
  street: string;
  zip: string;
  city: string;
  phone: string;
  email: string;
  website: string;
  vatNumber: string;
  uid: string;
  senderName: string;
  replyTo: string;
  footer: string;
  accountHolder: string;
  bankName: string;
  qrIban: string;
  creditAccount: string;
  paymentDays: string;
  /** «TT.MM.» */
  fiscalStart: string;
  /** «TT.MM.» */
  fiscalEnd: string;
  closing: Closing;
  sammelrechnung: boolean;
  mail: boolean;
  kalender: boolean;
}

export interface LogoInfo {
  mime: string;
  size: number;
  /** Ändert sich mit jedem Hochladen; hängt am Bild-Link, damit der Browser neu lädt. */
  updatedAt: string;
}

export interface OrgState {
  data: OrgData;
  logo: LogoInfo | null;
  /** Konten für «Gutschriften auf» (nur mit `features.creditAccount`). */
  creditAccounts: { value: string; label: string }[];
}

export type OrgErrors = Partial<Record<keyof OrgData, string>>;

/** Die API hat einzelne Felder der Organisation abgelehnt. */
export class OrgFieldErrors extends Error {
  constructor(readonly errors: OrgErrors) {
    super("Ungültige Angaben");
  }
}

/** Was das Backend heute kann. Fehlt etwas, blendet die Oberfläche die zugehörigen Felder aus. */
export interface Features {
  /** Rechtsform der Organisation. */
  legalForm: boolean;
  accountHolder: boolean;
  /** «Gutschriften auf» (Konto der Buchhaltung). */
  creditAccount: boolean;
  paymentDays: boolean;
  /** Periodenabschluss (monatlich, quartalsweise, jährlich). */
  closing: boolean;
  /** Letzte Anmeldung in der Benutzerliste. */
  lastLogin: boolean;
  /** Passwort-Datum, Einmalcode-Datum und Wiederherstellungscodes unter «Ihre Anmeldung». */
  securityInfo: boolean;
  /** Einmalcode im angemeldeten Zustand neu einrichten. */
  totpRenewal: boolean;
  /** Lizenznehmer, Kunden-ID, Lizenz-Nr. und Beginn der Lizenz. */
  licenceDetails: boolean;
  /** Ergebnis (Erfolgreich/Fehlgeschlagen) in der Protokolltabelle. */
  auditResult: boolean;
  /** Export als .xlsx statt .csv. */
  auditXlsx: boolean;
}

export interface MailDraft {
  email: string;
  username: string;
  /** Wird nie angezeigt. Leer, solange nichts eingegeben wurde. */
  password: string;
  senderName: string;
  imapHost: string;
  imapPort: string;
  imapSecurity: "tls" | "starttls";
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: "tls" | "starttls";
}

export interface MailState {
  draft: MailDraft;
  /** Ein Konto ist gespeichert. Das Passwort bleibt auf dem Server. */
  stored: boolean;
  /** Das Mail-Modul läuft auf diesem Server nicht (Route fehlt). */
  unavailable?: boolean;
}

export type StageStatus = "pending" | "running" | "ok" | "failed" | "skipped";

export interface TestStage {
  status: StageStatus;
  /** Dauer in Millisekunden, falls gemessen. */
  ms?: number;
}

/** Die sechs Stufen des Verbindungstests, in dieser Reihenfolge. */
export const TEST_STAGE_COUNT = 6;

export interface TestOutcome {
  stages: TestStage[];
  /** Index (0 bis 5) der gescheiterten Stufe. */
  failedAt?: number;
  /** Zeitpunkt, zu dem die Testmail abgeschickt wurde. */
  sentAt?: Date;
  /** Der Test hat das Konto gespeichert (nur Dienste, die ein Konto nicht ungespeichert prüfen können). */
  persisted?: boolean;
}

export interface SettingsUser {
  id: string;
  name: string;
  email: string;
  status: "active" | "invited";
  /** Anzeige TT.MM.JJJJ HH:MM oder `null`, wenn unbekannt. */
  lastLogin: string | null;
  /** Einmalcode (2FA) eingerichtet. Fehlt die Angabe, gilt «aktiv» als eingerichtet. */
  totpEnrolled?: boolean;
}

export interface SecurityInfo {
  /** JJJJ-MM-TT oder `null`. */
  passwordChangedAt: string | null;
  totpSince: string | null;
  recoveryLeft: number | null;
  recoveryTotal: number | null;
  /** Kurze Gerätebezeichnung dieser Sitzung («Firefox auf Windows») oder `null`, wenn unbekannt. */
  device?: string | null;
}

export interface AuditQuery {
  /** ISO-Zeitpunkt. */
  from?: string;
  actor?: string;
  action?: string;
  q?: string;
  offset: number;
  limit: number;
}

export interface AuditEntry {
  id: string;
  /** ISO-Zeitpunkt. */
  at: string;
  actor: string;
  action: string;
  target: string;
  result: "ok" | "failed";
}

export interface AuditPage {
  items: AuditEntry[];
  total: number;
}

export interface AuditExport {
  blob: Blob;
  filename: string;
  /** Es gab mehr Einträge, als der Export enthält. */
  truncated: boolean;
}

export type LicenceState = "active" | "expired" | "suspended" | "ended";

export interface Licence {
  state: LicenceState;
  /** Ende JJJJ-MM-TT. */
  validUntil: string;
  licensee?: string;
  customerId?: string;
  licenceNo?: string;
  /** Beginn JJJJ-MM-TT. */
  validFrom?: string;
  users?: number;
  /** Adresse für «Anbieter kontaktieren». Leer, solange keine konfiguriert ist. */
  providerEmail: string;
}

/** Fehler der API: Status und Fehlercode, nie der Text des Servers. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** Nur bei 400: Pfade der fehlerhaften Felder, nie ihre Werte. */
    readonly fields?: readonly string[],
  ) {
    super(`API-Fehler ${status} ${code}`);
  }
}
