import {
  FieldErrors,
  type Duplikat,
  type Features,
  type Finanzen,
  type Firma,
  type FirmaDuplikat,
  type Gruppe,
  type ImportAuftrag,
  type ImportErgebnis,
  type Page,
  type PersonDetail,
  type PersonInput,
  type PersonRow,
} from "./model";
import type { PersonenService } from "./service";

/** Alle Funktionen verfügbar, wie im Design vorgesehen. */
export const allFeatures: Features = {
  personExtras: true,
  finanzen: true,
  firmaFinanzen: true,
  gruppenDetails: true,
  firmaExtras: true,
  duplikate: true,
  importOptionen: true,
  statusAusstehend: true,
};

const PAGE_SIZE = 50;

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "de-CH");

interface Seed {
  personen: PersonDetail[];
  gruppen: Gruppe[];
  firmen: Firma[];
  duplikate: Duplikat[];
  finanzen: Record<string, Finanzen>;
  ohneGruppe: number;
}

function person(
  id: string,
  nr: string,
  name: string,
  typ: PersonDetail["typ"],
  ort: string,
  gruppe: string | null,
  status: PersonDetail["status"],
  extra: Partial<PersonDetail> = {},
): PersonDetail {
  const [vorname = "", ...rest] = name.split(" ");
  return {
    id,
    nr,
    name,
    typ,
    ort,
    gruppeId: gruppe ? `g-${gruppe}` : null,
    gruppeName: gruppe,
    status,
    anrede: null,
    vorname,
    nachname: rest.join(" "),
    email: null,
    telefon: null,
    strasse: null,
    plz: null,
    ortAdresse: ort,
    notiz: null,
    funktion: null,
    firmaId: null,
    firmaName: null,
    geburtsdatum: null,
    eintritt: null,
    kanal: null,
    gruppeSeit: null,
    erstelltAm: "2026-10-30T09:12:00",
    quelle: status === "ausstehend" ? "selbst" : null,
    ...extra,
  };
}

function firma(
  id: string,
  name: string,
  uid: string,
  plz: string,
  quelle: Firma["quelle"],
  mitglieder: number,
  extra: Partial<Firma> = {},
): Firma {
  return {
    id,
    name,
    uid,
    mwstNr: null,
    strasse: "Musterweg 1",
    plz,
    ort: "Musterhausen",
    email: null,
    telefon: null,
    status: "freigegeben",
    erstelltAm: "2020-03-01T08:00:00",
    quelle,
    mitglieder,
    erfasstVon: null,
    kontaktperson: null,
    rechnungsEmail: null,
    notiz: null,
    ...extra,
  };
}

function gruppe(
  name: string,
  mitglieder: number,
  angelegt: string,
  extra: Partial<Gruppe> = {},
): Gruppe {
  return {
    id: `g-${name}`,
    name,
    mitglieder,
    beschreibung: null,
    angelegt,
    geaendert: angelegt,
    adresslisten: [],
    ...extra,
  };
}

