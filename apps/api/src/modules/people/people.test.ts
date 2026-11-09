import { createHash } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import type { RouteOptions } from "fastify";
import { afterAll, describe, expect, inject, it } from "vitest";
import { errorHandler, notFoundHandler } from "../../lib/errors.js";
import { KUNDE_A, KUNDE_B, openTestDatabase } from "../../testing/postgres.js";
import { CSV_MAX_BYTES, neutralizeCell, parseCsv, toCsv } from "./csv.js";
import type { FinanceData, PersonFinance } from "./finance.js";
import { createMemoryStore } from "./memory.js";
import { similarity, normalizeCompanyName } from "./normalize.js";
import { RegistrationService, referenceOf } from "./registration.js";
import { createPeopleModule } from "./routes.js";
import { PeopleService } from "./service.js";

const SLUGS: Record<string, string> = { "verein-a": KUNDE_A, "verein-b": KUNDE_B };
const UID_1 = "CHE-123.456.788";
const adresse = { strasse: "Bahnhofstrasse", hausnr: "1", plz: "8001", ort: "Zürich" };

interface Mail {
  kundeId: string;
  kunde: string;
  an: string;
  vorlage: string;
  art: string;
  referenz: string;
  token?: string;
  gueltigBis?: Date;
}

const REFERENZ = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

// Dieselbe Suite läuft in zwei Vitest-Projekten: gegen den Speicher und gegen PostgreSQL.
const usePostgres = inject("store") === "postgres";
let pgTest: ReturnType<typeof openTestDatabase> | undefined;
afterAll(async () => (await pgTest)?.close());

/** Benutzer des Mandanten A, der in den Tests anlegt («erfasst von»). */
const BENUTZER_A = "a0000000-0000-4000-8000-00000000000a";
const BENUTZER_B = "b0000000-0000-4000-8000-00000000000b";
const BENUTZER_NAME = "Berta Beispiel";

async function setup() {
  let store = createMemoryStore(
    new Map([
      [BENUTZER_A, { kundeId: KUNDE_A, name: BENUTZER_NAME }],
      [BENUTZER_B, { kundeId: KUNDE_B, name: "Bruno B" }],
    ]),
  );
  let resolveTenant = async (slug: string): Promise<string | undefined> => SLUGS[slug];
  if (usePostgres) {
    pgTest ??= openTestDatabase();
    const pg = await pgTest;
    await pg.reset();
    ({ store, resolveTenant } = pg);
    await pg.owner.query(
      `INSERT INTO benutzer (id, kunde_id, email, name, passwort_hash)
       VALUES ($1, $2, 'berta@example.test', $3, 'x'), ($4, $5, 'bruno@example.test', 'Bruno B', 'x')
       ON CONFLICT (id) DO NOTHING`,
      [BENUTZER_A, KUNDE_A, BENUTZER_NAME, BENUTZER_B, KUNDE_B],
    );
  }
  // Rechnungsmodul als Attrappe: `rows` je Mandant und Schlüssel, `data` für die Finanzen.
  const rechnungen = {
    rows: new Map<string, { gesamt: number; offen: number }>(),
    data: { rechnungen: [], zahlungen: [], mahnungen: [], mails: 0 } as FinanceData,
  };
  const finance: PersonFinance = {
    async forPerson() {
      return rechnungen.data;
    },
    async counts(kundeId, keys) {
      return new Map(
        keys.map((k) => [k, rechnungen.rows.get(`${kundeId}:${k}`) ?? { gesamt: 0, offen: 0 }]),
      );
    },
  };
  const mails: Mail[] = [];
  const routes: RouteOptions[] = [];
  const clock = { now: new Date("2026-11-04T10:00:00Z") };
  const mod = createPeopleModule({
    store,
    // Nur im Test: der Mandant kommt aus einem Header. Echt liefert ihn die Session (SR-13).
    resolveContext: async (req) => {
      const k = req.headers["x-kunde"];
      return typeof k === "string"
        ? { kundeId: k, benutzerId: k === KUNDE_A ? BENUTZER_A : BENUTZER_B }
        : undefined;
    },
    resolveTenant,
    mailer: { send: async (m) => void mails.push(m) },
    formSecret: Buffer.alloc(32, 7),
    now: () => clock.now,
    finance,
  });
  const app = Fastify();
  app.addHook("onRoute", (r) => void routes.push(r));
  await app.register(rateLimit, { max: 1000, timeWindow: "1 minute" });
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  await app.register(async (scope) => mod.register(scope));
  await app.ready();

  const call = async (
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    opts: { k?: string; body?: unknown; csv?: string } = {},
  ) => {
    const res = await app.inject({
      method,
      url,
      headers: {
        ...(opts.k ? { "x-kunde": opts.k } : {}),
        ...(opts.csv !== undefined ? { "content-type": "text/csv" } : {}),
      },
      ...(opts.csv !== undefined ? { payload: opts.csv } : opts.body ? { payload: opts.body } : {}),
    });
    return { status: res.statusCode, body: res.body, json: () => res.json(), headers: res.headers };
  };
  const A = (method: Parameters<typeof call>[0], url: string, body?: unknown) =>
    call(method, url, { k: KUNDE_A, body });
  const B = (method: Parameters<typeof call>[0], url: string, body?: unknown) =>
    call(method, url, { k: KUNDE_B, body });
  return { app, store, mails, routes, clock, call, A, B, rechnungen };
}
type Env = Awaited<ReturnType<typeof setup>>;

const einzel = (n: string, extra: object = {}) => ({
  typ: "einzel",
  vorname: "Anna",
  nachname: n,
  ...extra,
});

async function mitglied(env: Env, n: string, extra: object = {}, who: "A" | "B" = "A") {
  const res = await env[who]("POST", "/api/mitglieder", einzel(n, extra));
  expect(res.status).toBe(201);
  return res.json().id as string;
}
async function gruppe(env: Env, name: string, who: "A" | "B" = "A") {
  const res = await env[who]("POST", "/api/gruppen", { name });
  expect(res.status).toBe(201);
  return res.json().id as string;
}
async function firma(env: Env, name: string, extra: object = {}, who: "A" | "B" = "A") {
  const res = await env[who]("POST", "/api/firmen", { name, adresse, ...extra });
  expect(res.status).toBe(201);
  return res.json().id as string;
}

describe("Zugriffsschutz (SR-10, SR-12)", () => {
  it("verweigert jede geschützte Route ohne Anmeldung, nie 'fail open'", async () => {
    const env = await setup();
    const geschuetzt = env.routes.filter((r) => String(r.url).startsWith("/api/"));
    expect(geschuetzt.length).toBeGreaterThan(20);
    for (const r of geschuetzt) {
      const methods = [r.method].flat();
      for (const method of methods) {
        if (method === "HEAD" || method === "OPTIONS") continue;
        const url = String(r.url).replace(":id", "11111111-1111-4111-8111-111111111111");
        const res = await env.app.inject({ method, url });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
      }
    }
  });
});

describe("Mitglieder CRUD", () => {
  it("legt an, liest, ändert und gibt nur DTO-Felder zurück (SR-72, SR-74)", async () => {
    const env = await setup();
    const res = await env.A("POST", "/api/mitglieder", {
      ...einzel("Muster", { telefon: "079 123 45 67", adresse }),
      kundeId: KUNDE_B,
      id: "11111111-1111-4111-8111-111111111111",
      status: "archiviert",
    });
    expect(res.status).toBe(201);
    const m = res.json();
    expect(m).not.toHaveProperty("kundeId");
    expect(m.status).toBe("aktiv");
    expect(m.id).not.toBe("11111111-1111-4111-8111-111111111111");
    expect(m.telefon).toBe("+41791234567");

    const patch = await env.A("PATCH", `/api/mitglieder/${m.id}`, {
      nachname: "Beispiel",
      telefon: null,
      kundeId: KUNDE_B,
    });
    expect(patch.json()).toMatchObject({ nachname: "Beispiel", telefon: null });
    expect((await env.A("GET", `/api/mitglieder/${m.id}`)).json().nachname).toBe("Beispiel");
    // Mitglied bleibt im Mandanten A, auch wenn der Body kundeId B behauptet.
    expect((await env.B("GET", `/api/mitglieder/${m.id}`)).status).toBe(404);
  });

  it("lehnt ungültige Schweizer Daten ab und verrät keine Schema-Details", async () => {
    const env = await setup();
    const res = await env.A(
      "POST",
      "/api/mitglieder",
      einzel("X", { adresse: { ...adresse, plz: "0001" } }),
    );
    expect(res.status).toBe(400);
    expect(res.json()).toEqual({ error: { code: "VALIDATION", message: "Ungültige Anfrage." } });
  });

  it("verhindert doppelte E-Mail im Mandanten, erlaubt sie in einem anderen", async () => {
    const env = await setup();
    await mitglied(env, "Eins", { email: "a@example.org" });
    expect(
      (await env.A("POST", "/api/mitglieder", einzel("Zwei", { email: "A@example.org" }))).status,
    ).toBe(409);
    await mitglied(env, "Drei", { email: "a@example.org" }, "B");
  });

  it("Firmenmitglied braucht eine freigegebene Firma", async () => {
    const env = await setup();
    const f = await firma(env, "Muster AG");
    const ok = await env.A("POST", "/api/mitglieder", {
      typ: "firma",
      firmaId: f,
      vorname: "Max",
      nachname: "Chef",
      funktion: "Präsident",
    });
    expect(ok.status).toBe(201);
    expect(ok.json().firmaName).toBe("Muster AG");
    const unbekannt = await env.A("POST", "/api/mitglieder", {
      typ: "firma",
      firmaId: "11111111-1111-4111-8111-111111111111",
      vorname: "Max",
      nachname: "Chef",
    });
    expect(unbekannt.status).toBe(400);
  });

  it("Einzelmitglied kann keine Firma bekommen", async () => {
    const env = await setup();
    const f = await firma(env, "Muster AG");
    const id = await mitglied(env, "Solo");
    expect((await env.A("PATCH", `/api/mitglieder/${id}`, { firmaId: f })).status).toBe(400);
  });
});

