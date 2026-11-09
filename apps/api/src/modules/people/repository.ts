import type {
  Firma,
  FirmaQuelle,
  FirmaStatus,
  Gruppe,
  Member,
  MemberStatus,
  PendingRegistration,
} from "./domain.js";

/**
 * Persistenz-Schnittstellen. Jede Methode nimmt `kundeId` als ersten Parameter und darf nie
 * Zeilen anderer Mandanten sehen (in SQL: `WHERE kunde_id = $1` plus RLS). Implementierungen:
 * `postgres.ts` (Produktion, Tabellen siehe packages/db/migrations) und `memory.ts` (Tests).
 */

export interface MemberQuery {
  limit: number;
  /** Sortierschlüssel des letzten Eintrags der vorigen Seite. */
  after?: string;
  q?: string;
  typ?: "einzel" | "firma";
  status: MemberStatus;
  gruppeId?: string;
  firmaId?: string;
  ohneGruppe?: boolean;
}

export interface Page<T> {
  items: T[];
  /** Sortierschlüssel zum Weiterblättern oder null am Ende. */
  next: string | null;
  /** Anzahl aller Treffer des Filters, unabhängig von Seite und Cursor. */
  total: number;
}

/** Ein Import in einer Transaktion: neue Mitglieder, geänderte Mitglieder, Gruppenzuweisungen. */
export interface ImportBatch {
  neu: Member[];
  geaendert: Member[];
  /** Mitglied -> Gruppe; ersetzt eine bisherige Gruppe. */
  gruppen: Array<[memberId: string, gruppeId: string]>;
}

export interface MemberRepository {
  /**
   * Wirft `AppError(409)`, wenn die E-Mail im Mandanten schon bei einem anderen Mitglied vorkommt.
   * Gibt das gespeicherte Mitglied zurück (mit der vergebenen Mitgliedsnummer).
   */
  insert(m: Member): Promise<Member>;
  /** Atomar: entweder alle oder keines. Wirft `AppError(409)` bei E-Mail-Kollision. */
  insertMany(kundeId: string, members: Member[]): Promise<Member[]>;
  /** Atomar wie `insertMany`; Fehler in einem Teil rollen alles zurück. */
  importieren(kundeId: string, batch: ImportBatch): Promise<Member[]>;
  get(kundeId: string, id: string): Promise<Member | undefined>;
  /** Wirft `AppError(409)` bei E-Mail-Kollision. */
  save(m: Member): Promise<void>;
  findByEmail(kundeId: string, email: string): Promise<Member | undefined>;
  /** Mitglieder zu den E-Mail-Adressen, die im Mandanten schon vergeben sind (eine Abfrage für den Import). */
  existingByEmail(kundeId: string, emails: string[]): Promise<Map<string, Member>>;
  list(kundeId: string, query: MemberQuery): Promise<Page<Member>>;
}

export interface GruppeRepository {
  /** Wirft `AppError(409)` bei doppeltem Namen (ohne Gross-/Kleinschreibung). */
  insert(g: Gruppe): Promise<void>;
  get(kundeId: string, id: string): Promise<Gruppe | undefined>;
  list(kundeId: string): Promise<Array<Gruppe & { mitglieder: number; adresslisten: string[] }>>;
  /**
   * Ändert Name und/oder Beschreibung (`null` löscht sie) und setzt `geaendertAm`. Wirft
   * `AppError(409)` bei doppeltem Namen. Gibt false zurück, wenn die Gruppe unbekannt ist.
   */
  update(
    kundeId: string,
    id: string,
    patch: { name?: string; beschreibung?: string | null },
    now: Date,
  ): Promise<boolean>;
  /** Löst die Gruppe auf und entfernt alle Mitgliedschaften. Gibt false zurück, wenn unbekannt. */
  dissolve(kundeId: string, id: string): Promise<boolean>;
  /**
   * Wirft `AppError(409)`, wenn das Mitglied schon in einer anderen Gruppe ist (UNIQUE je
   * Mitglied), und `AppError(404)`, wenn Mitglied oder Gruppe nicht zum Mandanten gehören.
   */
  assign(kundeId: string, memberId: string, gruppeId: string): Promise<void>;
  unassign(kundeId: string, memberId: string): Promise<void>;
}

export interface FirmaQuery {
  limit: number;
  after?: string;
  q?: string;
  status?: FirmaStatus;
  quelle?: FirmaQuelle;
}

export interface FirmaRepository {
  insert(f: Firma): Promise<void>;
  get(kundeId: string, id: string): Promise<Firma | undefined>;
  getMany(kundeId: string, ids: string[]): Promise<Firma[]>;
  /** Anzahl aktiver Firmenmitglieder je Firma (Firmen ohne Mitglieder fehlen nicht: Wert 0). */
  countMitglieder(kundeId: string, ids: string[]): Promise<Map<string, number>>;
  save(f: Firma): Promise<void>;
  list(kundeId: string, query: FirmaQuery): Promise<Page<Firma>>;
  /** Alle noch gültigen Firmen (ausstehend, freigegeben) für die Duplikat-Erkennung. */
  listCandidates(kundeId: string): Promise<Firma[]>;
  /**
   * Atomar: Mitglieder der Quelle auf das Ziel umhängen, Ziel speichern, Quelle als
   * zusammengeführt markieren.
   */
  merge(kundeId: string, target: Firma, sourceId: string, now: Date): Promise<void>;
  /** Als «kein Duplikat» bestätigte Paare, Schlüssel `<idA>_<idB>` mit idA < idB. */
  duplikatAusnahmen(kundeId: string): Promise<Set<string>>;
  /** Idempotent. Wirft `AppError(404)`, wenn eine der Firmen nicht zum Mandanten gehört. */
  addDuplikatAusnahme(kundeId: string, a: string, b: string): Promise<void>;
}

export interface RegistrationRepository {
  put(p: PendingRegistration): Promise<void>;
  /** Liest und löscht atomar: ein Token gilt nur einmal. */
  take(tokenHash: string): Promise<PendingRegistration | undefined>;
}

export interface PeopleStore {
  members: MemberRepository;
  gruppen: GruppeRepository;
  firmen: FirmaRepository;
  registrations: RegistrationRepository;
}
