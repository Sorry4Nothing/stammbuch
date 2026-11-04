import type {
  Firma,
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
}

export interface MemberRepository {
  /** Wirft `AppError(409)`, wenn die E-Mail im Mandanten schon bei einem anderen Mitglied vorkommt. */
  insert(m: Member): Promise<void>;
  /** Atomar: entweder alle oder keines. Wirft `AppError(409)` bei E-Mail-Kollision. */
  insertMany(kundeId: string, members: Member[]): Promise<void>;
  get(kundeId: string, id: string): Promise<Member | undefined>;
  /** Wirft `AppError(409)` bei E-Mail-Kollision. */
  save(m: Member): Promise<void>;
  findByEmail(kundeId: string, email: string): Promise<Member | undefined>;
  /** Teilmenge von `emails`, die im Mandanten schon vergeben ist (eine Abfrage für den Import). */
  existingEmails(kundeId: string, emails: string[]): Promise<Set<string>>;
  list(kundeId: string, query: MemberQuery): Promise<Page<Member>>;
}

export interface GruppeRepository {
  /** Wirft `AppError(409)` bei doppeltem Namen (ohne Gross-/Kleinschreibung). */
  insert(g: Gruppe): Promise<void>;
  get(kundeId: string, id: string): Promise<Gruppe | undefined>;
  list(kundeId: string): Promise<Array<Gruppe & { mitglieder: number }>>;
  /** Wirft `AppError(409)` bei doppeltem Namen. Gibt false zurück, wenn die Gruppe unbekannt ist. */
  rename(kundeId: string, id: string, name: string): Promise<boolean>;
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
}

export interface FirmaRepository {
  insert(f: Firma): Promise<void>;
  get(kundeId: string, id: string): Promise<Firma | undefined>;
  getMany(kundeId: string, ids: string[]): Promise<Firma[]>;
  save(f: Firma): Promise<void>;
  list(kundeId: string, query: FirmaQuery): Promise<Page<Firma>>;
  /** Alle noch gültigen Firmen (ausstehend, freigegeben) für die Duplikat-Erkennung. */
  listCandidates(kundeId: string): Promise<Firma[]>;
  /**
   * Atomar: Mitglieder der Quelle auf das Ziel umhängen, Ziel speichern, Quelle als
   * zusammengeführt markieren.
   */
  merge(kundeId: string, target: Firma, sourceId: string, now: Date): Promise<void>;
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