describe("Liste: Paginierung, Suche, Filter", () => {
  it("blättert per Cursor ohne Lücken oder Doppelte", async () => {
    const env = await setup();
    for (const n of ["Eins", "Zwei", "Drei", "Vier", "Fünf"]) await mitglied(env, n);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/api/mitglieder?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const page = (await env.A("GET", url)).json();
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((m: { nachname: string }) => m.nachname));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(["Drei", "Eins", "Fünf", "Vier", "Zwei"]);
  });

  it("begrenzt limit und Cursor-Länge (SR-71)", async () => {
    const env = await setup();
    expect((await env.A("GET", "/api/mitglieder?limit=201")).status).toBe(400);
    expect((await env.A("GET", `/api/mitglieder?cursor=${"x".repeat(401)}`)).status).toBe(400);
    // Ein kaputter Cursor ist nie ein Serverfehler: leere Seite (Speicher) oder 400 (PostgreSQL).
    expect([200, 400]).toContain(
      (await env.A("GET", "/api/mitglieder?cursor=%00%00kaputt")).status,
    );
  });

  it("sucht ohne Beachtung von Akzenten und Gross-/Kleinschreibung, auch in der Firma", async () => {
    const env = await setup();
    await mitglied(env, "Müller", { adresse });
    await mitglied(env, "Meier");
    const f = await firma(env, "Bau Kunz AG");
    await env.A("POST", "/api/mitglieder", {
      typ: "firma",
      firmaId: f,
      vorname: "K",
      nachname: "Chef",
    });
    expect((await env.A("GET", "/api/mitglieder?q=MULLER")).json().items).toHaveLength(1);
    expect((await env.A("GET", "/api/mitglieder?q=anna zuerich")).json().items).toHaveLength(0);
    expect((await env.A("GET", "/api/mitglieder?q=zürich")).json().items).toHaveLength(1);
    expect((await env.A("GET", "/api/mitglieder?q=kunz")).json().items).toHaveLength(1);
    expect((await env.A("GET", "/api/mitglieder?typ=firma")).json().items).toHaveLength(1);
  });

  it("filtert nach Gruppe, ohne Gruppe und Status", async () => {
    const env = await setup();
    const g = await gruppe(env, "Vorstand");
    const a = await mitglied(env, "Eins");
    const b = await mitglied(env, "Zwei");
    await env.A("PUT", `/api/mitglieder/${a}/gruppe`, { gruppeId: g });
    expect((await env.A("GET", `/api/mitglieder?gruppeId=${g}`)).json().items).toHaveLength(1);
    expect((await env.A("GET", "/api/mitglieder?ohneGruppe=true")).json().items[0].id).toBe(b);
    await env.A("POST", "/api/mitglieder/sammelaktion", { ids: [b], aktion: "archivieren" });
    expect((await env.A("GET", "/api/mitglieder")).json().items).toHaveLength(1);
    expect((await env.A("GET", "/api/mitglieder?status=archiviert")).json().items).toHaveLength(1);
  });
});

describe("Gruppen: höchstens eine Gruppe pro Person", () => {
  it("lehnt die zweite Gruppe ab, erlaubt Wiederholung und Wechsel nach Entfernen", async () => {
    const env = await setup();
    const g1 = await gruppe(env, "Vorstand");
    const g2 = await gruppe(env, "Revisoren");
    const m = await mitglied(env, "Eins");

    expect((await env.A("PUT", `/api/mitglieder/${m}/gruppe`, { gruppeId: g1 })).status).toBe(204);
    expect((await env.A("PUT", `/api/mitglieder/${m}/gruppe`, { gruppeId: g1 })).status).toBe(204);
    const zweite = await env.A("PUT", `/api/mitglieder/${m}/gruppe`, { gruppeId: g2 });
    expect(zweite.status).toBe(409);
    expect((await env.A("GET", `/api/mitglieder/${m}`)).json().gruppeId).toBe(g1);

    await env.A("DELETE", `/api/mitglieder/${m}/gruppe`);
    expect((await env.A("PUT", `/api/mitglieder/${m}/gruppe`, { gruppeId: g2 })).status).toBe(204);
  });

  it("der Speicher erzwingt die Invariante selbst, auch am Dienst vorbei (Constraint)", async () => {
    const env = await setup();
    const g1 = await gruppe(env, "Vorstand");
    const g2 = await gruppe(env, "Revisoren");
    const m = await mitglied(env, "Eins");
    await env.store.gruppen.assign(KUNDE_A, m, g1);
    await expect(env.store.gruppen.assign(KUNDE_A, m, g2)).rejects.toMatchObject({
      statusCode: 409,
    });
    // Gleichzeitige Zuweisungen: genau eine gewinnt.
    const n = await mitglied(env, "Zwei");
    const results = await Promise.allSettled([
      env.A("PUT", `/api/mitglieder/${n}/gruppe`, { gruppeId: g1 }),
      env.A("PUT", `/api/mitglieder/${n}/gruppe`, { gruppeId: g2 }),
    ]);
    const stati = results.map((r) => (r.status === "fulfilled" ? r.value.status : 0)).sort();
    expect(stati).toEqual([204, 409]);
  });

  it("Sammelaktion meldet Konflikte je Eintrag und ändert die anderen", async () => {
    const env = await setup();
    const g1 = await gruppe(env, "Vorstand");
    const g2 = await gruppe(env, "Revisoren");
    const a = await mitglied(env, "Eins");
    const b = await mitglied(env, "Zwei");
    await env.A("PUT", `/api/mitglieder/${a}/gruppe`, { gruppeId: g1 });
    const res = await env.A("POST", "/api/mitglieder/sammelaktion", {
      ids: [a, b, "11111111-1111-4111-8111-111111111111"],
      aktion: "gruppe_zuweisen",
      gruppeId: g2,
    });
    expect(res.json()).toEqual({
      ok: 1,
      fehler: [
        { id: a, grund: "KONFLIKT" },
        { id: "11111111-1111-4111-8111-111111111111", grund: "NICHT_GEFUNDEN" },
      ],
    });
    expect((await env.A("GET", `/api/mitglieder/${b}`)).json().gruppeId).toBe(g2);
  });

  it("Sammelaktion verlangt gruppeId und begrenzt die Anzahl", async () => {
    const env = await setup();
    const id = await mitglied(env, "Eins");
    expect(
      (
        await env.A("POST", "/api/mitglieder/sammelaktion", {
          ids: [id],
          aktion: "gruppe_zuweisen",
        })
      ).status,
    ).toBe(400);
    const viele = Array.from({ length: 501 }, () => id);
    expect(
      (await env.A("POST", "/api/mitglieder/sammelaktion", { ids: viele, aktion: "archivieren" }))
        .status,
    ).toBe(400);
  });

  it("benennt um, verbietet doppelte Namen und löst auf (Mitglieder bleiben, ohne Gruppe)", async () => {
    const env = await setup();
    const g1 = await gruppe(env, "Vorstand");
    const g2 = await gruppe(env, "Revisoren");
    const m = await mitglied(env, "Eins");
    await env.A("PUT", `/api/mitglieder/${m}/gruppe`, { gruppeId: g1 });

    expect((await env.A("PATCH", `/api/gruppen/${g2}`, { name: "vorstand" })).status).toBe(409);
    expect((await env.A("POST", "/api/gruppen", { name: "VORSTAND" })).status).toBe(409);
    expect((await env.A("PATCH", `/api/gruppen/${g1}`, { name: "Leitung" })).status).toBe(204);
    expect((await env.A("GET", "/api/gruppen")).json().items).toContainEqual(
      expect.objectContaining({ id: g1, name: "Leitung", mitglieder: 1 }),
    );

    expect((await env.A("DELETE", `/api/gruppen/${g1}`)).status).toBe(204);
    expect((await env.A("GET", `/api/mitglieder/${m}`)).json().gruppeId).toBeNull();
    expect((await env.A("PUT", `/api/mitglieder/${m}/gruppe`, { gruppeId: g2 })).status).toBe(204);
    expect((await env.A("DELETE", `/api/gruppen/${g1}`)).status).toBe(404);
  });
});

describe("Mandantentrennung", () => {
  it("Mandant B sieht und ändert nichts von Mandant A", async () => {
    const env = await setup();
    const m = await mitglied(env, "Geheim", { email: "g@example.org" });
    const g = await gruppe(env, "Intern");
    const f = await firma(env, "Intern AG", { uid: UID_1 });

    expect((await env.B("GET", "/api/mitglieder")).json().items).toEqual([]);
    expect((await env.B("GET", "/api/mitglieder?q=geheim")).json().items).toEqual([]);
    expect((await env.B("GET", "/api/gruppen")).json().items).toEqual([]);
    expect((await env.B("GET", "/api/firmen")).json().items).toEqual([]);
    expect((await env.B("GET", `/api/mitglieder/${m}`)).status).toBe(404);
    expect((await env.B("PATCH", `/api/mitglieder/${m}`, { nachname: "Hack" })).status).toBe(404);
    expect((await env.B("PATCH", `/api/gruppen/${g}`, { name: "Hack" })).status).toBe(404);
    expect((await env.B("DELETE", `/api/gruppen/${g}`)).status).toBe(404);
    expect((await env.B("GET", `/api/firmen/${f}`)).status).toBe(404);
    expect((await env.B("POST", `/api/firmen/${f}/freigeben`)).status).toBe(404);
    expect((await env.B("GET", `/api/firmen/${f}/duplikate`)).status).toBe(404);
    const bulk = await env.B("POST", "/api/mitglieder/sammelaktion", {
      ids: [m],
      aktion: "archivieren",
    });
    expect(bulk.json()).toEqual({ ok: 0, fehler: [{ id: m, grund: "NICHT_GEFUNDEN" }] });
    expect((await env.A("GET", `/api/mitglieder/${m}`)).json().status).toBe("aktiv");
  });

  it("verknüpft nie über Mandantengrenzen (Gruppe, Firma, Zusammenführen)", async () => {
    const env = await setup();
    const mA = await mitglied(env, "Eins");
    const gB = await gruppe(env, "Fremd", "B");
    const mB = await mitglied(env, "Zwei", {}, "B");
    const gA = await gruppe(env, "Eigen");
    const fA = await firma(env, "A AG");
    const fB = await firma(env, "B AG", {}, "B");

    expect((await env.A("PUT", `/api/mitglieder/${mA}/gruppe`, { gruppeId: gB })).status).toBe(404);
    expect((await env.A("PUT", `/api/mitglieder/${mB}/gruppe`, { gruppeId: gA })).status).toBe(404);
    await expect(env.store.gruppen.assign(KUNDE_A, mB, gA)).rejects.toMatchObject({
      statusCode: 404,
    });
    const fremdeFirma = await env.B("POST", "/api/mitglieder", {
      typ: "firma",
      firmaId: fA,
      vorname: "X",
      nachname: "Y",
    });
    expect(fremdeFirma.status).toBe(400);
    expect(
      (await env.A("POST", `/api/firmen/${fA}/zusammenfuehren`, { quelleId: fB })).status,
    ).toBe(404);
  });

  it("Export, Duplikate, Import und öffentliche Suche bleiben im Mandanten", async () => {
    const env = await setup();
    await mitglied(env, "NurA");
    await mitglied(env, "NurB", {}, "B");
    await firma(env, "Schreinerei Huber", { uid: UID_1 });
    const csvB = await env.call("GET", "/api/mitglieder/export.csv", { k: KUNDE_B });
    expect(csvB.body).toContain("NurB");
    expect(csvB.body).not.toContain("NurA");

    const dup = await env.B("POST", "/api/firmen/duplikate", {
      name: "Schreinerei Huber",
      uid: UID_1,
      adresse,
    });
    expect(dup.json().items).toEqual([]);

    const pubA = await env.call("GET", "/public/verein-a/firmen?q=huber");
    const pubB = await env.call("GET", "/public/verein-b/firmen?q=huber");
    expect(pubA.json().items).toHaveLength(1);
    expect(pubB.json().items).toHaveLength(0);

    // Gleiche E-Mail im Import von B ist kein Duplikat von A.
    await mitglied(env, "Mail", { email: "x@example.org" });
    const imp = await env.call("POST", "/api/mitglieder/import?dryRun=false", {
      k: KUNDE_B,
      csv: "Vorname;Nachname;E-Mail\nAnna;Neu;x@example.org\n",
    });
    expect(imp.json().importiert).toBe(1);
  });
});

