import type { Address } from "@stammbuch/shared";

/** Mandantenkontext aus der serverseitig aufgelösten Session, nie aus dem Request-Body (SR-13). */
export interface Ctx {
  kundeId: string;
  benutzerId: string;
}

export type MemberStatus = "aktiv" | "archiviert";
export type FirmaStatus = "ausstehend" | "freigegeben" | "abgelehnt" | "zusammengefuehrt";

export type Kanal = "email" | "post";
export type FirmaQuelle = "manuell" | "selbst";

export interface Member {
  id: string;
  kundeId: string;
  /** Vergibt der Speicher beim Anlegen (M-1001, ...); davor leer. */
  mitgliedsnr: string;
  typ: "einzel" | "firma";
  status: MemberStatus;
  anrede: "frau" | "herr" | "divers" | null;
  vorname: string;
  nachname: string;
  email: string | null;
  telefon: string | null;
  mobil: string | null;
  adresse: Address | null;
  notiz: string | null;
  /** ISO-Datum (JJJJ-MM-TT). */
  geburtsdatum: string | null;
  eintritt: string | null;
  kanal: Kanal | null;
  funktion: string | null;
  firmaId: string | null;
  /** Aus der Mitgliedschaftstabelle gelesen, nicht am Mitglied gespeichert. */
  gruppeId: string | null;
  gruppeSeit: Date | null;
  erstelltAm: Date;
  geaendertAm: Date;
}

export interface Gruppe {
  id: string;
  kundeId: string;
  name: string;
  beschreibung: string | null;
  erstelltAm: Date;
  geaendertAm: Date;
}

export interface Firma {
  id: string;
  kundeId: string;
  name: string;
  uid: string | null;
  mwstNr: string | null;
  adresse: Address;
  email: string | null;
  telefon: string | null;
  status: FirmaStatus;
  zusammengefuehrtMit: string | null;
  erstelltAm: Date;
  kontaktperson: string | null;
  rechnungsEmail: string | null;
  notiz: string | null;
  quelle: FirmaQuelle;
}

export interface PendingRegistration {
  tokenHash: string;
  kundeId: string;
  art: "person" | "firma";
  /** Bereits validierte Eingabe (Zod-Ausgabe), JSON-serialisierbar. */
  daten: unknown;
  ablaufAm: Date;
}

export type Clock = () => Date;
