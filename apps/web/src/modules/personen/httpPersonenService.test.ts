import { describe, expect, it, vi } from "vitest";
import { createHttpPersonenService } from "./httpPersonenService";
import { ApiError, FieldErrors } from "./model";

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
  quelle: "manuell",
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
      sortName: "Beispiel Anna",
      nr: "M-1001",
      gruppeName: "Jugend",
      status: "aktiv",
      ort: "Musterhausen",
    });
    // Finanzen gibt es nur für Personen (Rechnungen tragen die Mitglied-ID), nicht für Firmen.
    expect(service.features.finanzen).toBe(true);
    expect(service.features.firmaFinanzen).toBe(false);
    expect(service.features.statusAusstehend).toBe(true);
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
      kanal: "post",
      gruppeSeit: "2019-02-01T08:00:00.000Z",
    });
  });

  it("sendet den Kanal beim Speichern; leer löscht ihn", async () => {
    const { service, calls } = setup((url) =>
      url.startsWith("/api/gruppen") ? json({ items: [] }) : json(member()),
    );
    const input = { typ: "einzel" as const, vorname: "Anna", nachname: "Beispiel" };
    await service.savePerson(null, { ...input, kanal: "email" });
    await service.savePerson("11111111-1111-4111-8111-111111111111", input);
    const bodies = calls
      .filter((c) => c.init.method === "POST" || c.init.method === "PATCH")
      .map((c) => JSON.parse(String(c.init.body)));
    expect(bodies[0]).toMatchObject({ kanal: "email" });
    expect(bodies[1]).toMatchObject({ kanal: null });
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

  it("«Alle» fragt den Status «alle» ab, «ausgetreten» heisst archiviert", async () => {
    const { service, calls } = setup((url) =>
      url.startsWith("/api/gruppen")
        ? json({ items: [] })
        : json({ items: [member({ status: "ausstehend" })], nextCursor: "c", total: 7 }),
    );
    const all = await service.listPersonen({});
    expect(all).toMatchObject({ total: 7, next: "c" });
    expect(all.items[0]?.status).toBe("ausstehend");
    await service.listPersonen({ status: "ausgetreten" });
    await service.listPersonen({ status: "ausstehend" });
    const urls = calls.map((c) => c.url).filter((u) => u.startsWith("/api/mitglieder"));
    expect(urls[0]).toContain("status=alle");
    expect(urls[1]).toContain("status=archiviert");
    expect(urls[2]).toContain("status=ausstehend");
  });

  it("zählt Personen ohne Gruppe über die Gesamtzahl der API", async () => {
    const { service, calls } = setup(() => json({ items: [], nextCursor: null, total: 12 }));
    expect(await service.countOhneGruppe()).toBe(12);
    expect(calls[0]?.url).toContain("ohneGruppe=true");
  });

  it("teilt gleichzeitige GET-Anfragen, nicht aber nach einer Änderung", async () => {
    const { service, calls } = setup((url) =>
      url.startsWith("/api/gruppen") ? json({ items: [] }) : json({ items: [], total: 0 }),
    );
    const gruppen = () => calls.filter((c) => c.url === "/api/gruppen").length;
    // Liste, Filter und Detail fragen beim Laden dieselben Gruppen ab.
    await Promise.all([
      service.listGruppen(),
      service.listPersonen({ status: "aktiv" }),
      service.listPersonen({ status: "ausstehend" }),
    ]);
    expect(gruppen()).toBe(1);
    // Nach der Antwort gilt nichts Altes weiter.
    await service.listGruppen();
    expect(gruppen()).toBe(2);
    // Eine Änderung beendet das Teilen: wer danach liest, bekommt eine frische Antwort.
    const laufend = service.listGruppen();
    await service.renameGruppe("g1", "Neu");
    await Promise.all([laufend, service.listGruppen()]);
    expect(gruppen()).toBe(4);
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
            erfasstVon: "Berta Beispiel",
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
      erfasstVon: "Berta Beispiel",
    });
  });

  it("Duplikate: Liste und Zusammenführen übersetzen gewählte Werte in «behalten» und «entfernen»", async () => {
    const dup = {
      id: "a_b",
      art: "firma",
      a: {
        id: "a",
        name: "Huber AG",
        nr: null,
        mitglieder: 1,
        rechnungen: null,
        felder: { name: "Huber AG", telefon: "+41441" },
      },
      b: {
        id: "b",
        name: "Huber GmbH",
        nr: null,
        mitglieder: 2,
        rechnungen: null,
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

  it("Duplikate von Personen: Nummer, Rechnungszahl und Treffer kommen aus der API", async () => {
    const eintrag = (id: string, nr: string, rechnungen: number) => ({
      id,
      name: "Anna Meier",
      nr,
      mitglieder: 0,
      rechnungen,
      felder: { vorname: "Anna", nachname: "Meier", geburtsdatum: "1980-05-01" },
    });
    const dup = {
      id: "a_b",
      art: "person",
      a: eintrag("a", "M-1001", 2),
      b: eintrag("b", "M-1002", 0),
      trefferBei: ["name", "geburtsdatum"],
      aehnlichkeit: 90,
      status: "offen",
    };
    const { service, calls } = setup((url, init) =>
      init.method === "POST"
        ? json(null, 200)
        : url === "/api/duplikate"
          ? json({ items: [dup] })
          : json(dup),
    );
    const [d] = await service.listDuplikate();
    expect(d).toMatchObject({
      art: "person",
      trefferBei: ["name", "geburtsdatum"],
      a: { nr: "M-1001", rechnungen: 2 },
      b: { nr: "M-1002", rechnungen: 0 },
    });
    await service.merge("a_b", {
      behaltenId: "a",
      entfernenId: "b",
      werte: { vorname: "Anna", geburtsdatum: "1980-05-01" },
    });
    const post = calls.find((c) => c.init.method === "POST");
    expect(JSON.parse(String(post?.init.body))).toEqual({
      behaltenId: "a",
      werte: { vorname: "behalten", geburtsdatum: "behalten" },
    });
  });

  it("Finanzen: Rechnungen, Konto und Verlauf der Person aus der API, Texte aus den Übersetzungen", async () => {
    const { service, calls } = setup(() =>
      json({
        rechnungen: [
          {
            id: "r1",
            nr: "R-2026-0001",
            datum: "2026-10-01",
            betrag: 12000,
            offen: 12000,
            status: "offen",
          },
        ],
        konto: { offen: 12000, bezahltJahr: 5000, mahnstufe: 2, letzteZahlung: "2026-03-15" },
        mails: 3,
        verlauf: [
          {
            datum: "2026-10-01T08:00:00.000Z",
            art: "rechnung_versendet",
            detail: "R-2026-0001",
            betrag: 12000,
          },
          {
            datum: "2026-09-01T08:00:00.000Z",
            art: "gruppe_zugewiesen",
            detail: "Aktive",
            betrag: null,
          },
        ],
      }),
    );
    const f = await service.getFinanzen("p1");
    expect(calls[0]?.url).toBe("/api/mitglieder/p1/finanzen");
    expect(f.rechnungen).toEqual([
      { nr: "R-2026-0001", datum: "2026-10-01", betrag: 12000, status: "offen" },
    ]);
    expect(f.konto).toEqual({
      offen: 12000,
      bezahltJahr: 5000,
      mahnstufe: "Stufe 2",
      letzteZahlung: "2026-03-15",
    });
    expect(f.mails).toBe(3);
    expect(f.verlauf.map((v) => v.text)).toEqual([
      "Rechnung R-2026-0001 versendet (CHF 120.00)",
      "Gruppe «Aktive» zugewiesen",
    ]);
  });

  it("Freigabe: ausstehende und selbst registrierte Personen laden, freigeben und ablehnen", async () => {
    const { service, calls } = setup((url, init) => {
      if (init.method === "POST") return json(member({ status: "aktiv" }));
      if (url.startsWith("/api/gruppen")) return json({ items: [] });
      return url.includes("status=ausstehend")
        ? json({
            items: [member({ id: "p-w", status: "ausstehend", quelle: "selbst" })],
            nextCursor: null,
            total: 1,
          })
        : json({
            items: [
              member({ id: "p-w", status: "ausstehend", quelle: "selbst" }),
              member({ id: "p-f", status: "aktiv", quelle: "selbst" }),
            ],
            nextCursor: null,
            total: 2,
          });
    });
    const list = await service.listPersonenFreigaben();
    expect(list.map((p) => [p.id, p.status, p.quelle])).toEqual([
      ["p-w", "ausstehend", "selbst"],
      ["p-f", "aktiv", "selbst"],
    ]);
    await service.setPersonFreigabe("p-w", true);
    await service.setPersonFreigabe("p-w", false);
    const post = calls.filter((c) => c.init.method === "POST").map((c) => c.url);
    expect(post).toEqual(["/api/mitglieder/p-w/freigeben", "/api/mitglieder/p-w/ablehnen"]);
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

  it("bildet 400 mit Feldpfaden auf Formularfelder ab, ohne Werte aus der Antwort", async () => {
    const { service } = setup((url, init) =>
      init.method === "POST" && url === "/api/mitglieder"
        ? json(
            {
              error: {
                code: "VALIDATION",
                message: "Ungültige Anfrage.",
                fields: { telefon: "custom", "adresse.plz": "custom", website: "custom" },
              },
            },
            400,
          )
        : json({ items: [] }),
    );
    const error = await service
      .savePerson(null, {
        typ: "einzel",
        vorname: "A",
        nachname: "B",
        telefon: "123",
        strasse: "S 1",
        plz: "8000",
        ort: "Z",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FieldErrors);
    expect((error as FieldErrors).fields).toEqual({
      telefon: "Geben Sie eine gültige Telefonnummer ein, zum Beispiel +41 79 123 45 67.",
      plz: "Geben Sie eine vierstellige Postleitzahl ein, zum Beispiel 8000.",
      website: "Geben Sie hier einen gültigen Wert ein.",
    });
  });

  it("400 ohne Feldpfade bleibt ein allgemeiner Fehler", async () => {
    const { service } = setup(() =>
      json({ error: { code: "VALIDATION", message: "Ungültige Anfrage." } }, 400),
    );
    await expect(service.createGruppe("X")).rejects.toBeInstanceOf(ApiError);
  });
});