describe("Firmenregister: Duplikate, Zusammenführen, Freigabe", () => {
  it("erkennt UID in anderer Schreibweise, Name ohne Rechtsform und ähnliche Namen", async () => {
    const env = await setup();
    const a = await firma(env, "Schreinerei Huber AG", { uid: UID_1 });
    await firma(env, "Gärtnerei Weiss", {
      adresse: { ...adresse, strasse: "Hauptstr.", plz: "3000", ort: "Bern" },
    });

    const uid = (
      await env.A("POST", "/api/firmen/duplikate", {
        name: "Ganz anders",
        uid: "CHE123456788",
        adresse,
      })
    ).json();
    expect(uid.items[0].score).toBe(1);
    expect(uid.items[0].gruende).toContain("uid");
    expect(uid.items[0].firma.id).toBe(a);

    const name = (
      await env.A("POST", "/api/firmen/duplikate", { name: "schreinerei  HUBER gmbh", adresse })
    ).json();
    expect(name.items[0].gruende).toEqual(expect.arrayContaining(["name", "adresse"]));

    const aehnlich = (
      await env.A("POST", "/api/firmen/duplikate", { name: "Schreinerei Hubers AG", adresse })
    ).json();
    expect(aehnlich.items[0].gruende).toContain("name_aehnlich");

    const keine = (
      await env.A("POST", "/api/firmen/duplikate", { name: "Bäckerei Frei", adresse })
    ).json();
    expect(keine.items).toEqual([]);
    expect(normalizeCompanyName("Müller & Söhne GmbH")).toBe("muller sohne");
    expect(similarity("abc", "xyz")).toBe(0);
  });

  it("führt zusammen: Mitglieder wandern, leere Felder werden ergänzt, Quelle bleibt als Spur", async () => {
    const env = await setup();
    const ziel = await firma(env, "Huber AG");
    const quelle = await firma(env, "Huber AG ", { uid: UID_1, email: "info@huber.example" });
    const m = (
      await env.A("POST", "/api/mitglieder", {
        typ: "firma",
        firmaId: quelle,
        vorname: "H",
        nachname: "Huber",
      })
    ).json().id;

    const res = await env.A("POST", `/api/firmen/${ziel}/zusammenfuehren`, { quelleId: quelle });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ id: ziel, uid: UID_1, email: "info@huber.example" });
    expect((await env.A("GET", `/api/mitglieder/${m}`)).json().firmaId).toBe(ziel);
    expect((await env.A("GET", `/api/firmen/${quelle}`)).json()).toMatchObject({
      status: "zusammengefuehrt",
      zusammengefuehrtMit: ziel,
    });
    // Zusammengeführte Firma taucht in Duplikaten und Auswahl nicht mehr auf.
    expect((await env.call("GET", "/public/verein-a/firmen?q=huber")).json().items).toHaveLength(1);
    expect(
      (await env.A("POST", `/api/firmen/${ziel}/zusammenfuehren`, { quelleId: quelle })).status,
    ).toBe(409);
    expect(
      (await env.A("POST", `/api/firmen/${ziel}/zusammenfuehren`, { quelleId: ziel })).status,
    ).toBe(400);
  });

  it("Freigabe nur für ausstehende Firmen; Ziel einer Zusammenführung muss freigegeben sein", async () => {
    const env = await setup();
    const f = await firma(env, "Freigegeben AG");
    expect((await env.A("POST", `/api/firmen/${f}/freigeben`)).status).toBe(409);
    await selbstRegistrierteFirma(env, "Neu AG", "neu@example.org");
    const offen = (await env.A("GET", "/api/firmen?status=ausstehend")).json().items;
    expect(offen).toHaveLength(1);
    const id = offen[0].id;
    expect((await env.A("POST", `/api/firmen/${f}/zusammenfuehren`, { quelleId: id })).status).toBe(
      200,
    );
    // Quelle ist jetzt zusammengeführt, nicht mehr freigabepflichtig.
    expect((await env.A("POST", `/api/firmen/${id}/freigeben`)).status).toBe(409);
  });
});

/** Durchläuft Formular, Absenden und Bestätigung einer Firmenregistrierung. */
async function selbstRegistrierteFirma(env: Env, name: string, email: string) {
  const { formToken } = (await env.call("GET", "/public/verein-a/registrierung/formular")).json();
  env.clock.now = new Date(env.clock.now.getTime() + 10_000);
  const res = await env.call("POST", "/public/verein-a/registrierung/firma", {
    body: { formToken, firma: { name, email, adresse } },
  });
  expect(res.status).toBe(202);
  const token = env.mails.at(-1)?.token as string;
  const ok = await env.call("POST", "/public/verein-a/registrierung/bestaetigen", {
    body: { token },
  });
  expect(ok.status).toBe(200);
}

async function formToken(env: Env, slug = "verein-a", warten = 10_000) {
  const t = (await env.call("GET", `/public/${slug}/registrierung/formular`)).json().formToken;
  env.clock.now = new Date(env.clock.now.getTime() + warten);
  return t as string;
}

