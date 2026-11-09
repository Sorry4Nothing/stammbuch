import type {
  BulkResult as ApiBulkResult,
  DuplicateCandidate,
  DuplikatDto,
  FinanzenDto,
  FirmaDto,
  GruppeDto,
  MemberDto,
} from "@stammbuch/shared";
import { t } from "../../i18n";
import { formatChf } from "./format";
import {
  ApiError,
  type Finanzen,
  type Duplikat,
  type DuplikatEintrag,
  type Features,
  type Firma,
  type FirmaDuplikat,
  type FirmaInput,
  type Gruppe,
  type ImportAuftrag,
  type ImportErgebnis,
  type Page,
  type PersonDetail,
  type PersonInput,
  type PersonQuery,
  type PersonRow,
} from "./model";
import type { PersonenService } from "./service";

interface Options {
  /** CSRF-Token der Sitzung für schreibende Anfragen. */
  csrfToken: () => string | null;
  /** Wird bei 401 aufgerufen (Sitzung abgelaufen). */
  onUnauthorized: () => void;
  fetchFn?: typeof fetch;
}

/**
 * Was die API nicht liefert, bleibt aus: die Oberfläche blendet die zugehörigen Felder aus.
 * Finanzen gibt es nur für Personen: Rechnungen tragen die Mitglied-ID (Sammelrechnung) bzw. die
 * Mitgliedsnummer als Kundennummer; Firmen haben keine solche Verknüpfung.
 */
export const httpFeatures: Features = {
  personExtras: true,
  finanzen: true,
  firmaFinanzen: false,
  gruppenDetails: true,
  firmaExtras: true,
  duplikate: true,
  importOptionen: true,
  statusAusstehend: true,
};

const PAGE = 50;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function fullName(m: MemberDto): string {
  return m.typ === "firma" && m.firmaName ? m.firmaName : `${m.vorname} ${m.nachname}`.trim();
}

function street(
  a: { strasse: string; hausnr?: string | undefined } | null | undefined,
): string | null {
  return a ? [a.strasse, a.hausnr].filter(Boolean).join(" ") : null;
}

const personStatus = (m: MemberDto): PersonRow["status"] =>
  m.status === "archiviert" || m.status === "zusammengefuehrt" ? "ausgetreten" : m.status;

function toRow(m: MemberDto, gruppen: Map<string, string>): PersonRow {
  return {
    id: m.id,
    nr: m.mitgliedsnr,
    name: fullName(m),
    typ: m.typ,
    ort: m.adresse?.ort ?? null,
    gruppeId: m.gruppeId,
    gruppeName: (m.gruppeId && gruppen.get(m.gruppeId)) || null,
    status: personStatus(m),
  };
}

function toDetail(m: MemberDto, gruppen: Map<string, string>): PersonDetail {
  return {
    ...toRow(m, gruppen),
    anrede: m.anrede,
    vorname: m.vorname,
    nachname: m.nachname,
    email: m.email,
    telefon: m.telefon,
    strasse: street(m.adresse),
    plz: m.adresse?.plz ?? null,
    ortAdresse: m.adresse?.ort ?? null,
    notiz: m.notiz,
    funktion: m.funktion,
    firmaId: m.firmaId,
    firmaName: m.firmaName,
    geburtsdatum: m.geburtsdatum,
    eintritt: m.eintritt,
    kanal: m.kanal,
    gruppeSeit: m.gruppeSeit,
    erstelltAm: m.erstelltAm,
    quelle: m.quelle,
  };
}

/** Text des Verlaufs; die API liefert nur Art, Detail und Betrag. */
function toFinanzen(f: FinanzenDto): Finanzen {
  return {
    rechnungen: f.rechnungen.map((r) => ({
      nr: r.nr,
      datum: r.datum,
      betrag: r.betrag,
      status: r.status,
    })),
    konto: {
      offen: f.konto.offen,
      bezahltJahr: f.konto.bezahltJahr,
      mahnstufe:
        f.konto.mahnstufe === 0
          ? t("personen.konto.mahnstufe.keine")
          : t("personen.konto.mahnstufe.stufe", { n: f.konto.mahnstufe }),
      letzteZahlung: f.konto.letzteZahlung,
    },
    mails: f.mails,
    verlauf: f.verlauf.map((v) => ({
      datum: v.datum,
      text: t(`personen.verlauf.${v.art}` as "personen.verlauf.angelegt", {
        detail: v.detail ?? "",
        betrag: v.betrag === null ? "" : formatChf(v.betrag),
      }),
    })),
  };
}