/** Beispieldaten aus dem Design (Boards 3.1 bis 3.15). Nur für Tests und Entwicklung. */
export function designSeed(): Seed {
  const personen = [
    person(
      "p-1001",
      "M-1001",
      "Anna Beispiel",
      "einzel",
      "Musterhausen",
      "Aktivmitglieder",
      "aktiv",
      {
        anrede: "frau",
        vorname: "Anna",
        nachname: "Beispiel",
        geburtsdatum: "1985-03-14",
        eintritt: "2019-01-01",
        strasse: "Beispielstrasse 12",
        plz: "8000",
        email: "anna.beispiel@example.ch",
        telefon: "+41 44 000 00 01",
        kanal: "email",
        gruppeSeit: "2019-01-01",
        notiz: "Kassenführung 2024 bis 2026. Rechnungen bitte per E-Mail senden.",
      },
    ),
    person("p-1008", "M-1008", "Beat Demo", "einzel", "Beispieldorf", "Aktivmitglieder", "aktiv"),
    person(
      "p-1042",
      "M-1042",
      "Beispiel Treuhand AG",
      "firma",
      "Musterhausen",
      "Passivmitglieder",
      "aktiv",
      {
        vorname: "Beat",
        nachname: "Muster",
        firmaId: "f-treuhand",
        firmaName: "Beispiel Treuhand AG",
        eintritt: "2020-03-01",
        strasse: "Probegasse 4",
        plz: "8001",
        email: "info@beispiel-treuhand.example.ch",
        telefon: "+41 44 000 00 02",
        gruppeSeit: "2020-03-01",
        funktion: "Geschäftsführung",
        notiz: "Rechnung immer an die Buchhaltung. Beitrag gemäss Firmentarif.",
      },
    ),
    person(
      "p-1015",
      "M-1015",
      "Claudia Vorlage",
      "einzel",
      "Probikon",
      "Passivmitglieder",
      "ausstehend",
    ),
    person("p-1022", "M-1022", "Daniel Test", "einzel", "Demoswil", null, "aktiv"),
    person("p-1029", "M-1029", "Eva Probe", "einzel", "Musterhausen", "Helferteam", "ausgetreten"),
    person("p-1036", "M-1036", "Fabian Muster", "einzel", "Beispieldorf", "Jugend", "aktiv"),
    person(
      "p-1043",
      "M-1043",
      "Gabi Beispiel",
      "einzel",
      "Musterhausen",
      "Ehrenmitglieder",
      "aktiv",
    ),
    person("p-1050", "M-1050", "Hans Demo", "einzel", "Probikon", "Gönner", "ausstehend"),
    person("p-1057", "M-1057", "Irene Vorlage", "einzel", "Musterhausen", "Vorstand", "aktiv"),
    person(
      "p-1064",
      "M-1064",
      "Jonas Test",
      "einzel",
      "Demoswil",
      "Aktivmitglieder",
      "ausgetreten",
    ),
    person("p-1071", "M-1071", "Karin Probe", "einzel", "Musterhausen", null, "aktiv"),
    person("p-1078", "M-1078", "Lukas Muster", "einzel", "Beispieldorf", "Revision", "aktiv"),
    person("p-1085", "M-1085", "Maria Beispiel", "einzel", "Probikon", "Helferteam", "ausstehend"),
    person("p-1092", "M-1092", "Nico Demo", "einzel", "Musterhausen", "Jugend", "aktiv"),
    person(
      "p-1099",
      "M-1099",
      "Olivia Vorlage",
      "einzel",
      "Demoswil",
      "Ehrenmitglieder",
      "ausgetreten",
    ),
  ];

  const gruppen = [
    gruppe("Aktivmitglieder", 412, "2018-01-12"),
    gruppe("Ehrenmitglieder", 14, "2018-01-12"),
    gruppe("Gönner", 71, "2022-11-09"),
    gruppe("Helferteam", 64, "2021-05-18", {
      geaendert: "2026-10-14",
      adresslisten: ["Sommerfest", "Helferaufruf"],
    }),
    gruppe("Jugend", 96, "2020-09-02"),
    gruppe("Neumitglieder 2026", 41, "2026-01-04"),
    gruppe("Passivmitglieder", 538, "2018-01-12"),
    gruppe("Redaktion", 9, "2023-06-21"),
    gruppe("Revision", 3, "2019-03-05"),
    gruppe("Veranstaltungsteam", 22, "2024-02-14"),
    gruppe("Vorstand", 7, "2018-01-12"),
  ];

  const firmen = [
    firma("f-ag", "Beispiel AG", "CHE-110.220.330", "8000", "manuell", 1),
    firma("f-baeckerei", "Beispiel Bäckerei GmbH", "CHE-119.227.343", "8013", "manuell", 1),
    firma("f-gastro", "Beispiel Gastro GmbH", "CHE-128.234.356", "8006", "manuell", 1),
    firma("f-treuhand", "Beispiel Treuhand AG", "CHE-123.456.789", "8001", "manuell", 1, {
      mwstNr: "CHE-123.456.789 MWST",
      strasse: "Probegasse 4",
      erfasstVon: "Sabine Muster",
      email: "info@beispiel-treuhand.example.ch",
      telefon: "+41 44 000 00 02",
      kontaktperson: "Beat Muster",
      rechnungsEmail: "buchhaltung@beispiel-treuhand.example.ch",
    }),
    firma("f-gaertnerei", "Demo Gärtnerei GmbH", "CHE-456.789.012", "8015", "selbst", 1, {
      erstelltAm: "2026-10-28T11:05:00",
    }),
    firma("f-handels", "Demo Handels AG", "CHE-155.255.395", "8005", "manuell", 1),
    firma("f-immobilien", "Demo Immobilien AG", "CHE-164.262.408", "8010", "manuell", 2),
    firma("f-garage", "Muster Garage AG", "CHE-173.269.421", "8007", "manuell", 2),
    firma("f-muster", "Muster GmbH", "CHE-182.276.434", "8001", "manuell", 1),
    firma("f-reisen", "Muster Reisen AG", "CHE-191.283.447", "8012", "manuell", 0),
    firma("f-druck", "Probe Druck AG", "CHE-567.890.123", "8009", "selbst", 1, {
      erstelltAm: "2026-10-26T15:48:00",
    }),
    firma("f-partner", "Probe und Partner AG", "CHE-209.297.473", "8002", "manuell", 2),
    firma("f-elektro", "Test Elektro GmbH", "CHE-218.304.486", "8008", "manuell", 1),
    firma("f-logistik", "Test Logistik AG", "CHE-227.311.499", "8014", "manuell", 1),
    firma("f-bau", "Vorlage Bau AG", "CHE-236.318.512", "8004", "manuell", 1),
    firma("f-software", "Vorlage Software GmbH", "CHE-245.325.525", "8011", "manuell", 1),
    firma("f-baeckerei2", "Muster Bäckerei GmbH", "CHE-234.567.890", "8004", "selbst", 0, {
      status: "ausstehend",
      mwstNr: "CHE-234.567.890 MWST",
      strasse: "Musterweg 7",
      kontaktperson: "Claudia Test",
      email: "info@muster-baeckerei.example.ch",
      erstelltAm: "2026-11-02T09:12:00",
    }),
    firma("f-elektro2", "Probe Elektro GmbH", "CHE-345.678.901", "8003", "selbst", 0, {
      status: "ausstehend",
      erstelltAm: "2026-11-01T18:40:00",
    }),
    firma("f-catering", "Probe Catering GmbH", "CHE-678.901.234", "8003", "selbst", 0, {
      status: "abgelehnt",
      erstelltAm: "2026-10-20T08:30:00",
    }),
  ];

  const garageA = {
    id: "f-garage",
    name: "Muster Garage AG",
    nr: "M-1141",
    rechnungen: 3,
    felder: {
      name: "Muster Garage AG",
      uid: "CHE-173.269.421",
      mwstNr: "CHE-173.269.421 MWST",
      strasse: "Vorlagenstrasse 17",
      plzOrt: "8007 Musterhausen",
      email: "info@muster-garage.example.ch",
      telefon: "+41 44 000 00 05",
      eintritt: "12.05.2019",
    },
  };
  const garageB = {
    id: "f-garage-2",
    name: "Muster Garage AG",
    nr: "M-1218",
    rechnungen: 1,
    felder: {
      name: "Muster Garage AG",
      uid: "CHE-173.269.421",
      mwstNr: "CHE-173.269.421",
      strasse: "Vorlagenstrasse 17a",
      plzOrt: "8007 Musterhausen",
      email: "werkstatt@muster-garage.example.ch",
      telefon: "+41 44 000 00 15",
      eintritt: "14.10.2026",
    },
  };
  const eintrag = (name: string, nr: string) => ({ id: nr, name, nr, rechnungen: 0, felder: {} });
  const dup = (
    id: string,
    art: Duplikat["art"],
    a: Duplikat["a"],
    b: Duplikat["b"],
    trefferBei: Duplikat["trefferBei"],
    aehnlichkeit: number,
    status: Duplikat["status"] = "offen",
  ): Duplikat => ({ id, art, a, b, trefferBei, aehnlichkeit, status });
  const duplikate = [
    dup("d1", "firma", garageA, garageB, ["uid", "mwst"], 100),
    dup(
      "d2",
      "person",
      eintrag("Anna Beispiel", "M-1001"),
      eintrag("Ana Beispiel", "M-1243"),
      ["name"],
      98,
    ),
    dup(
      "d3",
      "firma",
      eintrag("Probe und Partner AG", "M-1175"),
      eintrag("Probe & Partner AG", "M-1196"),
      ["name", "mwst"],
      95,
    ),
    dup(
      "d4",
      "person",
      eintrag("Maria Test", "M-1182"),
      eintrag("Marie Test", "M-1266"),
      ["name"],
      93,
    ),
    dup(
      "d5",
      "firma",
      eintrag("Demo Immobilien AG", "M-1160"),
      eintrag("Demo Immobilien AG", "M-1224"),
      ["uid"],
      91,
    ),
    dup(
      "d6",
      "person",
      eintrag("Karin Demo", "M-1154"),
      eintrag("Karin Demo-Probe", "M-1251"),
      ["name"],
      88,
    ),
    dup(
      "d7",
      "person",
      eintrag("Hans Muster", "M-1139"),
      eintrag("Hans Muster-Test", "M-1260"),
      ["name"],
      84,
    ),
    dup(
      "d8",
      "person",
      eintrag("Lukas Vorlage", "M-1167"),
      eintrag("Lucas Vorlage", "M-1237"),
      ["name"],
      78,
      "kein_duplikat",
    ),
  ];

  const finanzen: Record<string, Finanzen> = {
    "p-1001": {
      rechnungen: [
        { nr: "R-2026-0412", datum: "2026-10-01", betrag: 12000, status: "offen" },
        { nr: "R-2026-0118", datum: "2026-01-15", betrag: 24000, status: "bezahlt" },
        { nr: "R-2025-0377", datum: "2025-01-15", betrag: 24000, status: "bezahlt" },
        { nr: "R-2024-0391", datum: "2024-01-15", betrag: 22000, status: "bezahlt" },
      ],
      konto: { offen: 12000, bezahltJahr: 24000, mahnstufe: "Keine", letzteZahlung: "2026-09-12" },
      mails: 6,
      verlauf: [{ datum: "2026-10-01", text: "Rechnung R-2026-0412 versendet" }],
    },
    "p-1042": {
      rechnungen: [
        { nr: "R-2026-0301", datum: "2026-09-15", betrag: 125000, status: "bezahlt" },
        { nr: "R-2025-0288", datum: "2025-09-15", betrag: 125000, status: "bezahlt" },
        { nr: "R-2024-0275", datum: "2024-09-15", betrag: 118000, status: "bezahlt" },
      ],
      konto: { offen: 0, bezahltJahr: 125000, mahnstufe: "Keine", letzteZahlung: "2026-10-03" },
      mails: 2,
      verlauf: [],
    },
    "f-treuhand": {
      rechnungen: [
        { nr: "R-2026-0301", datum: "2026-09-15", betrag: 125000, status: "bezahlt" },
        { nr: "R-2025-0288", datum: "2025-09-15", betrag: 125000, status: "bezahlt" },
        { nr: "R-2024-0275", datum: "2024-09-15", betrag: 118000, status: "bezahlt" },
      ],
      konto: { offen: 0, bezahltJahr: 125000, mahnstufe: "Keine", letzteZahlung: "2026-10-03" },
      mails: 2,
      verlauf: [
        { datum: "2026-10-14", text: "Kontaktperson Eva Probe ergänzt" },
        { datum: "2026-10-03", text: "Zahlung CHF 1'250.00 zugeordnet" },
        { datum: "2026-09-15", text: "Rechnung R-2026-0301 versendet" },
        { datum: "2020-03-01", text: "Firma erfasst" },
      ],
    },
  };

  return { personen, gruppen, firmen, duplikate, finanzen, ohneGruppe: 7 };
}