describe("Öffentliche Registrierung", () => {
  const person = (email: string, extra: object = {}) => ({
    mitglied: { typ: "einzel", vorname: "Anna", nachname: "Neu", email },
    ...extra,
  });

  it("Double-Opt-in: Datensatz entsteht erst nach Bestätigung, Token gilt einmal", async () => {
    const env = await setup();
    const res = await env.call("POST", "/public/verein-a/registrierung/person", {
      body: { ...person("neu@example.org"), formToken: await formToken(env) },
    });
    expect(res.status).toBe(202);
    const { referenz } = res.json();
    expect(res.json()).toEqual({ status: "bestaetigung_gesendet", referenz });
    expect(referenz).toMatch(REFERENZ);
    expect((await env.A("GET", "/api/mitglieder")).json().items).toHaveLength(0);

    const mail = env.mails[0];
    expect(mail).toMatchObject({
      kundeId: KUNDE_A,
      kunde: "verein-a",
      an: "neu@example.org",
      vorlage: "registrierung_bestaetigen",
      art: "person",
      referenz,
      gueltigBis: new Date(env.clock.now.getTime() + 24 * 60 * 60_000),
    });
    const token = mail?.token as string;
    expect(token.length).toBeGreaterThanOrEqual(40);

    const ok = await env.call("POST", "/public/verein-a/registrierung/bestaetigen", {
      body: { token },
    });
    expect(ok.status).toBe(200);
    // Selbstregistriert heisst: ausstehend, bis ein Admin freigibt (nicht in der Liste der aktiven).
    expect((await env.A("GET", "/api/mitglieder")).json().items).toHaveLength(0);
    const wartet = (await env.A("GET", "/api/mitglieder?status=ausstehend")).json();
    expect(wartet.items).toHaveLength(1);
    expect(wartet.items[0]).toMatchObject({ status: "ausstehend", quelle: "selbst" });
    // Eingangsbestätigung nach dem Klick: gleiche Referenz, kein Link.
    expect(env.mails).toHaveLength(2);
    expect(env.mails[1]).toMatchObject({
      an: "neu@example.org",
      vorlage: "registrierung_eingegangen",
      art: "person",
      referenz,
    });
    expect(env.mails[1]?.token).toBeUndefined();
    const nochmal = await env.call("POST", "/public/verein-a/registrierung/bestaetigen", {
      body: { token },
    });
    expect(nochmal.status).toBe(400);
    expect((await env.A("GET", "/api/mitglieder?status=ausstehend")).json().items).toHaveLength(1);
  });

  it("Token ist an den Mandanten gebunden, läuft ab und lässt sich nicht raten", async () => {
    const env = await setup();
    await env.call("POST", "/public/verein-a/registrierung/person", {
      body: { ...person("a@example.org"), formToken: await formToken(env) },
    });
    const token = env.mails[0]?.token as string;
    const fremd = await env.call("POST", "/public/verein-b/registrierung/bestaetigen", {
      body: { token },
    });
    expect(fremd.status).toBe(400);
    // Das Fehlversuch-Token ist damit verbraucht: eine fremde Probe darf es nicht aufheben.
    const erneut = await env.call("POST", "/public/verein-a/registrierung/person", {
      body: { ...person("b@example.org"), formToken: await formToken(env) },
    });
    expect(erneut.status).toBe(202);
    const t2 = env.mails[1]?.token as string;
    env.clock.now = new Date(env.clock.now.getTime() + 25 * 60 * 60_000);
    expect(
      (
        await env.call("POST", "/public/verein-a/registrierung/bestaetigen", {
          body: { token: t2 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await env.call("POST", "/public/verein-a/registrierung/bestaetigen", {
          body: { token: "x".repeat(43) },
        })
      ).status,
    ).toBe(400);
    expect((await env.A("GET", "/api/mitglieder")).json().items).toHaveLength(0);
  });

  it("verrät nicht, ob die E-Mail schon registriert ist (SR-05)", async () => {
    const env = await setup();
    await mitglied(env, "Bekannt", { email: "bekannt@example.org" });
    const neu = await env.call("POST", "/public/verein-a/registrierung/person", {
      body: { ...person("unbekannt@example.org"), formToken: await formToken(env) },
    });
    const bekannt = await env.call("POST", "/public/verein-a/registrierung/person", {
      body: { ...person("bekannt@example.org"), formToken: await formToken(env) },
    });
    expect(bekannt.status).toBe(neu.status);
    // Gleiche Form; nur die Referenz ist je Anfrage verschieden.
    expect(Object.keys(bekannt.json())).toEqual(Object.keys(neu.json()));
    expect(bekannt.json().referenz).toMatch(REFERENZ);
    expect(env.mails[1]?.referenz).toBe(bekannt.json().referenz);
    expect(env.mails.map((m) => m.vorlage)).toEqual([
      "registrierung_bestaetigen",
      "registrierung_bekannt",
    ]);
    expect(env.mails[1]?.token).toBeUndefined();
    expect((await env.A("GET", "/api/mitglieder")).json().items).toHaveLength(1);
  });

  it("antwortet gleich, wenn der Mailversand scheitert", async () => {
    const env = await setup();
    const store = createMemoryStore();
    const mod = createPeopleModule({
      store,
      resolveContext: async () => undefined,
      resolveTenant: async (s) => SLUGS[s],
      mailer: { send: async () => Promise.reject(new Error("smtp down")) },
      formSecret: Buffer.alloc(32, 7),
      now: () => env.clock.now,
    });
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(async (s) => mod.register(s));
    const t = (
      await app.inject({ method: "GET", url: "/public/verein-a/registrierung/formular" })
    ).json().formToken;
    env.clock.now = new Date(env.clock.now.getTime() + 10_000);
    const res = await app.inject({
      method: "POST",
      url: "/public/verein-a/registrierung/person",
      payload: { ...person("m@example.org"), formToken: t },
    });
    expect(res.statusCode).toBe(202);
  });

  it("Bot-Schutz: Honeypot, zu schnell, abgelaufen, gefälscht", async () => {
    const env = await setup();
    const post = (body: object) =>
      env.call("POST", "/public/verein-a/registrierung/person", { body });

    const honeypot = await post({
      ...person("bot@example.org", { website: "http://spam.example" }),
      formToken: await formToken(env),
    });
    expect(honeypot.status).toBe(202); // nicht erkennbar abgewiesen
    expect(honeypot.json().referenz).toMatch(REFERENZ);
    expect(env.mails).toHaveLength(0);

    const sofort = await formToken(env, "verein-a", 0);
    expect((await post({ ...person("fix@example.org"), formToken: sofort })).status).toBe(400);

    const alt = await formToken(env, "verein-a", 3 * 60 * 60_000);
    expect((await post({ ...person("alt@example.org"), formToken: alt })).status).toBe(400);

    const gefaelscht = `${env.clock.now.getTime() - 60_000}.${"A".repeat(43)}`;
    expect((await post({ ...person("fake@example.org"), formToken: gefaelscht })).status).toBe(202);

    // Token eines anderen Mandanten gilt nicht.
    const fremd = await formToken(env, "verein-b");
    expect((await post({ ...person("x@example.org"), formToken: fremd })).status).toBe(202);
    expect(env.mails).toHaveLength(0);
    expect((await env.A("GET", "/api/mitglieder")).json().items).toHaveLength(0);
  });

  it("Rate-Limit je IP (SR-71): die sechste Registrierung pro Stunde wird gedrosselt", async () => {
    const env = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await env.call("POST", "/public/verein-a/registrierung/person", {
        body: { ...person(`u${i}@example.org`), formToken: await formToken(env) },
      });
      codes.push(res.status);
    }
    expect(codes).toEqual([202, 202, 202, 202, 202, 429]);
  });

  it("unbekannter Mandant: 404, ungültiger Slug: 400", async () => {
    const env = await setup();
    expect((await env.call("GET", "/public/gibt-es-nicht/registrierung/formular")).status).toBe(
      404,
    );
    expect((await env.call("GET", "/public/..%2Fx/registrierung/formular")).status).toBe(400);
  });

  it("Firmenregistrierung landet als ausstehend und erscheint erst nach Freigabe in der Auswahl", async () => {
    const env = await setup();
    await selbstRegistrierteFirma(env, "Neue Firma AG", "info@neu.example");
    expect((await env.call("GET", "/public/verein-a/firmen?q=neue")).json().items).toEqual([]);
    const id = (await env.A("GET", "/api/firmen?status=ausstehend")).json().items[0].id;
    expect((await env.A("POST", `/api/firmen/${id}/freigeben`)).json().status).toBe("freigegeben");
    const liste = (await env.call("GET", "/public/verein-a/firmen?q=neue")).json().items;
    expect(liste).toEqual([{ id, name: "Neue Firma AG", ort: "Zürich" }]);
    expect(liste[0]).not.toHaveProperty("email");

    // Person registriert sich als Firmenmitglied mit dieser Firma.
    const res = await env.call("POST", "/public/verein-a/registrierung/person", {
      body: {
        mitglied: {
          typ: "firma",
          firmaId: id,
          vorname: "Eva",
          nachname: "Chefin",
          email: "eva@neu.example",
        },
        formToken: await formToken(env),
      },
    });
    expect(res.status).toBe(202);
    await env.call("POST", "/public/verein-a/registrierung/bestaetigen", {
      body: { token: env.mails.at(-1)?.token },
    });
    expect(
      (await env.A("GET", `/api/mitglieder?firmaId=${id}&status=ausstehend`)).json().items,
    ).toHaveLength(1);
  });

  it("übernimmt Geburtsdatum der Person und Kontaktperson der Firma nach der Bestätigung", async () => {
    const env = await setup();
    const res = await env.call("POST", "/public/verein-a/registrierung/person", {
      body: {
        mitglied: { ...person("geb@example.org").mitglied, geburtsdatum: "1985-03-07" },
        formToken: await formToken(env),
      },
    });
    expect(res.status).toBe(202);
    await env.call("POST", "/public/verein-a/registrierung/bestaetigen", {
      body: { token: env.mails.at(-1)?.token },
    });
    const m = (await env.A("GET", "/api/mitglieder?status=ausstehend")).json().items[0];
    expect(m.geburtsdatum).toBe("1985-03-07");

    const { formToken: ft } = (
      await env.call("GET", "/public/verein-a/registrierung/formular")
    ).json();
    env.clock.now = new Date(env.clock.now.getTime() + 10_000);
    const firma = await env.call("POST", "/public/verein-a/registrierung/firma", {
      body: {
        formToken: ft,
        firma: { name: "Kontakt AG", email: "k@example.org", adresse, kontaktperson: "Eva Muster" },
      },
    });
    expect(firma.json().referenz).toMatch(REFERENZ);
    await env.call("POST", "/public/verein-a/registrierung/bestaetigen", {
      body: { token: env.mails.at(-1)?.token },
    });
    expect((await env.A("GET", "/api/firmen?status=ausstehend")).json().items[0]).toMatchObject({
      kontaktperson: "Eva Muster",
    });
    // Die Firmen-Eingangsbestätigung nennt die Art.
    expect(env.mails.at(-1)).toMatchObject({ vorlage: "registrierung_eingegangen", art: "firma" });
  });

  it.each(["1899-12-31", "2999-01-01", "07.03.1985", "1985-02-30"])(
    "weist das Geburtsdatum %s ab",
    async (geburtsdatum) => {
      const env = await setup();
      const res = await env.call("POST", "/public/verein-a/registrierung/person", {
        body: {
          mitglied: { ...person("x@example.org").mitglied, geburtsdatum },
          formToken: await formToken(env),
        },
      });
      expect(res.status).toBe(400);
      expect(env.mails).toHaveLength(0);
    },
  );

  it("Firmensuche verlangt mindestens zwei Zeichen", async () => {
    const env = await setup();
    expect((await env.call("GET", "/public/verein-a/firmen?q=a")).status).toBe(400);
    expect((await env.call("GET", "/public/verein-a/firmen")).status).toBe(400);
  });
});

describe("CSV: Injection, Limits, Import/Export", () => {
  it("neutralisiert Formelzeichen beim Export, Telefonnummern bleiben lesbar", () => {
    for (const v of ["=1+1", "+cmd|' /C calc'!A0", "-2+3", "@SUM(A1)", "\tx", "\rx"]) {
      expect(neutralizeCell(v).startsWith("'")).toBe(true);
    }
    expect(neutralizeCell("+41791234567")).toBe("+41791234567");
    expect(neutralizeCell("Anna")).toBe("Anna");
    const csv = toCsv([['=HYPERLINK("http://x")', 'mit "Quote"; und Semikolon']]);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain(`"mit ""Quote""; und Semikolon"`);
  });

  it("Export enthält gefährliche, gültige Namen nur neutralisiert", async () => {
    const env = await setup();
    await env.A("POST", "/api/mitglieder", {
      typ: "einzel",
      vorname: "-2+3",
      nachname: "+cmd",
    });
    const res = await env.call("GET", "/api/mitglieder/export.csv", { k: KUNDE_A });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    const dataRow = res.body.split("\r\n")[1] as string;
    expect(dataRow.split(";").slice(1, 3)).toEqual(["'-2+3", "'+cmd"]);
  });

  it("Import weist Formeln in Namen zeilenweise ab, ohne Werte zu nennen", async () => {
    const env = await setup();
    const csv =
      'Vorname;Nachname;E-Mail\nAnna;=HYPERLINK("http://evil");a@example.org\nBen;Gut;b@example.org\n';
    const res = await env.call("POST", "/api/mitglieder/import?dryRun=false", { k: KUNDE_A, csv });
    expect(res.json()).toEqual({
      zeilen: 2,
      importiert: 0,
      aktualisiert: 0,
      uebersprungen: 0,
      fehler: [{ zeile: 2, grund: "UNGUELTIG", felder: ["nachname"] }],
    });
    expect(res.body).not.toContain("evil");
    // Alles oder nichts: auch die gültige Zeile wurde nicht übernommen.
    expect((await env.A("GET", "/api/mitglieder")).json().items).toHaveLength(0);
  });

  it("Import: Trockenlauf ist Standard, danach Commit, Duplikate und Firmenbezug", async () => {
    const env = await setup();
    await firma(env, "Huber AG");
    const csv = [
      "Typ;Vorname;Nachname;Firma;E-Mail;Telefon;Strasse;Hausnr;PLZ;Ort",
      "einzel;Anna;Eins;;a@example.org;079 111 22 33;Bahnhofstrasse;1;8001;Zürich",
      "firma;Hans;Zwei;huber;h@example.org;;;;;",
      "",
    ].join("\r\n");
    const trocken = await env.call("POST", "/api/mitglieder/import", { k: KUNDE_A, csv });
    expect(trocken.json()).toEqual({
      zeilen: 2,
      importiert: 0,
      aktualisiert: 0,
      uebersprungen: 0,
      fehler: [],
    });
    expect((await env.A("GET", "/api/mitglieder")).json().items).toHaveLength(0);

    const echt = await env.call("POST", "/api/mitglieder/import?dryRun=false", { k: KUNDE_A, csv });
    expect(echt.json().importiert).toBe(2);
    const liste = (await env.A("GET", "/api/mitglieder")).json().items;
    expect(liste.map((m: { firmaName: string | null }) => m.firmaName)).toEqual([null, "Huber AG"]);
    expect(liste[0].telefon).toBe("+41791112233");

    const nochmal = await env.call("POST", "/api/mitglieder/import?dryRun=false", {
      k: KUNDE_A,
      csv,
    });
    expect(nochmal.json().fehler.map((f: { grund: string }) => f.grund)).toEqual([
      "E_MAIL_DOPPELT",
      "E_MAIL_DOPPELT",
    ]);

    const unbekannteFirma = "Vorname;Nachname;Firma\nA;B;Gibt es nicht\n";
    const r = await env.call("POST", "/api/mitglieder/import", {
      k: KUNDE_A,
      csv: unbekannteFirma,
    });
    expect(r.json().fehler[0].grund).toBe("FIRMA_UNBEKANNT");
  });

  it("Export und Import sind rundum verlustfrei, auch bei neutralisierten Zellen", async () => {
    const env = await setup();
    await env.A("POST", "/api/mitglieder", {
      typ: "einzel",
      vorname: "-Ann",
      nachname: 'Quote"s; Co',
      email: "q@example.org",
    });
    const csv = (await env.call("GET", "/api/mitglieder/export.csv", { k: KUNDE_A })).body;
    const res = await env.call("POST", "/api/mitglieder/import?dryRun=false", { k: KUNDE_B, csv });
    expect(res.json().importiert).toBe(1);
    const m = (await env.B("GET", "/api/mitglieder")).json().items[0];
    expect(m).toMatchObject({ vorname: "-Ann", nachname: 'Quote"s; Co' });
  });

  it("Grössenlimit (SR-71/SR-23): zu grosse Datei 413, falscher Typ abgewiesen, Pflichtspalten", async () => {
    const env = await setup();
    const gross = "Vorname;Nachname\n" + "A;B\n".repeat(CSV_MAX_BYTES / 4 + 10);
    expect(
      (await env.call("POST", "/api/mitglieder/import", { k: KUNDE_A, csv: gross })).status,
    ).toBe(413);
    const json = await env.app.inject({
      method: "POST",
      url: "/api/mitglieder/import",
      headers: { "x-kunde": KUNDE_A, "content-type": "application/json" },
      payload: { a: 1 },
    });
    expect(json.statusCode).toBe(400);
    const ohneSpalten = await env.call("POST", "/api/mitglieder/import", {
      k: KUNDE_A,
      csv: "Foo;Bar\n1;2\n",
    });
    expect(ohneSpalten.status).toBe(400);
  });

  it("Zeilenlimit und kaputte Anführungszeichen", () => {
    expect(() => parseCsv('a;b\n"offen;1')).toThrow();
    const viele = "a\n" + "x\n".repeat(5_100);
    expect(() => parseCsv(viele)).toThrow();
    expect(parseCsv('a,b\r\n"1,5",2\r\n')).toEqual([
      ["a", "b"],
      ["1,5", "2"],
    ]);
  });
});

describe("Personen: Mitgliedsnummer, Datumsfelder, Kanal, Gruppe seit, Gesamtzahl (#108)", () => {
  it("vergibt Mitgliedsnummern je Mandant, speichert die Zusatzfelder, ändert die Nummer nie", async () => {
    const env = await setup();
    const a = (
      await env.A(
        "POST",
        "/api/mitglieder",
        einzel("Eins", { geburtsdatum: "1985-03-14", eintritt: "2019-01-01", kanal: "post" }),
      )
    ).json();
    const b = (await env.A("POST", "/api/mitglieder", einzel("Zwei"))).json();
    const fremd = (await env.B("POST", "/api/mitglieder", einzel("Drei"))).json();
    expect(a).toMatchObject({
      mitgliedsnr: "M-1001",
      geburtsdatum: "1985-03-14",
      eintritt: "2019-01-01",
      kanal: "post",
      gruppeSeit: null,
    });
    expect(b).toMatchObject({ mitgliedsnr: "M-1002", geburtsdatum: null, eintritt: null });
    expect(b.kanal).toBeNull();
    expect(fremd.mitgliedsnr).toBe("M-1001"); // eigener Nummernkreis je Mandant

    const patch = await env.A("PATCH", `/api/mitglieder/${a.id}`, {
      mitgliedsnr: "M-9",
      geburtsdatum: null,
      kanal: "email",
      eintritt: "2020-02-29",
    });
    expect(patch.json()).toMatchObject({
      mitgliedsnr: "M-1001",
      geburtsdatum: null,
      kanal: "email",
      eintritt: "2020-02-29",
    });
  });

  it("prüft Datum und Kanal: Format, Bereich, keine Zukunft als Geburtsdatum", async () => {
    const env = await setup();
    for (const extra of [
      { geburtsdatum: "14.03.1985" },
      { geburtsdatum: "1985-02-30" },
      { geburtsdatum: "1850-01-01" },
      { geburtsdatum: "2999-01-01" },
      { eintritt: "gestern" },
      { kanal: "brieftaube" },
    ]) {
      const res = await env.A("POST", "/api/mitglieder", einzel("Falsch", extra));
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await env.A("GET", "/api/mitglieder")).json().items).toHaveLength(0);
  });

  it("Gruppe seit: gesetzt beim Zuweisen, leer nach dem Entfernen", async () => {
    const env = await setup();
    const g = await gruppe(env, "Vorstand");
    const m = await mitglied(env, "Eins");
    await env.A("PUT", `/api/mitglieder/${m}/gruppe`, { gruppeId: g });
    const seit = (await env.A("GET", `/api/mitglieder/${m}`)).json().gruppeSeit as string;
    expect(Math.abs(Date.now() - new Date(seit).getTime())).toBeLessThan(60_000);
    // Dieselbe Gruppe nochmals zuweisen verschiebt das Datum nicht.
    await env.A("PUT", `/api/mitglieder/${m}/gruppe`, { gruppeId: g });
    expect((await env.A("GET", `/api/mitglieder/${m}`)).json().gruppeSeit).toBe(seit);
    await env.A("DELETE", `/api/mitglieder/${m}/gruppe`);
    expect((await env.A("GET", `/api/mitglieder/${m}`)).json().gruppeSeit).toBeNull();
  });

  it("Listen melden die Gesamtzahl des Filters, unabhängig von Seite und Cursor", async () => {
    const env = await setup();
    for (const n of ["Aa", "Bb", "Cc"]) await mitglied(env, n);
    await mitglied(env, "Fremd", {}, "B");
    const zora = await mitglied(env, "Dd");
    await env.A("PATCH", `/api/mitglieder/${zora}`, { vorname: "Zora" });
    const seite1 = (await env.A("GET", "/api/mitglieder?limit=2")).json();
    expect(seite1.items).toHaveLength(2);
    expect(seite1.total).toBe(4);
    const url = `/api/mitglieder?limit=2&cursor=${seite1.nextCursor}`;
    expect((await env.A("GET", url)).json()).toMatchObject({ total: 4, nextCursor: null });
    expect((await env.A("GET", "/api/mitglieder?q=zora")).json().total).toBe(1);
    expect((await env.A("GET", "/api/mitglieder?status=archiviert")).json().total).toBe(0);

    await firma(env, "Eins AG");
    await firma(env, "Zwei AG");
    await firma(env, "Fremd AG", {}, "B");
    const firmen = (await env.A("GET", "/api/firmen?limit=1")).json();
    expect(firmen.items).toHaveLength(1);
    expect(firmen.total).toBe(2);
  });
});

describe("Gruppen: Beschreibung, angelegt, zuletzt geändert, Adresslisten (#108)", () => {
  it("speichert die Beschreibung und führt den Zeitpunkt der letzten Änderung nach", async () => {
    const env = await setup();
    const res = await env.A("POST", "/api/gruppen", {
      name: "Vorstand",
      beschreibung: "Leitung des Vereins",
    });
    expect(res.status).toBe(201);
    const g = res.json();
    expect(g).toMatchObject({
      name: "Vorstand",
      mitglieder: 0,
      beschreibung: "Leitung des Vereins",
      erstelltAm: "2026-11-04T10:00:00.000Z",
      geaendertAm: "2026-11-04T10:00:00.000Z",
      adresslisten: [],
    });

    env.clock.now = new Date("2026-11-05T08:00:00Z");
    expect((await env.A("PATCH", `/api/gruppen/${g.id}`, { name: "Leitung" })).status).toBe(204);
    const nachUmbenennen = (await env.A("GET", "/api/gruppen")).json().items[0];
    expect(nachUmbenennen).toMatchObject({
      name: "Leitung",
      beschreibung: "Leitung des Vereins", // fehlt im Body: bleibt
      erstelltAm: "2026-11-04T10:00:00.000Z",
      geaendertAm: "2026-11-05T08:00:00.000Z",
    });
    await env.A("PATCH", `/api/gruppen/${g.id}`, { beschreibung: null });
    expect((await env.A("GET", "/api/gruppen")).json().items[0].beschreibung).toBeNull();
  });

  it("verlangt ein Feld, lehnt Übergrosses ab und bleibt im Mandanten", async () => {
    const env = await setup();
    const g = await gruppe(env, "Vorstand");
    expect((await env.A("PATCH", `/api/gruppen/${g}`, {})).status).toBe(400);
    expect(
      (await env.A("PATCH", `/api/gruppen/${g}`, { beschreibung: "x".repeat(301) })).status,
    ).toBe(400);
    expect((await env.B("PATCH", `/api/gruppen/${g}`, { beschreibung: "fremd" })).status).toBe(404);
    expect((await env.A("GET", "/api/gruppen")).json().items[0].beschreibung).toBeNull();
  });
});

describe("Firmen: Kontaktperson, Rechnungs-E-Mail, Bemerkung, Quelle, Mitgliederzahl (#108)", () => {
  it("speichert die Zusatzfelder, zählt aktive Firmenmitglieder und löscht mit null", async () => {
    const env = await setup();
    const id = await firma(env, "Huber AG", {
      kontaktperson: "Beat Muster",
      rechnungsEmail: "buchhaltung@huber.example",
      notiz: "Rechnung bitte per Post",
    });
    expect((await env.A("GET", `/api/firmen/${id}`)).json()).toMatchObject({
      kontaktperson: "Beat Muster",
      rechnungsEmail: "buchhaltung@huber.example",
      notiz: "Rechnung bitte per Post",
      quelle: "manuell",
      mitglieder: 0,
    });

    const person = (n: string) => ({ typ: "firma", firmaId: id, vorname: "H", nachname: n });
    await env.A("POST", "/api/mitglieder", person("Eins"));
    const zwei = (await env.A("POST", "/api/mitglieder", person("Zwei"))).json().id;
    await env.A("POST", "/api/mitglieder/sammelaktion", { ids: [zwei], aktion: "archivieren" });
    expect((await env.A("GET", `/api/firmen/${id}`)).json().mitglieder).toBe(1);
    expect((await env.A("GET", "/api/firmen")).json().items[0].mitglieder).toBe(1);

    const patch = await env.A("PATCH", `/api/firmen/${id}`, { kontaktperson: null, notiz: null });
    expect(patch.json()).toMatchObject({
      kontaktperson: null,
      notiz: null,
      rechnungsEmail: "buchhaltung@huber.example",
    });
    expect(
      (await env.A("PATCH", `/api/firmen/${id}`, { rechnungsEmail: "kein-mail" })).status,
    ).toBe(400);
  });

  it("Selbstregistrierung ist Quelle «selbst», der Admin erfasst «manuell»", async () => {
    const env = await setup();
    await firma(env, "Admin AG");
    await selbstRegistrierteFirma(env, "Neu AG", "neu@example.org");
    const items = (await env.A("GET", "/api/firmen?status=ausstehend")).json().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "Neu AG", quelle: "selbst" });
    const nach = async (q: string) => (await env.A("GET", `/api/firmen?${q}`)).json();
    expect((await nach("quelle=selbst&status=ausstehend")).items).toHaveLength(1);
    expect((await nach("quelle=manuell")).items.map((f: { name: string }) => f.name)).toEqual([
      "Admin AG",
    ]);
    expect((await nach("quelle=manuell")).total).toBe(1);
    expect((await env.A("GET", "/api/firmen?quelle=anders")).status).toBe(400);
  });
});