function toFirma(f: FirmaDto): Firma {
  return {
    id: f.id,
    name: f.name,
    uid: f.uid,
    mwstNr: f.mwstNr,
    strasse: street(f.adresse) ?? "",
    plz: f.adresse.plz,
    ort: f.adresse.ort,
    email: f.email,
    telefon: f.telefon,
    status: f.status === "freigegeben" || f.status === "abgelehnt" ? f.status : "ausstehend",
    erstelltAm: f.erstelltAm,
    quelle: f.quelle,
    mitglieder: f.mitglieder,
    erfasstVon: f.erfasstVon,
    kontaktperson: f.kontaktperson,
    rechnungsEmail: f.rechnungsEmail,
    notiz: f.notiz,
  };
}

function toDuplikatEintrag(e: DuplikatDto["a"]): DuplikatEintrag {
  return {
    id: e.id,
    name: e.name,
    nr: e.nr,
    rechnungen: e.rechnungen,
    mitglieder: e.mitglieder,
    felder: Object.fromEntries(
      Object.entries(e.felder).filter((x): x is [string, string] => x[1] !== undefined),
    ),
  };
}

const toDuplikat = (d: DuplikatDto): Duplikat => ({
  id: d.id,
  art: d.art,
  a: toDuplikatEintrag(d.a),
  b: toDuplikatEintrag(d.b),
  trefferBei: d.trefferBei,
  aehnlichkeit: d.aehnlichkeit,
  status: d.status,
});

function toGruppe(g: GruppeDto): Gruppe {
  return {
    id: g.id,
    name: g.name,
    mitglieder: g.mitglieder,
    beschreibung: g.beschreibung,
    angelegt: g.erstelltAm,
    geaendert: g.geaendertAm,
    adresslisten: g.adresslisten,
  };
}

const dropEmpty = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== ""),
  ) as Partial<T>;

/** Anschrift im Format der API. Ohne Strasse gibt es keine Anschrift. */
function address(i: { strasse?: string; plz?: string; ort?: string }) {
  return i.strasse && i.plz && i.ort
    ? { strasse: i.strasse, plz: i.plz, ort: i.ort, land: "CH" }
    : undefined;
}

const csvCell = (v: string) => `"${v.replace(/"/g, '""')}"`;

/** Der Import der API liest feste Spalten (siehe Export); aus der Zuordnung entsteht eine solche Datei. */
function toCsv(auftrag: ImportAuftrag): string {
  const header = ["Vorname", "Nachname", "Strasse", "PLZ", "Ort", "E-Mail", "Gruppe"];
  const col = (z: string) => auftrag.zuordnung.indexOf(z as never);
  const rows = auftrag.datei.zeilen.map((cells) => {
    const get = (z: string) => (col(z) >= 0 ? (cells[col(z)] ?? "").trim() : "");
    const plzOrt = /^(\d{4,5})\s+(.+)$/.exec(get("plzOrt"));
    return [
      get("vorname"),
      get("nachname"),
      get("strasse"),
      plzOrt?.[1] ?? "",
      plzOrt?.[2] ?? "",
      get("email"),
      get("gruppe"),
    ];
  });
  return [header, ...rows].map((r) => r.map(csvCell).join(";")).join("\r\n");
}

/**
 * `PersonenService` gegen die API unter `/api` (gleiche Origin, Cookie-Sitzung). Schreibende
 * Anfragen tragen das CSRF-Token im Header. Fehler enthalten nur den Status, nie Text oder Inhalt.
 */
