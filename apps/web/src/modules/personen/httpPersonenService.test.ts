import { describe, expect, it, vi } from "vitest";
import { createHttpPersonenService } from "./httpPersonenService";
import { ApiError } from "./model";

const member = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
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
        : json({ items: [member()], nextCursor: null }),
    );
    const page = await service.listPersonen({ status: "aktiv" });
    expect(page.items[0]).toMatchObject({
      name: "Anna Beispiel",
      nr: null,
      gruppeName: "Jugend",
      status: "aktiv",
      ort: "Musterhausen",
    });
    expect(service.features.finanzen).toBe(false);
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
    expect(calls.filter((c) => c.url.includes("/api/mitglieder"))).toHaveLength(2);
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
    expect(calls[0]?.url).toBe("/api/mitglieder/import?dryRun=true");
    expect(String(calls[0]?.init.body)).toContain('"Anna";"Beispiel";"";"8000";"Musterhausen";""');
  });

  it("Firmenregister zeigt standardmässig nur freigegebene Firmen", async () => {
    const { service, calls } = setup(() => json({ items: [], nextCursor: null }));
    await service.listFirmen({});
    await service.listFirmen({ status: "alle" });
    expect(calls[0]?.url).toContain("status=freigegeben");
    expect(calls[1]?.url).not.toContain("status=");
  });
});