describe("Duplikate im ganzen Firmenregister (#108)", () => {
  const pair = (a: string, b: string) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const NIRGENDS = "11111111-1111-4111-8111-111111111111";

  async function huberPaar(env: Env) {
    const ziel = await firma(env, "Huber AG", { email: "ziel@huber.example" });
    const quelle = await firma(env, "Huber GmbH", {
      uid: UID_1,
      email: "quelle@huber.example",
      telefon: "044 111 22 33",
      adresse: { strasse: "Hauptstrasse", hausnr: "7", plz: "8001", ort: "Zürich" },
    });
    await firma(env, "Bäckerei Frei", {
      adresse: { strasse: "Dorfplatz", plz: "3000", ort: "Bern" },
    });
    return { ziel, quelle, id: pair(ziel, quelle) };
  }

  it("listet Paare mit Treffern, Ähnlichkeit, Feldern und Mitgliederzahl; Details einzeln", async () => {
    const env = await setup();
    const { ziel, quelle, id } = await huberPaar(env);
    await env.A("POST", "/api/mitglieder", {
      typ: "firma",
      firmaId: quelle,
      vorname: "H",
      nachname: "H",
    });

    const list = (await env.A("GET", "/api/duplikate")).json();
    expect(list.items).toHaveLength(1);
    const d = list.items[0];
    expect(d).toMatchObject({
      id,
      art: "firma",
      status: "offen",
      trefferBei: ["name"],
      aehnlichkeit: 95,
    });
    const sides = Object.fromEntries([d.a, d.b].map((e) => [e.id, e]));
    expect(sides[ziel]).toMatchObject({ name: "Huber AG", mitglieder: 0 });
    expect(sides[quelle]).toMatchObject({
      name: "Huber GmbH",
      mitglieder: 1,
      felder: {
        name: "Huber GmbH",
        uid: UID_1,
        strasse: "Hauptstrasse 7",
        plzOrt: "8001 Zürich",
        email: "quelle@huber.example",
        telefon: "+41441112233",
      },
    });
    expect(sides[ziel].felder).not.toHaveProperty("uid"); // leere Felder fehlen

    expect((await env.A("GET", `/api/duplikate/${id}`)).json()).toMatchObject({ id });
    // Ungültige Kennung: 400; gültige Form, aber kein Duplikat oder unbekannt: 404.
    expect((await env.A("GET", "/api/duplikate/nope")).status).toBe(400);
    const anders = await firma(env, "Ganz Anders", {
      adresse: { ...adresse, plz: "9000", ort: "St. Gallen" },
    });
    expect((await env.A("GET", `/api/duplikate/${pair(ziel, anders)}`)).status).toBe(404);
    expect((await env.A("GET", `/api/duplikate/${pair(ziel, NIRGENDS)}`)).status).toBe(404);
  });

  it("«kein Duplikat» gilt je Mandant, ist wiederholbar und bleibt in der Liste sichtbar", async () => {
    const env = await setup();
    const { id } = await huberPaar(env);
    expect((await env.A("POST", `/api/duplikate/${id}/kein-duplikat`)).status).toBe(204);
    expect((await env.A("POST", `/api/duplikate/${id}/kein-duplikat`)).status).toBe(204);
    expect((await env.A("GET", "/api/duplikate")).json().items[0].status).toBe("kein_duplikat");
    expect((await env.A("GET", `/api/duplikate/${id}`)).json().status).toBe("kein_duplikat");
    // Mandant B kennt weder das Paar noch darf er es markieren.
    expect((await env.B("POST", `/api/duplikate/${id}/kein-duplikat`)).status).toBe(404);
    expect((await env.B("GET", "/api/duplikate")).json().items).toEqual([]);
    expect((await env.B("GET", `/api/duplikate/${id}`)).status).toBe(404);
  });

  it("führt mit Wertwahl zusammen: gewählte Seite zuerst, Lücken füllt die andere", async () => {
    const env = await setup();
    const { ziel, quelle, id } = await huberPaar(env);
    const m = (
      await env.A("POST", "/api/mitglieder", {
        typ: "firma",
        firmaId: quelle,
        vorname: "H",
        nachname: "H",
      })
    ).json().id;
    const merge = (who: "A" | "B", body: unknown) =>
      env[who]("POST", `/api/duplikate/${id}/zusammenfuehren`, body);

    // Mandant B und fremde IDs kommen nicht durch; behaltenId muss zum Paar gehören.
    expect((await merge("B", { behaltenId: ziel, werte: { name: "entfernen" } })).status).toBe(404);
    expect((await merge("A", { behaltenId: NIRGENDS, werte: {} })).status).toBe(400);
    expect((await merge("A", { behaltenId: ziel, werte: { uid: "alle" } })).status).toBe(400);
    expect((await merge("A", { behaltenId: ziel, werte: { notiz: "entfernen" } })).status).toBe(
      400,
    );

    const res = await merge("A", {
      behaltenId: ziel,
      werte: { name: "entfernen", email: "entfernen", strasse: "entfernen", plzOrt: "behalten" },
    });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({
      id: ziel,
      name: "Huber GmbH", // Wahl: Quelle
      email: "quelle@huber.example", // Wahl: Quelle
      uid: UID_1, // nicht gewählt, aber im Ziel leer: von der Quelle ergänzt
      telefon: "+41441112233",
      adresse: { strasse: "Hauptstrasse", hausnr: "7", plz: "8001", ort: "Zürich" },
      mitglieder: 1,
    });
    expect((await env.A("GET", `/api/mitglieder/${m}`)).json().firmaId).toBe(ziel);
    expect((await env.A("GET", `/api/firmen/${quelle}`)).json()).toMatchObject({
      status: "zusammengefuehrt",
      zusammengefuehrtMit: ziel,
    });
    expect((await env.A("GET", "/api/duplikate")).json().items).toEqual([]);
    // Die Quelle ist weg: erneutes Zusammenführen wird abgewiesen.
    expect((await merge("A", { behaltenId: ziel, werte: {} })).status).toBe(409);
  });

  it("wählt die entfernte Seite, hat sie keinen Wert, bleibt der der behaltenen: nichts geht verloren", async () => {
    const env = await setup();
    const { quelle, id } = await huberPaar(env);
    // Behalten wird die Firma mit UID und Telefon. «entfernen» für das Telefon der anderen Seite
    // (hat keines) darf nichts löschen; die E-Mail der anderen Seite ersetzt die eigene.
    const res = await env.A("POST", `/api/duplikate/${id}/zusammenfuehren`, {
      behaltenId: quelle,
      werte: { telefon: "entfernen", email: "entfernen" },
    });
    expect(res.json()).toMatchObject({
      id: quelle,
      email: "ziel@huber.example",
      telefon: "+41441112233",
      uid: UID_1,
    });
  });
});

