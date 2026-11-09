import { describe, expect, it, vi } from "vitest";
import { createHttpPersonenService } from "./httpPersonenService";
import { ApiError } from "./model";

const member = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  mitgliedsnr: "M-1001",
  geburtsdatum: "1985-03-14",
  eintritt: "2019-01-01",
  kanal: "post",
  gruppeSeit: "2019-02-01T08:00:00.000Z",
  typ: "einzel",
  status: "aktiv",
  anrede: "frau",
  vorname: "Anna",
  nachname: "Beispiel",
  email: "anna@example.ch",
  telefon: null,
  mobil: null,
  adresse: {
    strasse: "Beispielstrasse",
    hausnr: "12",
    plz: "8000",
    ort: "Musterhausen",
    land: "CH",
  },
  notiz: null,
  funktion: null,
  firmaId: null,
  firmaName: null,
  gruppeId: "22222222-2222-4222-8222-222222222222",
  erstelltAm: "2026-01-01T00:00:00.000Z",
  geaendertAm: "2026-01-01T00:00:00.000Z",
  ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status });

function setup(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as unknown as typeof fetch;
  const onUnauthorized = vi.fn();
  const service = createHttpPersonenService({ csrfToken: () => "tok", onUnauthorized, fetchFn });
  return { service, calls, onUnauthorized };
}