export function createHttpPersonenService(options: Options): PersonenService {
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function send(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    payload?: unknown,
    contentType = "application/json",
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (payload !== undefined) headers["Content-Type"] = contentType;
    const token = options.csrfToken();
    if (token && method !== "GET") headers["X-CSRF-Token"] = token;
    const res = await fetchFn(path, {
      method,
      headers,
      credentials: "same-origin",
      ...(payload === undefined
        ? {}
        : { body: typeof payload === "string" ? payload : JSON.stringify(payload) }),
    });
    if (res.status === 401) options.onUnauthorized();
    if (!res.ok) throw new ApiError(res.status);
    return res.status === 204 ? null : await res.json().catch(() => null);
  }

  const items = <T>(body: unknown): T[] => {
    const list = isRecord(body) ? body["items"] : undefined;
    if (!Array.isArray(list)) throw new Error("Unerwartete Antwort der API (Liste)");
    return list as T[];
  };
  const nextOf = (body: unknown): string | null => {
    const n = isRecord(body) ? body["nextCursor"] : undefined;
    return typeof n === "string" ? n : null;
  };
  const query = (params: Record<string, string | number | boolean | undefined>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params))
      if (v !== undefined && v !== "") sp.set(k, String(v));
    const s = sp.toString();
    return s ? `?${s}` : "";
  };

  const gruppenNamen = async () =>
    new Map(items<GruppeDto>(await send("GET", "/api/gruppen")).map((g) => [g.id, g.name]));

  /** Gesamtzahl eines Filters: eine Abfrage mit einem Eintrag. */
  const totalOf = async (path: string, params: Parameters<typeof query>[0]) => {
    const body = await send("GET", `${path}${query({ ...params, limit: 1 })}`);
    return isRecord(body) && typeof body["total"] === "number" ? body["total"] : null;
  };

  const detail = async (id: string) =>
    toDetail((await send("GET", `/api/mitglieder/${id}`)) as MemberDto, await gruppenNamen());

  /** Gruppe ändern: die API weist nur Personen ohne Gruppe zu, also erst entfernen, dann zuweisen. */
  async function syncGruppe(id: string, current: string | null, wanted: string | null) {
    if (current === wanted) return;
    if (current) await send("DELETE", `/api/mitglieder/${id}/gruppe`);
    if (wanted) await send("PUT", `/api/mitglieder/${id}/gruppe`, { gruppeId: wanted });
  }

  const service: PersonenService = {
    features: httpFeatures,

    async listPersonen(q: PersonQuery): Promise<Page<PersonRow>> {
      // «Alle» = jeder Status ausser den zusammengeführten, «ausgetreten» heisst archiviert.
      const status =
        q.status === "ausgetreten" ? "archiviert" : q.status === undefined ? "alle" : q.status;
      const [namen, body] = await Promise.all([
        gruppenNamen(),
        send(
          "GET",
          `/api/mitglieder${query({
            q: q.q,
            typ: q.typ,
            status,
            gruppeId: q.gruppeId && q.gruppeId !== "ohne" ? q.gruppeId : undefined,
            ohneGruppe: q.gruppeId === "ohne" ? true : undefined,
            firmaId: q.firmaId,
            limit: PAGE,
            cursor: q.cursor,
          })}`,
        ),
      ]);
      const total = isRecord(body) ? body["total"] : undefined;
      return {
        items: items<MemberDto>(body).map((m) => toRow(m, namen)),
        next: nextOf(body),
        total: typeof total === "number" ? total : null,
      };
    },

    getPerson: detail,
    async getFinanzen(id) {
      return toFinanzen((await send("GET", `/api/mitglieder/${id}/finanzen`)) as FinanzenDto);
    },

    async listPersonenFreigaben() {
      const namen = await gruppenNamen();
      // Die ausstehenden zuerst holen: sie dürfen nicht hinter vielen bereits freigegebenen verschwinden.
      const [wartend, alle] = await Promise.all([
        send("GET", `/api/mitglieder${query({ status: "ausstehend", limit: 200 })}`),
        send("GET", `/api/mitglieder${query({ status: "alle", quelle: "selbst", limit: 200 })}`),
      ]);
      const byId = new Map<string, MemberDto>();
      for (const m of [...items<MemberDto>(wartend), ...items<MemberDto>(alle)]) byId.set(m.id, m);
      return [...byId.values()].map((m) => toDetail(m, namen));
    },
    async setPersonFreigabe(id, freigeben) {
      await send("POST", `/api/mitglieder/${id}/${freigeben ? "freigeben" : "ablehnen"}`, {});
    },

    async savePerson(id, input: PersonInput) {
      const common = {
        anrede: input.anrede,
        vorname: input.vorname,
        nachname: input.nachname,
        email: input.email,
        telefon: input.telefon,
        notiz: input.notiz,
        eintritt: input.eintritt,
        kanal: input.kanal,
      };
      if (id === null) {
        const created = (await send(
          "POST",
          "/api/mitglieder",
          dropEmpty(
            input.typ === "firma"
              ? { typ: "firma", firmaId: input.firmaId, funktion: input.funktion, ...common }
              : {
                  typ: "einzel",
                  ...common,
                  geburtsdatum: input.geburtsdatum,
                  adresse: address(input),
                },
          ),
        )) as MemberDto;
        await syncGruppe(created.id, null, input.gruppeId ?? null);
        return detail(created.id);
      }
      const before = (await send("GET", `/api/mitglieder/${id}`)) as MemberDto;
      // `null` löscht ein optionales Feld, `undefined` lässt es unverändert.
      const clear = <T>(v: T | undefined) => (v === undefined || v === "" ? null : v);
      await send("PATCH", `/api/mitglieder/${id}`, {
        anrede: clear(input.anrede),
        vorname: input.vorname,
        nachname: input.nachname,
        email: clear(input.email),
        telefon: clear(input.telefon),
        notiz: clear(input.notiz),
        eintritt: clear(input.eintritt),
        kanal: clear(input.kanal),
        ...(input.typ === "firma"
          ? { funktion: clear(input.funktion), firmaId: input.firmaId }
          : { geburtsdatum: clear(input.geburtsdatum), adresse: address(input) ?? null }),
      });
      await syncGruppe(id, before.gruppeId, input.gruppeId ?? null);
      return detail(id);
    },

    async sammelaktion(ids, aktion, gruppeId) {
      const run = async (a: string, extra: object = {}) =>
        (await send("POST", "/api/mitglieder/sammelaktion", {
          ids,
          aktion: a,
          ...extra,
        })) as ApiBulkResult;
      if (aktion === "gruppe_zuweisen") {
        // «Ersetzt die bisherige Gruppe»: die API meldet sonst einen Konflikt.
        await run("gruppe_entfernen");
        const r = await run("gruppe_zuweisen", { gruppeId });
        return { ok: r.ok, fehler: r.fehler.length };
      }
      const r = await run(aktion);
      return { ok: r.ok, fehler: r.fehler.length };
    },

    async listGruppen() {
      return items<GruppeDto>(await send("GET", "/api/gruppen")).map(toGruppe);
    },
    async countOhneGruppe() {
      return totalOf("/api/mitglieder", { ohneGruppe: true });
    },
    async createGruppe(name, beschreibung) {
      const body = beschreibung ? { name, beschreibung } : { name };
      return toGruppe((await send("POST", "/api/gruppen", body)) as GruppeDto);
    },
    async renameGruppe(id, name) {
      await send("PATCH", `/api/gruppen/${id}`, { name });
    },
    async dissolveGruppe(id) {
      await send("DELETE", `/api/gruppen/${id}`);
    },

    async listFirmen(q) {
      const body = await send(
        "GET",
        `/api/firmen${query({
          limit: PAGE,
          cursor: q.cursor,
          q: q.q,
          quelle: q.quelle,
          status: q.status === "alle" ? undefined : (q.status ?? "freigegeben"),
        })}`,
      );
      const total = isRecord(body) ? body["total"] : undefined;
      return {
        items: items<FirmaDto>(body)
          .filter((f) => f.status !== "zusammengefuehrt")
          .map(toFirma),
        next: nextOf(body),
        // «Alle» enthält auch zusammengeführte Firmen, die hier ausgeblendet sind: Zahl unbekannt.
        total: q.status !== "alle" && typeof total === "number" ? total : null,
      };
    },
    async getFirma(id) {
      return toFirma((await send("GET", `/api/firmen/${id}`)) as FirmaDto);
    },
    async saveFirma(id, input: FirmaInput) {
      const base = {
        name: input.name,
        uid: input.uid,
        mwstNr: input.mwstNr,
        adresse: address(input),
        email: input.email,
        telefon: input.telefon,
        kontaktperson: input.kontaktperson,
        rechnungsEmail: input.rechnungsEmail,
        notiz: input.notiz,
      };
      if (id === null) {
        return toFirma((await send("POST", "/api/firmen", dropEmpty(base))) as FirmaDto);
      }
      const clear = <T>(v: T | undefined) => (v === undefined || v === "" ? null : v);
      return toFirma(
        (await send("PATCH", `/api/firmen/${id}`, {
          name: input.name,
          uid: clear(input.uid),
          mwstNr: clear(input.mwstNr),
          adresse: base.adresse,
          email: clear(input.email),
          telefon: clear(input.telefon),
          kontaktperson: clear(input.kontaktperson),
          rechnungsEmail: clear(input.rechnungsEmail),
          notiz: clear(input.notiz),
        })) as FirmaDto,
      );
    },
    async firmaDuplikate(input, exceptId): Promise<FirmaDuplikat[]> {
      const body = await send(
        "POST",
        "/api/firmen/duplikate",
        dropEmpty({
          name: input.name,
          uid: input.uid,
          mwstNr: input.mwstNr,
          adresse: address(input),
          email: input.email,
          telefon: input.telefon,
        }),
      );
      return items<DuplicateCandidate>(body)
        .filter((d) => d.firma.id !== exceptId)
        .map((d) => ({ firma: toFirma(d.firma), score: d.score, gruende: d.gruende }));
    },
    async firmaMitglieder(firmaId) {
      const namen = await gruppenNamen();
      const body = await send("GET", `/api/mitglieder${query({ firmaId, limit: 200 })}`);
      return items<MemberDto>(body).map((m) => toDetail(m, namen));
    },
    async setFirmaFreigabe(id, freigeben) {
      return toFirma(
        (await send(
          "POST",
          `/api/firmen/${id}/${freigeben ? "freigeben" : "ablehnen"}`,
          {},
        )) as FirmaDto,
      );
    },

    async listDuplikate() {
      return items<DuplikatDto>(await send("GET", "/api/duplikate")).map(toDuplikat);
    },
    async getDuplikat(id) {
      return toDuplikat((await send("GET", `/api/duplikate/${id}`)) as DuplikatDto);
    },
    async setKeinDuplikat(id) {
      await send("POST", `/api/duplikate/${id}/kein-duplikat`, {});
    },
    async merge(duplikatId, input) {
      // Die Oberfläche liefert die gewählten Werte; die API will wissen, von welcher Seite.
      const d = (await send("GET", `/api/duplikate/${duplikatId}`)) as DuplikatDto;
      const [behalten, entfernen] = d.a.id === input.behaltenId ? [d.a, d.b] : [d.b, d.a];
      const werte: Record<string, "behalten" | "entfernen"> = {};
      for (const [feld, wert] of Object.entries(input.werte) as Array<
        [keyof DuplikatDto["a"]["felder"], string]
      >) {
        if (behalten.felder[feld] === wert) werte[feld] = "behalten";
        else if (entfernen.felder[feld] === wert) werte[feld] = "entfernen";
      }
      await send("POST", `/api/duplikate/${duplikatId}/zusammenfuehren`, {
        behaltenId: input.behaltenId,
        werte,
      });
    },

    async importPruefen(auftrag) {
      return importieren(auftrag, true);
    },
    async importAusfuehren(auftrag) {
      return importieren(auftrag, false);
    },
  };

  async function importieren(auftrag: ImportAuftrag, dryRun: boolean): Promise<ImportErgebnis> {
    const { duplikatePruefen, aktualisieren, gruppeFuerAlle } = auftrag.optionen;
    const report = (await send(
      "POST",
      `/api/mitglieder/import${query({
        dryRun,
        aktualisieren: aktualisieren || undefined,
        // Ohne Prüfung gilt eine bekannte E-Mail-Adresse als Fehler (sie ist je Verein eindeutig).
        duplikate: duplikatePruefen ? "ueberspringen" : undefined,
        gruppeId: gruppeFuerAlle ?? undefined,
      })}`,
      toCsv(auftrag),
      "text/csv",
    )) as {
      zeilen: number;
      importiert: number;
      aktualisiert: number;
      uebersprungen: number;
      fehler: Array<{ zeile: number; grund: string; felder: string[] }>;
    };
    // Doppelte E-Mail-Adressen innerhalb der Datei zählen als Duplikate, wenn geprüft wird.
    const doppelt = duplikatePruefen
      ? report.fehler.filter((f) => f.grund === "E_MAIL_DOPPELT").length
      : 0;
    return {
      zeilen: report.zeilen,
      neu: dryRun
        ? report.zeilen - report.fehler.length - report.uebersprungen - report.aktualisiert
        : report.importiert,
      duplikate: report.uebersprungen + report.aktualisiert + doppelt,
      fehlerhaft: report.fehler.length - doppelt,
      fehler: report.fehler.map(({ zeile, felder }) => ({ zeile, felder })),
    };
  }

  return service;
}