describe("Import: Optionen und Zielgruppe (#108)", () => {
  const post = (env: Env, query: string, csv: string, k = KUNDE_A) =>
    env.call("POST", `/api/mitglieder/import?${query}`, { k, csv });
  const CSV = [
    "Vorname;Nachname;E-Mail;Telefon;Gruppe",
    "Neu;Eins;n1@example.org;;Revision",
    "Neu;Zwei;n2@example.org;;",
    "Alma;Alt;alt@example.org;079 999 88 77;",
  ].join("\r\n");

  async function bestand(env: Env) {
    const vorstand = await gruppe(env, "Vorstand");
    const revision = await gruppe(env, "Revision");
    const alt = await mitglied(env, "Alt", { email: "alt@example.org" });
    await env.A("PUT", `/api/mitglieder/${alt}/gruppe`, { gruppeId: revision });
    return { vorstand, revision, alt };
  }

  it("Standard: bekannte E-Mail ist ein Fehler; «überspringen» lässt die Zeile aus", async () => {
    const env = await setup();
    await bestand(env);
    expect((await post(env, "dryRun=true", CSV)).json()).toMatchObject({
      importiert: 0,
      fehler: [{ zeile: 4, grund: "E_MAIL_DOPPELT", felder: ["email"] }],
    });
    const skip = await post(env, "dryRun=false&duplikate=ueberspringen", CSV);
    expect(skip.json()).toEqual({
      zeilen: 3,
      importiert: 2,
      aktualisiert: 0,
      uebersprungen: 1,
      fehler: [],
    });
    const alt = (await env.A("GET", "/api/mitglieder?q=alt@example.org")).json().items[0];
    expect(alt).toMatchObject({ vorname: "Anna", telefon: null });
  });

  it("«aktualisieren» ändert Bestehende; die Zielgruppe gilt für Zeilen ohne eigene Gruppe und ersetzt die bisherige", async () => {
    const env = await setup();
    const { vorstand, revision, alt } = await bestand(env);
    const dry = await post(env, `dryRun=true&aktualisieren=true&gruppeId=${vorstand}`, CSV);
    expect(dry.json()).toEqual({
      zeilen: 3,
      importiert: 0,
      aktualisiert: 1,
      uebersprungen: 0,
      fehler: [],
    });
    expect((await env.A("GET", "/api/mitglieder")).json().items).toHaveLength(1);

    const res = await post(env, `dryRun=false&aktualisieren=true&gruppeId=${vorstand}`, CSV);
    expect(res.json()).toMatchObject({ importiert: 2, aktualisiert: 1 });
    const byEmail = async (q: string) =>
      (await env.A("GET", `/api/mitglieder?q=${q}`)).json().items[0];
    expect(await byEmail("n1@example.org")).toMatchObject({ gruppeId: revision }); // Spalte gewinnt
    expect(await byEmail("n2@example.org")).toMatchObject({ gruppeId: vorstand }); // Zielgruppe
    expect(await byEmail("alt@example.org")).toMatchObject({
      id: alt,
      vorname: "Alma",
      telefon: "+41799998877",
      email: "alt@example.org",
      gruppeId: vorstand, // ersetzt Revision
    });
    const gruppen = (await env.A("GET", "/api/gruppen")).json().items;
    expect(
      Object.fromEntries(
        gruppen.map((g: { name: string; mitglieder: number }) => [g.name, g.mitglieder]),
      ),
    ).toEqual({ Revision: 1, Vorstand: 2 });
  });

  it("alles oder nichts: unbekannte Gruppe oder fremde Zielgruppe ändert nichts", async () => {
    const env = await setup();
    await bestand(env);
    const fremd = (await env.B("POST", "/api/gruppen", { name: "Fremd" })).json().id;
    const unbekannt = CSV.replace("Revision", "Gibt es nicht");
    const r = await post(env, "dryRun=false&aktualisieren=true", unbekannt);
    expect(r.json()).toMatchObject({
      importiert: 0,
      fehler: [{ zeile: 2, grund: "GRUPPE_UNBEKANNT", felder: ["gruppe"] }],
    });
    expect((await post(env, `dryRun=false&gruppeId=${fremd}`, CSV)).status).toBe(400);
    expect((await post(env, "dryRun=false&gruppeId=keine-uuid", CSV)).status).toBe(400);
    expect((await env.A("GET", "/api/mitglieder")).json().items).toHaveLength(1);
    // Mandant B sieht die Gruppen von A nicht: dieselbe Datei scheitert dort an der Gruppe.
    const b = await post(env, "dryRun=true", CSV, KUNDE_B);
    expect(b.json().fehler[0].grund).toBe("GRUPPE_UNBEKANNT");
  });
});