describe("HTTP-Personendienst", () => {
  it("liest Mitglieder mit Gruppenname und ohne erfundene Felder", async () => {
    const { service } = setup((url) =>
      url.startsWith("/api/gruppen")
        ? json({
            items: [{ id: "22222222-2222-4222-8222-222222222222", name: "Jugend", mitglieder: 3 }],
          })
        : json({ items: [member()], nextCursor: null, total: 7 }),
    );
    const page = await service.listPersonen({ status: "aktiv" });
    expect(page).toMatchObject({ next: null, total: 7 });
    expect(page.items[0]).toMatchObject({
      name: "Anna Beispiel",
      nr: "M-1001",
      gruppeName: "Jugend",
      status: "aktiv",
      ort: "Musterhausen",
    });
    // Rechnungen sind nicht mit Personen verknüpft: Finanzen und Status «Ausstehend» bleiben aus.
    expect(service.features.finanzen).toBe(false);
    expect(service.features.statusAusstehend).toBe(false);
    expect(service.features.personExtras).toBe(true);
  });

  it("zeigt Zusatzfelder der Person (Geburtsdatum, Eintritt, Kanal, Gruppe seit)", async () => {
    const { service } = setup((url) =>
      url.startsWith("/api/gruppen") ? json({ items: [] }) : json(member()),
    );
    expect(await service.getPerson("x")).toMatchObject({
      nr: "M-1001",
      geburtsdatum: "1985-03-14",
      eintritt: "2019-01-01",
      kanal: "Post",
      gruppeSeit: "2019-02-01T08:00:00.000Z",
    });
  });

  it("sendet Geburtsdatum und Eintritt beim Speichern; null löscht", async () => {
    const { service, calls } = setup((url) =>
      url.startsWith("/api/gruppen") ? json({ items: [] }) : json(member()),
    );
    const input = {
      typ: "einzel" as const,
      vorname: "Anna",
      nachname: "Beispiel",
      geburtsdatum: "1985-03-14",
      eintritt: "2019-01-01",
    };
    await service.savePerson(null, input);
    await service.savePerson("11111111-1111-4111-8111-111111111111", {
      ...input,
      geburtsdatum: undefined,
    });
    const bodies = calls
      .filter((c) => c.init.method === "POST" || c.init.method === "PATCH")
      .map((c) => JSON.parse(String(c.init.body)));
    expect(bodies[0]).toMatchObject({ geburtsdatum: "1985-03-14", eintritt: "2019-01-01" });
    expect(bodies[1]).toMatchObject({ geburtsdatum: null, eintritt: "2019-01-01" });
  });

  it("«Alle» meldet die Summe der Gesamtzahlen von aktiv und archiviert", async () => {
    const { service } = setup((url) => {
      if (url.startsWith("/api/gruppen")) return json({ items: [] });
      return json({
        items: [member()],
        nextCursor: null,
        total: url.includes("status=aktiv") ? 5 : 2,
      });
    });
    expect((await service.listPersonen({})).total).toBe(7);
  });

  it("zählt Personen ohne Gruppe über die Gesamtzahl der API", async () => {
    const { service, calls } = setup(() => json({ items: [], nextCursor: null, total: 12 }));
    expect(await service.countOhneGruppe()).toBe(12);
    expect(calls[0]?.url).toContain("ohneGruppe=true");
  });

  it("liest Gruppendetails und Firmenzusätze aus der API", async () => {
    const { service } = setup((url) =>
      url.startsWith("/api/gruppen")
        ? json({
            items: [
              {
                id: "g",
                name: "Vorstand",
                mitglieder: 3,
                beschreibung: "Leitung",
                erstelltAm: "2020-01-01T00:00:00.000Z",
                geaendertAm: "2021-02-03T00:00:00.000Z",
                adresslisten: ["Sommerfest"],
              },
            ],
          })
        : json({
            id: "f",
            name: "Huber AG",
            uid: null,
            mwstNr: null,
            adresse: { strasse: "Weg", plz: "8000", ort: "Zürich", land: "CH" },
            email: null,
            telefon: null,
            status: "freigegeben",
            zusammengefuehrtMit: null,
            erstelltAm: "2026-01-01T00:00:00.000Z",
            kontaktperson: "Beat Muster",
            rechnungsEmail: "buch@huber.example",
            notiz: "Post",
            quelle: "selbst",
            mitglieder: 2,
          }),
    );
    expect((await service.listGruppen())[0]).toMatchObject({
      beschreibung: "Leitung",
      angelegt: "2020-01-01T00:00:00.000Z",
      geaendert: "2021-02-03T00:00:00.000Z",
      adresslisten: ["Sommerfest"],
    });
    expect(await service.getFirma("f")).toMatchObject({
      kontaktperson: "Beat Muster",
      rechnungsEmail: "buch@huber.example",
      notiz: "Post",
      quelle: "selbst",
      mitglieder: 2,
      erfasstVon: null,
    });
  });

  it("Duplikate: Liste und Zusammenführen übersetzen gewählte Werte in «behalten» und «entfernen»", async () => {
    const dup = {
      id: "a_b",
      art: "firma",
      a: {
        id: "a",
        name: "Huber AG",
        mitglieder: 1,
        felder: { name: "Huber AG", telefon: "+41441" },
      },
      b: {
        id: "b",
        name: "Huber GmbH",
        mitglieder: 2,
        felder: { name: "Huber GmbH", uid: "CHE-1" },
      },
      trefferBei: ["name"],
      aehnlichkeit: 95,
      status: "offen",
    };
    const { service, calls } = setup((url, init) =>
      init.method === "POST"
        ? json(null, 204)
        : url === "/api/duplikate"
          ? json({ items: [dup] })
          : json(dup),
    );
    const list = await service.listDuplikate();
    expect(list[0]).toMatchObject({
      id: "a_b",
      aehnlichkeit: 95,
      a: { nr: null, rechnungen: null, mitglieder: 1 },
    });
    await service.setKeinDuplikat("a_b");
    await service.merge("a_b", {
      behaltenId: "a",
      entfernenId: "b",
      werte: { name: "Huber GmbH", telefon: "+41441", uid: "CHE-1", email: "frei@erfunden" },
    });
    const post = calls.filter((c) => c.init.method === "POST");
    expect(post[0]?.url).toBe("/api/duplikate/a_b/kein-duplikat");
    expect(post[1]?.url).toBe("/api/duplikate/a_b/zusammenfuehren");
    // Unbekannte Werte werden nicht geraten: «email» fehlt in beiden Einträgen.
    expect(JSON.parse(String(post[1]?.init.body))).toEqual({
      behaltenId: "a",
      werte: { name: "entfernen", telefon: "behalten", uid: "entfernen" },
    });
  });

  it("«Alle» verkettet aktive und archivierte Mitglieder über den Cursor", async () => {
    const { service, calls } = setup((url) => {
      if (url.startsWith("/api/gruppen")) return json({ items: [] });
      return url.includes("status=aktiv")
        ? json({ items: [member()], nextCursor: null })
        : json({
            items: [member({ id: "33333333-3333-4333-8333-333333333333", status: "archiviert" })],
            nextCursor: null,
          });
    });
    const first = await service.listPersonen({});
    expect(first.next).toBe("1:");
    const second = await service.listPersonen({ cursor: first.next ?? undefined });
    expect(second.items[0]?.status).toBe("ausgetreten");
    expect(second.next).toBeNull();
    // Zwei Seiten (aktiv, archiviert); die Zählabfragen mit limit=1 sind separat.
    expect(
      calls.filter((c) => c.url.includes("/api/mitglieder") && c.url.includes("limit=50")),
    ).toHaveLength(2);
  });

  it("Sammelaktion «Gruppe zuweisen» ersetzt die bisherige Gruppe und sendet das CSRF-Token", async () => {
    const { service, calls } = setup(() => json({ ok: 2, fehler: [] }));
    const r = await service.sammelaktion(["a", "b"], "gruppe_zuweisen", "g");
    expect(r).toEqual({ ok: 2, fehler: 0 });
    const posts = calls.filter((c) => c.init.method === "POST");
    expect(posts.map((c) => JSON.parse(String(c.init.body)).aktion)).toEqual([
      "gruppe_entfernen",
      "gruppe_zuweisen",
    ]);
    expect((posts[0]?.init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok");
  });

  it("legt eine Person an und weist die Gruppe zu", async () => {
    const { service, calls } = setup((url, init) => {
      if (url.startsWith("/api/gruppen")) return json({ items: [] });
      if (init.method === "PUT") return json(null, 204);
      return json(member());
    });
    await service.savePerson(null, {
      typ: "einzel",
      vorname: "Anna",
      nachname: "Beispiel",
      email: "anna@example.ch",
      strasse: "Beispielstrasse 12",
      plz: "8000",
      ort: "Musterhausen",
      gruppeId: "22222222-2222-4222-8222-222222222222",
    });
    const create = calls.find((c) => c.init.method === "POST");
    expect(JSON.parse(String(create?.init.body))).toMatchObject({
      typ: "einzel",
      adresse: { strasse: "Beispielstrasse 12", plz: "8000", ort: "Musterhausen", land: "CH" },
    });
    expect(calls.some((c) => c.init.method === "PUT" && c.url.endsWith("/gruppe"))).toBe(true);
  });

  it("meldet 401 und wirft einen Fehler nur mit Status", async () => {
    const { service, onUnauthorized } = setup(() => json({ error: { message: "geheim" } }, 401));
    await expect(service.listGruppen()).rejects.toMatchObject({ status: 401 });
    await expect(service.listGruppen()).rejects.toBeInstanceOf(ApiError);
    await expect(service.listGruppen()).rejects.not.toHaveProperty(
      "message",
      expect.stringContaining("geheim"),
    );
    expect(onUnauthorized).toHaveBeenCalled();
  });

  it("Import baut aus der Zuordnung eine CSV-Datei der API und meldet Fehler ohne Werte", async () => {
    const { service, calls } = setup(() =>
      json({
        zeilen: 2,
        importiert: 0,
        aktualisiert: 0,
        uebersprungen: 0,
        fehler: [{ zeile: 3, grund: "UNGUELTIG", felder: ["nachname"] }],
      }),
    );
    const r = await service.importPruefen({
      datei: {
        name: "x.csv",
        spalten: ["V", "N", "O"],
        zeilen: [
          ["Anna", "Beispiel", "8000 Musterhausen"],
          ["Beat", "", ""],
        ],
      },
      zuordnung: ["vorname", "nachname", "plzOrt"],
      optionen: {
        ersteZeileNamen: true,
        duplikatePruefen: true,
        aktualisieren: false,
        gruppeFuerAlle: null,
      },
    });
    expect(r).toEqual({
      zeilen: 2,
      neu: 1,
      duplikate: 0,
      fehlerhaft: 1,
      fehler: [{ zeile: 3, felder: ["nachname"] }],
    });
    expect(calls[0]?.url).toBe("/api/mitglieder/import?dryRun=true&duplikate=ueberspringen");
    expect(String(calls[0]?.init.body)).toContain(
      '"Anna";"Beispiel";"";"8000";"Musterhausen";"";""',
    );
  });

  it("Importoptionen: aktualisieren, Zielgruppe, Gruppenspalte; Duplikate zählen getrennt", async () => {
    const { service, calls } = setup(() =>
      json({
        zeilen: 4,
        importiert: 0,
        aktualisiert: 1,
        uebersprungen: 1,
        fehler: [{ zeile: 5, grund: "UNGUELTIG", felder: ["nachname"] }],
      }),
    );
    const r = await service.importPruefen({
      datei: {
        name: "x.csv",
        spalten: ["V", "N", "G"],
        zeilen: [["Anna", "Beispiel", "Vorstand"]],
      },
      zuordnung: ["vorname", "nachname", "gruppe"],
      optionen: {
        ersteZeileNamen: true,
        duplikatePruefen: true,
        aktualisieren: true,
        gruppeFuerAlle: "22222222-2222-4222-8222-222222222222",
      },
    });
    expect(calls[0]?.url).toBe(
      "/api/mitglieder/import?dryRun=true&aktualisieren=true&duplikate=ueberspringen&gruppeId=22222222-2222-4222-8222-222222222222",
    );
    expect(String(calls[0]?.init.body)).toContain('"Anna";"Beispiel";"";"";"";"";"Vorstand"');
    expect(r).toEqual({
      zeilen: 4,
      neu: 1,
      duplikate: 2,
      fehlerhaft: 1,
      fehler: [{ zeile: 5, felder: ["nachname"] }],
    });
  });

  it("ohne Duplikatprüfung ist eine bekannte E-Mail-Adresse ein Fehler", async () => {
    const { service, calls } = setup(() =>
      json({
        zeilen: 1,
        importiert: 0,
        aktualisiert: 0,
        uebersprungen: 0,
        fehler: [{ zeile: 2, grund: "E_MAIL_DOPPELT", felder: ["email"] }],
      }),
    );
    const r = await service.importPruefen({
      datei: { name: "x.csv", spalten: ["V", "N"], zeilen: [["A", "B"]] },
      zuordnung: ["vorname", "nachname"],
      optionen: {
        ersteZeileNamen: true,
        duplikatePruefen: false,
        aktualisieren: false,
        gruppeFuerAlle: null,
      },
    });
    expect(calls[0]?.url).toBe("/api/mitglieder/import?dryRun=true");
    expect(r).toMatchObject({ duplikate: 0, fehlerhaft: 1, neu: 0 });
  });

  it("Firmenregister zeigt standardmässig nur freigegebene Firmen", async () => {
    const { service, calls } = setup(() => json({ items: [], nextCursor: null }));
    await service.listFirmen({});
    await service.listFirmen({ status: "alle" });
    expect(calls[0]?.url).toContain("status=freigegeben");
    expect(calls[1]?.url).not.toContain("status=");
  });
});