const ort = (p: PersonDetail) => p.ortAdresse ?? p.ort;

/**
 * Dienst im Speicher (Tests, Entwicklung). Verhält sich wie die API: Eine Person hat höchstens
 * eine Gruppe, zusammengeführte Einträge verschwinden. Verwendet im Betrieb nie Beispieldaten.
 */
export function createMemoryPersonenService(
  seed: Seed = designSeed(),
  features: Features = allFeatures,
): PersonenService {
  const personen = [...seed.personen];
  const gruppen = [...seed.gruppen];
  const firmen = [...seed.firmen];
  const duplikate = [...seed.duplikate];
  let counter = 2000;
  let ohne = seed.ohneGruppe;

  const row = (p: PersonDetail): PersonRow => ({
    id: p.id,
    nr: p.nr,
    name: p.name,
    typ: p.typ,
    ort: ort(p),
    gruppeId: p.gruppeId,
    gruppeName: p.gruppeName,
    status: p.status,
  });
  const find = <T extends { id: string }>(list: T[], id: string): T => {
    const hit = list.find((x) => x.id === id);
    if (!hit) throw new Error("Nicht gefunden");
    return hit;
  };
  const setGruppe = (p: PersonDetail, g: Gruppe | null) => {
    const old = gruppen.find((x) => x.id === p.gruppeId);
    if (old) old.mitglieder -= 1;
    if (g) g.mitglieder += 1;
    if (old && !g) ohne += 1;
    if (!old && g) ohne -= 1;
    p.gruppeId = g?.id ?? null;
    p.gruppeName = g?.name ?? null;
    p.gruppeSeit = g ? new Date().toISOString().slice(0, 10) : null;
  };
  const page = <T>(all: T[], cursor: string | undefined): Page<T> => {
    const start = cursor ? Number(cursor) : 0;
    const end = start + PAGE_SIZE;
    return {
      items: all.slice(start, end),
      next: end < all.length ? String(end) : null,
      total: all.length,
    };
  };
  const nameOf = (i: PersonInput) =>
    i.typ === "firma" ? find(firmen, i.firmaId ?? "").name : `${i.vorname} ${i.nachname}`;

  const service: PersonenService = {
    features,

    async listPersonen(q) {
      const needle = q.q?.trim().toLowerCase();
      const hits = personen
        .filter(
          (p) =>
            (!needle ||
              [p.name, p.nr ?? "", ort(p) ?? ""].some((v) => v.toLowerCase().includes(needle))) &&
            (!q.typ || p.typ === q.typ) &&
            (!q.status || p.status === q.status) &&
            (!q.firmaId || p.firmaId === q.firmaId) &&
            (!q.gruppeId ||
              (q.gruppeId === "ohne" ? p.gruppeId === null : p.gruppeId === q.gruppeId)),
        )
        .sort(byName);
      return page(hits.map(row), q.cursor);
    },
    async getPerson(id) {
      return { ...find(personen, id) };
    },
    async getFinanzen(id) {
      return (
        seed.finanzen[id] ?? {
          rechnungen: [],
          konto: { offen: 0, bezahltJahr: 0, mahnstufe: "Keine", letzteZahlung: null },
          mails: 0,
          verlauf: [],
        }
      );
    },
    async listPersonenFreigaben() {
      return personen
        .filter(
          (p) => p.status === "ausstehend" || p.status === "abgelehnt" || p.quelle === "selbst",
        )
        .map((p) => ({ ...p }));
    },
    async setPersonFreigabe(id, freigeben) {
      find(personen, id).status = freigeben ? "aktiv" : "abgelehnt";
    },
    async savePerson(id, input) {
      const target = input.gruppeId ? find(gruppen, input.gruppeId) : null;
      const patch = {
        typ: input.typ,
        anrede: input.anrede ?? null,
        vorname: input.vorname,
        nachname: input.nachname,
        email: input.email ?? null,
        telefon: input.telefon ?? null,
        strasse: input.strasse ?? null,
        plz: input.plz ?? null,
        ortAdresse: input.ort ?? null,
        notiz: input.notiz ?? null,
        funktion: input.funktion ?? null,
        firmaId: input.firmaId ?? null,
        firmaName: input.firmaId ? find(firmen, input.firmaId).name : null,
        geburtsdatum: input.geburtsdatum ?? null,
        eintritt: input.eintritt ?? null,
        kanal: input.kanal ?? null,
        name: nameOf(input),
      };
      if (id === null) {
        counter += 1;
        const p = person(
          `p-${counter}`,
          `M-${counter}`,
          patch.name,
          input.typ,
          input.ort ?? "",
          null,
          "aktiv",
        );
        Object.assign(p, patch);
        personen.push(p);
        ohne += 1;
        setGruppe(p, target);
        return { ...p };
      }
      const p = find(personen, id);
      Object.assign(p, patch);
      if (p.gruppeId !== (target?.id ?? null)) setGruppe(p, target);
      return { ...p };
    },
    async sammelaktion(ids, aktion, gruppeId) {
      const target = gruppeId ? find(gruppen, gruppeId) : null;
      for (const id of ids) {
        const p = find(personen, id);
        if (aktion === "gruppe_zuweisen") setGruppe(p, target);
        else if (aktion === "gruppe_entfernen") setGruppe(p, null);
        else p.status = aktion === "archivieren" ? "ausgetreten" : "aktiv";
      }
      return { ok: ids.length, fehler: 0 };
    },

    async listGruppen() {
      return [...gruppen].sort(byName).map((g) => ({ ...g }));
    },
    async countOhneGruppe() {
      return ohne;
    },
    async createGruppe(name, beschreibung) {
      if (gruppen.some((g) => g.name.toLowerCase() === name.toLowerCase())) {
        throw new FieldErrors({ name: "Eine Gruppe mit diesem Namen gibt es schon." });
      }
      const today = new Date().toISOString().slice(0, 10);
      const g = gruppe(name, 0, today, { beschreibung: beschreibung ?? null });
      gruppen.push(g);
      return { ...g };
    },
    async renameGruppe(id, name) {
      const g = find(gruppen, id);
      g.name = name;
      g.geaendert = new Date().toISOString().slice(0, 10);
      for (const p of personen) if (p.gruppeId === id) p.gruppeName = name;
    },
    async dissolveGruppe(id) {
      const g = find(gruppen, id);
      for (const p of personen) if (p.gruppeId === id) setGruppe(p, null);
      gruppen.splice(gruppen.indexOf(g), 1);
    },

    async listFirmen(q) {
      const needle = q.q?.trim().toLowerCase();
      const hits = firmen
        .filter(
          (f) =>
            (q.status === "alle" || f.status === (q.status ?? "freigegeben")) &&
            (!q.quelle || f.quelle === q.quelle) &&
            (!needle ||
              [f.name, f.uid ?? "", f.mwstNr ?? ""].some((v) => v.toLowerCase().includes(needle))),
        )
        .sort(byName);
      return page(hits, q.cursor);
    },
    async getFirma(id) {
      return { ...find(firmen, id) };
    },
    async saveFirma(id, input) {
      const patch = {
        name: input.name,
        uid: input.uid ?? null,
        mwstNr: input.mwstNr ?? null,
        strasse: input.strasse,
        plz: input.plz,
        ort: input.ort,
        email: input.email ?? null,
        telefon: input.telefon ?? null,
        kontaktperson: input.kontaktperson ?? null,
        rechnungsEmail: input.rechnungsEmail ?? null,
        notiz: input.notiz ?? null,
      };
      if (id === null) {
        counter += 1;
        const f = firma(`f-${counter}`, input.name, input.uid ?? "", input.plz, "manuell", 0, {
          ...patch,
          erstelltAm: new Date().toISOString(),
          erfasstVon: "Sabine Muster",
        });
        firmen.push(f);
        return { ...f };
      }
      const f = find(firmen, id);
      Object.assign(f, patch);
      return { ...f };
    },
    async firmaDuplikate(input, exceptId) {
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      return firmen
        .filter((f) => f.id !== exceptId && f.status !== "abgelehnt")
        .flatMap((f): FirmaDuplikat[] => {
          const gruende: FirmaDuplikat["gruende"] = [];
          if (input.uid && f.uid === input.uid) gruende.push("uid");
          if (input.mwstNr && f.mwstNr === input.mwstNr) gruende.push("mwst");
          if (norm(f.name) === norm(input.name)) gruende.push("name");
          return gruende.length > 0 ? [{ firma: { ...f }, score: 1, gruende }] : [];
        });
    },
    async firmaMitglieder(firmaId) {
      return personen.filter((p) => p.firmaId === firmaId).map((p) => ({ ...p }));
    },
    async setFirmaFreigabe(id, freigeben) {
      const f = find(firmen, id);
      f.status = freigeben ? "freigegeben" : "abgelehnt";
      return { ...f };
    },

    async listDuplikate() {
      return duplikate.map((d) => ({ ...d }));
    },
    async getDuplikat(id) {
      return { ...find(duplikate, id) };
    },
    async setKeinDuplikat(id) {
      find(duplikate, id).status = "kein_duplikat";
    },
    async merge(duplikatId) {
      duplikate.splice(duplikate.indexOf(find(duplikate, duplikatId)), 1);
    },

    async importPruefen(auftrag) {
      return pruefen(auftrag, personen);
    },
    async importAusfuehren(auftrag) {
      const result = pruefen(auftrag, personen);
      const col = (z: string) => auftrag.zuordnung.indexOf(z as never);
      for (const cells of auftrag.datei.zeilen) {
        const vorname = cells[col("vorname")]?.trim();
        const nachname = cells[col("nachname")]?.trim();
        if (!vorname || !nachname) continue;
        counter += 1;
        const p = person(
          `p-${counter}`,
          `M-${counter}`,
          `${vorname} ${nachname}`,
          "einzel",
          "",
          null,
          "aktiv",
        );
        p.vorname = vorname;
        p.nachname = nachname;
        p.email = cells[col("email")]?.trim() || null;
        personen.push(p);
        ohne += 1;
      }
      return result;
    },
  };
  return service;
}

function pruefen(auftrag: ImportAuftrag, personen: PersonDetail[]): ImportErgebnis {
  const col = (z: string) => auftrag.zuordnung.indexOf(z as never);
  const known = new Set(personen.flatMap((p) => (p.email ? [p.email.toLowerCase()] : [])));
  let duplikate = 0;
  const fehler: ImportErgebnis["fehler"] = [];
  auftrag.datei.zeilen.forEach((cells, i) => {
    const felder = ["vorname", "nachname"].filter((k) => !cells[col(k)]?.trim());
    if (felder.length > 0) {
      fehler.push({ zeile: i + 2, felder });
      return;
    }
    const email = cells[col("email")]?.trim().toLowerCase();
    if (email && known.has(email)) duplikate += 1;
  });
  const zeilen = auftrag.datei.zeilen.length;
  return {
    zeilen,
    neu: zeilen - duplikate - fehler.length,
    duplikate,
    fehlerhaft: fehler.length,
    fehler,
  };
}