describe("Personen: Freigabe selbst registrierter Personen (#135)", () => {
  async function registriere(env: Env, email: string, extra: object = {}) {
    const res = await env.call("POST", "/public/verein-a/registrierung/person", {
      body: {
        mitglied: { typ: "einzel", vorname: "Rita", nachname: "Neu", email, ...extra },
        formToken: await formToken(env),
      },
    });
    expect(res.status).toBe(202);
    await env.call("POST", "/public/verein-a/registrierung/bestaetigen", {
      body: { token: env.mails.at(-1)?.token },
    });
    const list = (await env.A("GET", `/api/mitglieder?status=ausstehend&q=${email}`)).json();
    return list.items[0].id as string;
  }

  it("gibt frei: die Person wird aktiv; eine zweite Freigabe ist ein Konflikt", async () => {
    const env = await setup();
    const id = await registriere(env, "rita@example.org");
    const res = await env.A("POST", `/api/mitglieder/${id}/freigeben`);
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ id, status: "aktiv", quelle: "selbst" });
    expect((await env.A("GET", "/api/mitglieder")).json().items).toHaveLength(1);
    expect((await env.A("GET", "/api/mitglieder?status=ausstehend")).json().total).toBe(0);
    expect((await env.A("POST", `/api/mitglieder/${id}/freigeben`)).status).toBe(409);
    expect((await env.A("POST", `/api/mitglieder/${id}/ablehnen`)).status).toBe(409);
  });

  it("lehnt ab: die Person steht nur unter «abgelehnt» und lässt sich nicht freigeben", async () => {
    const env = await setup();
    const id = await registriere(env, "rita@example.org");
    expect((await env.A("POST", `/api/mitglieder/${id}/ablehnen`)).json().status).toBe("abgelehnt");
    expect((await env.A("GET", "/api/mitglieder")).json().items).toHaveLength(0);
    expect((await env.A("GET", "/api/mitglieder?status=abgelehnt")).json().items).toHaveLength(1);
    expect((await env.A("POST", `/api/mitglieder/${id}/freigeben`)).status).toBe(409);
  });

  it("zählt Ausstehende und filtert nach Quelle; «alle» nimmt jeden Status", async () => {
    const env = await setup();
    await mitglied(env, "Manuell", { email: "m@example.org" });
    const a = await registriere(env, "a@example.org");
    await registriere(env, "b@example.org");
    await env.A("POST", `/api/mitglieder/${a}/freigeben`);
    expect((await env.A("GET", "/api/mitglieder?status=ausstehend")).json().total).toBe(1);
    const selbst = (await env.A("GET", "/api/mitglieder?status=alle&quelle=selbst")).json();
    expect(selbst.items.map((m: { status: string }) => m.status).sort()).toEqual([
      "aktiv",
      "ausstehend",
    ]);
    expect((await env.A("GET", "/api/mitglieder?status=alle")).json().total).toBe(3);
  });

  it("Ausstehende bleiben aus Sammelaktionen und Gruppen heraus; der Admin kann sie korrigieren", async () => {
    const env = await setup();
    const id = await registriere(env, "rita@example.org");
    const g = await gruppe(env, "Aktive");
    const bulk = await env.A("POST", "/api/mitglieder/sammelaktion", {
      ids: [id],
      aktion: "archivieren",
    });
    expect(bulk.json()).toEqual({ ok: 0, fehler: [{ id, grund: "KONFLIKT" }] });
    expect((await env.A("PUT", `/api/mitglieder/${id}/gruppe`, { gruppeId: g })).status).toBe(409);
    const fix = await env.A("PATCH", `/api/mitglieder/${id}`, { nachname: "Korrigiert" });
    expect(fix.json()).toMatchObject({ nachname: "Korrigiert", status: "ausstehend" });
  });

  it("gehört dem Mandanten: fremde Freigabe ist 404, ohne Anmeldung 401", async () => {
    const env = await setup();
    const id = await registriere(env, "rita@example.org");
    expect((await env.B("POST", `/api/mitglieder/${id}/freigeben`)).status).toBe(404);
    expect((await env.B("POST", `/api/mitglieder/${id}/ablehnen`)).status).toBe(404);
    expect((await env.A("GET", "/api/mitglieder?status=ausstehend")).json().items).toHaveLength(1);
    expect((await env.call("POST", `/api/mitglieder/${id}/freigeben`)).status).toBe(401);
  });
});

describe("Personen: Finanzen und Verlauf (#135)", () => {
  it("fasst Rechnungen, Konto und Verlauf aus dem Rechnungsmodul zusammen", async () => {
    const env = await setup();
    const id = await mitglied(env, "Zahler", { email: "z@example.org" });
    const g = await gruppe(env, "Aktive");
    await env.A("PUT", `/api/mitglieder/${id}/gruppe`, { gruppeId: g });
    env.rechnungen.data = {
      rechnungen: [
        {
          id: "r2",
          nr: "R-2026-0002",
          datum: "2026-10-01",
          betrag: 6000,
          offen: 6000,
          versendetAm: new Date("2026-10-01T08:00:00Z"),
        },
        {
          id: "r1",
          nr: "R-2026-0001",
          datum: "2026-03-01",
          betrag: 5000,
          offen: 0,
          versendetAm: new Date("2026-03-01T08:00:00Z"),
        },
      ],
      zahlungen: [{ datum: "2026-03-15", betrag: 5000, rechnungNr: "R-2026-0001" }],
      mahnungen: [{ datum: "2026-10-20", stufe: 2, rechnungId: "r2", rechnungNr: "R-2026-0002" }],
      mails: 3,
    };
    env.clock.now = new Date("2026-11-04T12:00:00Z");

    const res = await env.A("GET", `/api/mitglieder/${id}/finanzen`);
    expect(res.status).toBe(200);
    const f = res.json();
    expect(f.rechnungen).toEqual([
      {
        id: "r2",
        nr: "R-2026-0002",
        datum: "2026-10-01",
        betrag: 6000,
        offen: 6000,
        status: "offen",
      },
      {
        id: "r1",
        nr: "R-2026-0001",
        datum: "2026-03-01",
        betrag: 5000,
        offen: 0,
        status: "bezahlt",
      },
    ]);
    expect(f.konto).toEqual({
      offen: 6000,
      bezahltJahr: 5000,
      mahnstufe: 2,
      letzteZahlung: "2026-03-15",
    });
    expect(f.mails).toBe(3);
    const arten = f.verlauf.map((v: { art: string }) => v.art);
    expect(arten).toEqual(
      expect.arrayContaining([
        "angelegt",
        "gruppe_zugewiesen",
        "rechnung_versendet",
        "zahlung",
        "mahnung",
      ]),
    );
    expect(f.verlauf.find((v: { art: string }) => v.art === "gruppe_zugewiesen").detail).toBe(
      "Aktive",
    );
    // Neueste zuerst.
    const daten = f.verlauf.map((v: { datum: string }) => v.datum);
    expect(daten).toEqual([...daten].sort().reverse());
  });

  it("zeigt Gruppenwechsel im Verlauf und bleibt ohne Rechnungen leer", async () => {
    const env = await setup();
    const id = await mitglied(env, "Wechsler");
    const a = await gruppe(env, "Alt");
    const b = await gruppe(env, "Neu");
    await env.A("PUT", `/api/mitglieder/${id}/gruppe`, { gruppeId: a });
    env.clock.now = new Date("2026-11-05T10:00:00Z");
    await env.A("DELETE", `/api/mitglieder/${id}/gruppe`);
    env.clock.now = new Date("2026-11-06T10:00:00Z");
    await env.A("PUT", `/api/mitglieder/${id}/gruppe`, { gruppeId: b });
    const f = (await env.A("GET", `/api/mitglieder/${id}/finanzen`)).json();
    expect(f.rechnungen).toEqual([]);
    expect(f.konto).toEqual({ offen: 0, bezahltJahr: 0, mahnstufe: 0, letzteZahlung: null });
    expect(
      f.verlauf
        .filter((v: { art: string }) => v.art.startsWith("gruppe"))
        .map((v: { art: string; detail: string }) => `${v.art}:${v.detail}`),
    ).toEqual(["gruppe_zugewiesen:Neu", "gruppe_entfernt:Alt", "gruppe_zugewiesen:Alt"]);
  });

  it("gehört dem Mandanten, braucht Anmeldung und eine gültige ID", async () => {
    const env = await setup();
    const id = await mitglied(env, "Privat");
    expect((await env.B("GET", `/api/mitglieder/${id}/finanzen`)).status).toBe(404);
    expect((await env.call("GET", `/api/mitglieder/${id}/finanzen`)).status).toBe(401);
    expect((await env.A("GET", "/api/mitglieder/nope/finanzen")).status).toBe(400);
  });
});

describe("Duplikate und Zusammenführen bei Personen (#135)", () => {
  const pair = (a: string, b: string) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const merge = (env: Env, id: string, behaltenId: string, werte: object = {}) =>
    env.A("POST", `/api/duplikate/${id}/zusammenfuehren`, { behaltenId, werte });

  async function annaPaar(env: Env) {
    const ziel = await mitglied(env, "Meier", {
      vorname: "Anna",
      geburtsdatum: "1980-05-01",
      email: "anna@alt.example",
    });
    const quelle = await mitglied(env, "Meier", {
      vorname: "Anna",
      geburtsdatum: "1980-05-01",
      email: "anna@neu.example",
      telefon: "079 123 45 67",
      adresse,
    });
    await mitglied(env, "Anders", { vorname: "Ben" });
    return { ziel, quelle, id: pair(ziel, quelle) };
  }

  it("findet Personen mit gleichem Namen und Geburtsdatum, nicht den blossen Namen", async () => {
    const env = await setup();
    const { ziel, quelle, id } = await annaPaar(env);
    await mitglied(env, "Meier", {
      vorname: "Anna",
      geburtsdatum: "1999-01-01",
      email: "x@y.example",
    });
    const items = (await env.A("GET", "/api/duplikate")).json().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id,
      art: "person",
      status: "offen",
      trefferBei: ["name", "geburtsdatum"],
    });
    const seiten = Object.fromEntries([items[0].a, items[0].b].map((e) => [e.id, e]));
    expect(seiten[quelle]).toMatchObject({
      name: "Anna Meier",
      nr: expect.stringMatching(/^M-\d+$/),
      mitglieder: 0,
      rechnungen: 0,
      felder: {
        vorname: "Anna",
        nachname: "Meier",
        email: "anna@neu.example",
        telefon: "+41791234567",
        geburtsdatum: "1980-05-01",
        strasse: "Bahnhofstrasse 1",
        plzOrt: "8001 Zürich",
      },
    });
    expect(seiten[ziel].felder).not.toHaveProperty("telefon");
    expect((await env.A("GET", `/api/duplikate/${id}`)).json()).toMatchObject({
      id,
      art: "person",
    });
  });

  it("zählt Rechnungen je Person", async () => {
    const env = await setup();
    const { quelle, id } = await annaPaar(env);
    env.rechnungen.rows.set(`${KUNDE_A}:${quelle}`, { gesamt: 2, offen: 0 });
    const d = (await env.A("GET", `/api/duplikate/${id}`)).json();
    const seiten = Object.fromEntries([d.a, d.b].map((e) => [e.id, e]));
    expect(seiten[quelle].rechnungen).toBe(2);
  });

  it("«kein Duplikat» gilt je Mandant und bleibt in der Liste sichtbar; fremde Paare sind 404", async () => {
    const env = await setup();
    const { id } = await annaPaar(env);
    expect((await env.A("POST", `/api/duplikate/${id}/kein-duplikat`)).status).toBe(204);
    expect((await env.A("POST", `/api/duplikate/${id}/kein-duplikat`)).status).toBe(204);
    expect((await env.A("GET", "/api/duplikate")).json().items[0].status).toBe("kein_duplikat");
    expect((await env.B("POST", `/api/duplikate/${id}/kein-duplikat`)).status).toBe(404);
    expect((await env.B("GET", "/api/duplikate")).json().items).toHaveLength(0);
    expect((await env.B("GET", `/api/duplikate/${id}`)).status).toBe(404);
    expect((await env.call("GET", "/api/duplikate")).status).toBe(401);
  });

  it("führt zusammen: Wertwahl, Gruppe, Verlauf; die Quelle verschwindet aus den Listen und gibt die E-Mail frei", async () => {
    const env = await setup();
    const { ziel, quelle, id } = await annaPaar(env);
    const g = await gruppe(env, "Aktive");
    await env.A("PUT", `/api/mitglieder/${quelle}/gruppe`, { gruppeId: g });

    const res = await merge(env, id, ziel, { email: "entfernen" });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({
      id: ziel,
      status: "aktiv",
      email: "anna@neu.example", // gewählt: Wert der Quelle
      telefon: "+41791234567", // ergänzt: das Ziel hatte keinen
      adresse: { ort: "Zürich" },
      gruppeId: g, // von der Quelle übernommen
    });
    const alle = (await env.A("GET", "/api/mitglieder?status=alle")).json();
    expect(alle.items.map((m: { id: string }) => m.id)).not.toContain(quelle);
    expect((await env.A("GET", "/api/duplikate")).json().items).toHaveLength(0);
    const gruppen = (await env.A("GET", "/api/gruppen")).json().items;
    expect(gruppen[0].mitglieder).toBe(1);
    // Die zusammengeführte Person bleibt lesbar (für Belege), lässt sich aber nicht mehr ändern.
    expect((await env.A("GET", `/api/mitglieder/${quelle}`)).json().status).toBe(
      "zusammengefuehrt",
    );
    expect((await env.A("PATCH", `/api/mitglieder/${quelle}`, { notiz: "x" })).status).toBe(409);
    const verlauf = (await env.A("GET", `/api/mitglieder/${ziel}/finanzen`)).json().verlauf;
    expect(verlauf.map((v: { art: string }) => v.art)).toContain("zusammengefuehrt");
    // Ein zweites Mal geht nicht (die Quelle ist schon aufgegangen).
    expect((await merge(env, id, ziel)).status).toBe(409);
    // Die freigegebene E-Mail-Adresse ist wieder frei.
    const frei = await env.A(
      "POST",
      "/api/mitglieder",
      einzel("Frei", { email: "anna@alt.example" }),
    );
    expect(frei.status).toBe(201);
  });

  it("blockiert bei offenen Rechnungen der Quelle und bei verschiedenen Gruppen, ohne etwas zu ändern", async () => {
    const env = await setup();
    const { ziel, quelle, id } = await annaPaar(env);
    env.rechnungen.rows.set(`${KUNDE_A}:${quelle}`, { gesamt: 1, offen: 1 });
    const offen = await merge(env, id, ziel);
    expect(offen.status).toBe(409);
    expect(offen.body).toContain("offene Rechnungen");
    env.rechnungen.rows.clear();

    const a = await gruppe(env, "Alt");
    const b = await gruppe(env, "Neu");
    await env.A("PUT", `/api/mitglieder/${ziel}/gruppe`, { gruppeId: a });
    await env.A("PUT", `/api/mitglieder/${quelle}/gruppe`, { gruppeId: b });
    expect((await merge(env, id, ziel)).status).toBe(409);
    expect((await env.A("GET", `/api/mitglieder/${quelle}`)).json().status).toBe("aktiv");
    expect((await env.A("GET", `/api/mitglieder/${ziel}`)).json().gruppeId).toBe(a);

    // Bezahlte Rechnungen blockieren nicht.
    await env.A("DELETE", `/api/mitglieder/${quelle}/gruppe`);
    env.rechnungen.rows.set(`${KUNDE_A}:${quelle}`, { gesamt: 3, offen: 0 });
    expect((await merge(env, id, ziel)).status).toBe(200);
  });

  it("prüft das Paar: fremde Seite, fremder Mandant, archiviertes Ziel", async () => {
    const env = await setup();
    const { ziel, quelle, id } = await annaPaar(env);
    const dritte = await mitglied(env, "Meier", { vorname: "Anna", geburtsdatum: "1980-05-01" });
    expect((await merge(env, id, dritte)).status).toBe(400);
    expect(
      (
        await env.B("POST", `/api/duplikate/${id}/zusammenfuehren`, {
          behaltenId: ziel,
          werte: {},
        })
      ).status,
    ).toBe(404);
    await env.A("POST", "/api/mitglieder/sammelaktion", { ids: [ziel], aktion: "archivieren" });
    expect((await merge(env, id, ziel)).status).toBe(409);
    // Umgekehrt (archivierte Quelle, aktives Ziel) geht, weil die Person wieder eingetreten ist.
    expect((await merge(env, id, quelle)).status).toBe(200);
  });
});

