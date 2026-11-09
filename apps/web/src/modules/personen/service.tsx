import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { useAuth } from "../../auth/auth";
import { createHttpPersonenService } from "./httpPersonenService";
import type {
  BulkResult,
  Duplikat,
  Features,
  Finanzen,
  Firma,
  FirmaDuplikat,
  FirmaInput,
  FirmaQuery,
  Gruppe,
  ImportAuftrag,
  ImportErgebnis,
  MergeInput,
  Page,
  PersonDetail,
  PersonInput,
  PersonQuery,
  PersonRow,
  SammelAktion,
} from "./model";

/**
 * Vertrag zwischen den Seiten des Personen-Moduls und dem Backend. Die Umsetzung gegen die API
 * steht in `httpPersonenService.ts`, eine Umsetzung im Speicher für Tests und Entwicklung in
 * `memoryPersonenService.ts`. Fehler als Exception werfen; ungültige Eingaben als `FieldErrors`.
 */
export interface PersonenService {
  features: Features;

  listPersonen(query: PersonQuery): Promise<Page<PersonRow>>;
  getPerson(id: string): Promise<PersonDetail>;
  /** Nur mit `features.finanzen`. */
  getFinanzen(id: string): Promise<Finanzen>;
  savePerson(id: string | null, input: PersonInput): Promise<PersonDetail>;
  sammelaktion(ids: string[], aktion: SammelAktion, gruppeId?: string): Promise<BulkResult>;

  listGruppen(): Promise<Gruppe[]>;
  /** Personen ohne Gruppe, `null` wenn unbekannt. */
  countOhneGruppe(): Promise<number | null>;
  createGruppe(name: string, beschreibung?: string): Promise<Gruppe>;
  renameGruppe(id: string, name: string): Promise<void>;
  dissolveGruppe(id: string): Promise<void>;

  listFirmen(query: FirmaQuery): Promise<Page<Firma>>;
  getFirma(id: string): Promise<Firma>;
  saveFirma(id: string | null, input: FirmaInput): Promise<Firma>;
  /** Mögliche Duplikate zu einer (noch nicht gespeicherten) Firma. */
  firmaDuplikate(input: FirmaInput, exceptId?: string): Promise<FirmaDuplikat[]>;
  /** Firmenmitglieder (Kontaktpersonen) einer Firma. */
  firmaMitglieder(firmaId: string): Promise<PersonDetail[]>;
  setFirmaFreigabe(id: string, freigeben: boolean): Promise<Firma>;

  /** Nur mit `features.duplikate`. */
  listDuplikate(): Promise<Duplikat[]>;
  getDuplikat(id: string): Promise<Duplikat>;
  setKeinDuplikat(id: string): Promise<void>;
  merge(duplikatId: string, input: MergeInput): Promise<void>;

  importPruefen(auftrag: ImportAuftrag): Promise<ImportErgebnis>;
  importAusfuehren(auftrag: ImportAuftrag): Promise<ImportErgebnis>;
}

const PersonenContext = createContext<PersonenService | null>(null);

/** Setzt einen Dienst für den Teilbaum (Tests, Entwicklung). Ohne Provider gilt die API. */
export function PersonenProvider({
  service,
  children,
}: {
  service: PersonenService;
  children: ReactNode;
}) {
  return <PersonenContext.Provider value={service}>{children}</PersonenContext.Provider>;
}

export function usePersonen(): PersonenService {
  const injected = useContext(PersonenContext);
  const auth = useAuth();
  const expired = useRef(auth.markExpired);
  expired.current = auth.markExpired;
  const authService = auth.service;
  const http = useMemo(
    () =>
      createHttpPersonenService({
        csrfToken: () => authService.csrfToken?.() ?? null,
        onUnauthorized: () => expired.current(),
      }),
    [authService],
  );
  return injected ?? http;
}
