import type {
  BulkResult as ApiBulkResult,
  DuplicateCandidate,
  FirmaDto,
  GruppeDto,
  MemberDto,
} from "@stammbuch/shared";
import {
  ApiError,
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

/** Was die API heute nicht liefert, bleibt aus: die Oberfläche blendet die zugehörigen Felder aus. */
export const httpFeatures: Features = {
  personExtras: false,
  finanzen: false,
  gruppenDetails: false,
  firmaExtras: false,
  duplikate: false,
  importOptionen: false,
  statusAusstehend: false,
};

const PAGE = 50;
const unsupported = () => Promise.reject(new Error("Von der API nicht unterstützt"));

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
  m.status === "aktiv" ? "aktiv" : "ausgetreten";

function toRow(m: MemberDto, gruppen: Map<string, string>): PersonRow {
  return {
    id: m.id,
    nr: null,
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
    geburtsdatum: null,
    eintritt: null,
    kanal: null,
    gruppeSeit: null,
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
    quelle: null,
    mitglieder: null,
    erfasstVon: null,
    kontaktperson: null,
    rechnungsEmail: null,
    notiz: null,
  };
}

function toGruppe(g: GruppeDto): Gruppe {
  return {
    id: g.id,
    name: g.name,
    mitglieder: g.mitglieder,
    beschreibung: null,
    angelegt: null,
    geaendert: null,
    adresslisten: null,
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
  const header = ["Vorname", "Nachname", "Strasse", "PLZ", "Ort", "E-Mail"];
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
      // «Alle» heisst aktive und ausgetretene (= archivierte): zwei Abfragen, die der Cursor verkettet.
      const phases =
        q.status === "aktiv"
          ? ["aktiv"]
          : q.status === "ausgetreten"
            ? ["archiviert"]
            : ["aktiv", "archiviert"];
      if (q.status === "ausstehend") return { items: [], next: null, total: 0 };
      let [phase, cursor] = (() => {
        const m = /^(\d+):(.*)$/.exec(q.cursor ?? "");
        return m ? [Number(m[1]), m[2] || undefined] : [0, undefined];
      })() as [number, string | undefined];

      const namen = await gruppenNamen();
      for (;;) {
        const body = await send(
          "GET",
          `/api/mitglieder${query({
            limit: PAGE,
            cursor,
            q: q.q,
            typ: q.typ,
            status: phases[phase],
            gruppeId: q.gruppeId && q.gruppeId !== "ohne" ? q.gruppeId : undefined,
            ohneGruppe: q.gruppeId === "ohne" ? true : undefined,
            firmaId: q.firmaId,
          })}`,
        );
        const rows = items<MemberDto>(body).map((m) => toRow(m, namen));
        const next = nextOf(body);
        if (next) return { items: rows, next: `${phase}:${next}`, total: null };
        if (phase + 1 >= phases.length) return { items: rows, next: null, total: null };
        phase += 1;
        cursor = undefined;
        if (rows.length > 0) return { items: rows, next: `${phase}:`, total: null };
      }
    },

    getPerson: detail,
    getFinanzen: unsupported,

    async savePerson(id, input: PersonInput) {
      const common = {
        anrede: input.anrede,
        vorname: input.vorname,
        nachname: input.nachname,
        email: input.email,
        telefon: input.telefon,
        notiz: input.notiz,
      };
      if (id === null) {
        const created = (await send(
          "POST",
          "/api/mitglieder",
          dropEmpty(
            input.typ === "firma"
              ? { typ: "firma", firmaId: input.firmaId, funktion: input.funktion, ...common }
              : { typ: "einzel", ...common, adresse: address(input) },
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
        ...(input.typ === "firma"
          ? { funktion: clear(input.funktion), firmaId: input.firmaId }
          : { adresse: address(input) ?? null }),
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
      const body = await send("GET", `/api/mitglieder${query({ ohneGruppe: true, limit: 200 })}`);
      return nextOf(body) ? null : items(body).length;
    },
    async createGruppe(name) {
      return toGruppe((await send("POST", "/api/gruppen", { name })) as GruppeDto);
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
          status: q.status === "alle" ? undefined : (q.status ?? "freigegeben"),
        })}`,
      );
      return {
        items: items<FirmaDto>(body)
          .filter((f) => f.status !== "zusammengefuehrt")
          .map(toFirma),
        next: nextOf(body),
        total: null,
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

    listDuplikate: unsupported,
    getDuplikat: unsupported,
    setKeinDuplikat: unsupported,
    merge: unsupported,

    async importPruefen(auftrag) {
      return importieren(auftrag, true);
    },
    async importAusfuehren(auftrag) {
      return importieren(auftrag, false);
    },
  };

  async function importieren(auftrag: ImportAuftrag, dryRun: boolean): Promise<ImportErgebnis> {
    const report = (await send(
      "POST",
      `/api/mitglieder/import?dryRun=${dryRun}`,
      toCsv(auftrag),
      "text/csv",
    )) as {
      zeilen: number;
      importiert: number;
      fehler: Array<{ zeile: number; grund: string; felder: string[] }>;
    };
    const duplikate = report.fehler.filter((f) => f.grund === "E_MAIL_DOPPELT").length;
    const fehlerhaft = report.fehler.length - duplikate;
    return {
      zeilen: report.zeilen,
      neu: dryRun ? report.zeilen - report.fehler.length : report.importiert,
      duplikate,
      fehlerhaft,
      fehler: report.fehler.map(({ zeile, felder }) => ({ zeile, felder })),
    };
  }

  return service;
}