describe("Firmen: erfasst von (#135)", () => {
  it("nennt den Benutzer, der die Firma angelegt hat; Selbstregistrierung hat keinen", async () => {
    const env = await setup();
    const id = await firma(env, "Huber AG");
    expect((await env.A("GET", `/api/firmen/${id}`)).json().erfasstVon).toBe(BENUTZER_NAME);
    expect((await env.A("GET", "/api/firmen")).json().items[0].erfasstVon).toBe(BENUTZER_NAME);

    const { formToken: ft } = (
      await env.call("GET", "/public/verein-a/registrierung/formular")
    ).json();
    env.clock.now = new Date(env.clock.now.getTime() + 10_000);
    await env.call("POST", "/public/verein-a/registrierung/firma", {
      body: { formToken: ft, firma: { name: "Selbst AG", email: "s@example.org", adresse } },
    });
    await env.call("POST", "/public/verein-a/registrierung/bestaetigen", {
      body: { token: env.mails.at(-1)?.token },
    });
    const selbst = (await env.A("GET", "/api/firmen?status=ausstehend")).json().items[0];
    expect(selbst).toMatchObject({ quelle: "selbst", erfasstVon: null });
  });

  it("zeigt Benutzer anderer Mandanten nie", async () => {
    const env = await setup();
    const b = await firma(env, "B AG", {}, "B");
    expect((await env.B("GET", `/api/firmen/${b}`)).json().erfasstVon).toBe("Bruno B");
    expect((await env.A("GET", `/api/firmen/${b}`)).status).toBe(404);
  });
});

describe("Referenz der Registrierung am Datensatz (#130)", () => {
  const person = (email: string, nachname = "Neu") => ({
    mitglied: { typ: "einzel", vorname: "Anna", nachname, email },
  });

  /** Registriert eine Person und bestätigt; gibt die Referenz zurück, die das Formular genannt hat. */
  async function registriert(env: Env, email: string, nachname?: string) {
    const res = await env.call("POST", "/public/verein-a/registrierung/person", {
      body: { ...person(email, nachname), formToken: await formToken(env) },
    });
    expect(res.status).toBe(202);
    const token = env.mails.at(-1)?.token as string;
    expect(
      (await env.call("POST", "/public/verein-a/registrierung/bestaetigen", { body: { token } }))
        .status,
    ).toBe(200);
    return res.json().referenz as string;
  }

  it("speichert dieselbe Referenz wie Formular und Mail am Mitglied und findet es damit in der Suche", async () => {
    const env = await setup();
    const referenz = await registriert(env, "neu@example.org", "Gesucht");
    await registriert(env, "andere@example.org", "Andere");
    const per = async (q: string, who: "A" | "B" = "A") =>
      (await env[who]("GET", `/api/mitglieder?status=alle&q=${encodeURIComponent(q)}`)).json()
        .items as {
        nachname: string;
        registrierungReferenz: string | null;
      }[];
    // Vollständig, klein geschrieben und ein Teil der Referenz.
    for (const q of [referenz, referenz.toLowerCase(), referenz.slice(0, 4)]) {
      expect(
        (await per(q)).map((m) => m.nachname),
        q,
      ).toContain("Gesucht");
    }
    expect(await per(referenz)).toMatchObject([
      { nachname: "Gesucht", registrierungReferenz: referenz },
    ]);
    // Ein anderer Mandant findet nichts.
    expect(await per(referenz, "B")).toHaveLength(0);
    // Von Hand erfasste Mitglieder tragen keine Referenz.
    await mitglied(env, "Manuell");
    const alle = (await env.A("GET", "/api/mitglieder")).json().items as {
      nachname: string;
      registrierungReferenz: string | null;
    }[];
    expect(alle.find((m) => m.nachname === "Manuell")?.registrierungReferenz).toBeNull();
  });

  it("speichert sie auch an der Firma und findet die Firma in der Suche", async () => {
    const env = await setup();
    await selbstRegistrierteFirma(env, "Referenz AG", "ref@example.org");
    const referenz = env.mails.at(-1)?.referenz as string;
    expect(referenz).toMatch(REFERENZ);
    const hits = (await env.A("GET", `/api/firmen?q=${encodeURIComponent(referenz)}`)).json().items;
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ name: "Referenz AG", registrierungReferenz: referenz });
    expect((await env.B("GET", `/api/firmen?q=${referenz}`)).json().items).toHaveLength(0);
    const manuell = await firma(env, "Manuell AG");
    expect((await env.A("GET", `/api/firmen/${manuell}`)).json().registrierungReferenz).toBeNull();
  });

  it("die Referenz ist je Mandant eindeutig: doppelt ergibt 409, in einem anderen Mandanten geht sie", async () => {
    const env = await setup();
    const service = new PeopleService(env.store);
    const input = (email: string) => ({
      typ: "einzel" as const,
      vorname: "A",
      nachname: "B",
      email,
    });
    await service.createMember(KUNDE_A, input("eins@example.org"), "ABCD-2345");
    await expect(
      service.createMember(KUNDE_A, input("zwei@example.org"), "ABCD-2345"),
    ).rejects.toMatchObject({ statusCode: 409 });
    // Auch über Mitglieder und Firmen hinweg prüft die Anwendung vor der Ausgabe.
    expect(await env.store.registrations.referenceUsed(KUNDE_A, "ABCD-2345")).toBe(true);
    expect(await env.store.registrations.referenceUsed(KUNDE_A, "ZZZZ-9999")).toBe(false);
    expect(await env.store.registrations.referenceUsed(KUNDE_B, "ABCD-2345")).toBe(false);
    await expect(
      service.createFirma(
        KUNDE_A,
        { name: "Firma", adresse: { ...adresse, land: "CH" } },
        "ausstehend",
        "EFGH-6789",
      ),
    ).resolves.toBeDefined();
    expect(await env.store.registrations.referenceUsed(KUNDE_A, "EFGH-6789")).toBe(true);
    await expect(
      service.createMember(KUNDE_B, input("drei@example.org"), "ABCD-2345"),
    ).resolves.toBeDefined();
  });

  it("gibt keine Referenz aus, die der Mandant schon vergeben hat", async () => {
    const env = await setup();
    const people = new PeopleService(env.store, () => env.clock.now);
    const tokens = ["erstes-token", "zweites-token"];
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const besetzt = referenceOf(sha("erstes-token"));
    await people.createMember(
      KUNDE_A,
      { typ: "einzel", vorname: "Alt", nachname: "Besitzer", email: "alt@example.org" },
      besetzt,
    );
    const gesendet: Mail[] = [];
    const reg = new RegistrationService(
      people,
      { send: async (m) => void gesendet.push(m) },
      {
        secret: Buffer.alloc(32, 7),
        minFillMs: 0,
        newToken: () => tokens.shift() ?? "weiteres-token",
      },
      () => env.clock.now,
    );
    const res = await reg.registerPerson(KUNDE_A, "verein-a", {
      formToken: reg.issueFormToken(KUNDE_A),
      mitglied: { typ: "einzel", vorname: "Neu", nachname: "Person", email: "neu@example.org" },
    } as never);
    expect(res.referenz).not.toBe(besetzt);
    expect(res.referenz).toBe(referenceOf(sha("zweites-token")));
    expect(gesendet[0]?.referenz).toBe(res.referenz);
    // Bestätigen legt das Mitglied mit genau dieser Referenz an.
    await reg.confirm(KUNDE_A, "verein-a", gesendet[0]?.token as string);
    expect(
      (await env.store.members.findByEmail(KUNDE_A, "neu@example.org"))?.registrierungReferenz,
    ).toBe(res.referenz);
  });
});
