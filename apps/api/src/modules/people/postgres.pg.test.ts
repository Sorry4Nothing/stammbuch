import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KUNDE_A, KUNDE_B, openTestDatabase } from "../../testing/postgres.js";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { importMembersCsv } from "./csv.js";
import type { Firma, Member } from "./domain.js";
import { PeopleService } from "./service.js";

// Integrationstests gegen echtes PostgreSQL (Container aus packages/db/test/global-setup.ts).
// Die Service-Suite people.test.ts läuft zusätzlich komplett gegen diesen Store.

let t: Awaited<ReturnType<typeof openTestDatabase>>;
const adresse = { strasse: "Bahnhofstrasse", hausnr: "1", plz: "8001", ort: "Zürich", land: "CH" };
const ctxA = { kundeId: KUNDE_A, benutzerId: "u1" };
const now = new Date("2026-11-04T10:00:00Z");

beforeAll(async () => {
  t = await openTestDatabase();
});
afterAll(async () => t.close());

const member = (kundeId: string, over: Partial<Member> = {}): Member => ({
  id: randomUUID(),
  kundeId,
  typ: "einzel",
  status: "aktiv",
  anrede: null,
  vorname: "Anna",
  nachname: "Muster",
  email: null,
  telefon: null,
  mobil: null,
  adresse: null,
  notiz: null,
  funktion: null,
  geburtsdatum: null,
  firmaId: null,
  gruppeId: null,
  erstelltAm: now,
  geaendertAm: now,
  ...over,
});

const firma = (kundeId: string, over: Partial<Firma> = {}): Firma => ({
  id: randomUUID(),
  kundeId,
  name: "Muster AG",
  uid: null,
  mwstNr: null,
  adresse,
  email: null,
  telefon: null,
  kontaktperson: null,
  status: "freigegeben",
  zusammengefuehrtMit: null,
  erstelltAm: now,
  ...over,
});

const count = async (table: string, where = "true") =>
  Number((await t.owner.query(`SELECT count(*) FROM ${table} WHERE ${where}`)).rows[0].count);

describe("Gruppe: höchstens eine pro Person (Datenbank-Constraint)", () => {
  it("die Datenbank lehnt eine zweite Mitgliedschaft ab, egal welcher Code schreibt", async () => {
    await t.reset();
    const m = member(KUNDE_A);
    await t.store.members.insert(m);
    const [g1, g2] = [randomUUID(), randomUUID()];
    await t.owner.query("INSERT INTO gruppe (kunde_id, id, name) VALUES ($1,$2,'Eins'),($1,$3,'Zwei')", [KUNDE_A, g1, g2]); // prettier-ignore
    const insert = (g: string) =>
      t.owner.query(
        "INSERT INTO gruppe_mitgliedschaft (kunde_id, mitglied_id, gruppe_id) VALUES ($1,$2,$3)",
        [KUNDE_A, m.id, g],
      );
    await insert(g1);
    await expect(insert(g2)).rejects.toMatchObject({
      code: "23505",
      constraint: "gruppe_mitgliedschaft_pkey",
    });
  });

  it("parallele Zuweisungen in verschiedene Gruppen: genau eine gewinnt, die anderen 409", async () => {
    await t.reset();
    const m = member(KUNDE_A);
    await t.store.members.insert(m);
    const gruppen = Array.from({ length: 12 }, (_, i) => ({
      kundeId: KUNDE_A,
      id: randomUUID(),
      name: `Gruppe ${i}`,
    }));
    for (const g of gruppen) await t.store.gruppen.insert(g);

    const results = await Promise.allSettled(
      gruppen.map((g) => t.store.gruppen.assign(KUNDE_A, m.id, g.id)),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const abgelehnt = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(abgelehnt).toHaveLength(11);
    for (const r of abgelehnt) expect(r.reason).toMatchObject({ statusCode: 409 });
    expect(await count("gruppe_mitgliedschaft")).toBe(1);
  });

  it("dieselbe Gruppe mehrfach (auch parallel) ist idempotent", async () => {
    await t.reset();
    const m = member(KUNDE_A);
    const g = { kundeId: KUNDE_A, id: randomUUID(), name: "Vorstand" };
    await t.store.members.insert(m);
    await t.store.gruppen.insert(g);
    await Promise.all(Array.from({ length: 6 }, () => t.store.gruppen.assign(KUNDE_A, m.id, g.id)));
    expect(await count("gruppe_mitgliedschaft")).toBe(1);
  });

  it("Auflösen der Gruppe entfernt die Mitgliedschaften, die Mitglieder bleiben", async () => {
    await t.reset();
    const m = member(KUNDE_A);
    const g = { kundeId: KUNDE_A, id: randomUUID(), name: "Vorstand" };
    await t.store.members.insert(m);
    await t.store.gruppen.insert(g);
    await t.store.gruppen.assign(KUNDE_A, m.id, g.id);
    expect(await t.store.gruppen.dissolve(KUNDE_A, g.id)).toBe(true);
    expect((await t.store.members.get(KUNDE_A, m.id))?.gruppeId).toBeNull();
    expect(await count("gruppe_mitgliedschaft")).toBe(0);
  });
});

describe("Mandantentrennung in der Datenbank", () => {
  it("ohne Mandant liefern alle Personen-Tabellen nichts", async () => {
    await t.reset();
    await t.store.members.insert(member(KUNDE_A));
    await t.store.firmen.insert(firma(KUNDE_A));
    await t.store.gruppen.insert({ kundeId: KUNDE_A, id: randomUUID(), name: "G" });
    for (const table of [
      "mitglied",
      "firma",
      "gruppe",
      "gruppe_mitgliedschaft",
      "registrierung_offen",
    ] as const) {
      // prettier-ignore
      expect(await t.db.kysely.selectFrom(table).selectAll().execute()).toEqual([]);
    }
  });

  it("Kunde B sieht nichts von A, auch nicht über die Store-Methoden mit der ID von A", async () => {
    await t.reset();
    const m = member(KUNDE_A, { email: "a@example.test" });
    const f = firma(KUNDE_A);
    const g = { kundeId: KUNDE_A, id: randomUUID(), name: "G" };
    await t.store.members.insert(m);
    await t.store.firmen.insert(f);
    await t.store.gruppen.insert(g);
    expect(await t.store.members.get(KUNDE_B, m.id)).toBeUndefined();
    expect(await t.store.members.findByEmail(KUNDE_B, "a@example.test")).toBeUndefined();
    expect((await t.store.members.list(KUNDE_B, { limit: 10, status: "aktiv" })).items).toEqual([]);
    expect(await t.store.firmen.get(KUNDE_B, f.id)).toBeUndefined();
    expect(await t.store.gruppen.get(KUNDE_B, g.id)).toBeUndefined();
    expect(await t.store.gruppen.rename(KUNDE_B, g.id, "X")).toBe(false);
    expect(await t.store.gruppen.dissolve(KUNDE_B, g.id)).toBe(false);
    await expect(t.store.members.save({ ...m, kundeId: KUNDE_B })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("RLS verhindert Schreiben in fremde Kunden, Fremdschlüssel verhindern fremde Verweise", async () => {
    await t.reset();
    const fB = firma(KUNDE_B);
    await t.store.firmen.insert(fB);
    // Mandant A legt eine Zeile mit kunde_id von B an: von der Richtlinie abgelehnt.
    await expect(
      t.db.withKunde(KUNDE_A, (trx) =>
        trx.insertInto("gruppe").values({ kunde_id: KUNDE_B, name: "Fremd" }).execute(),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // Mitglied von A mit Firma von B: der zusammengesetzte Fremdschlüssel (kunde_id, firma_id) greift.
    await expect(
      t.store.members.insert(
        member(KUNDE_A, { typ: "firma", firmaId: fB.id, nachname: "Verirrt" }),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    // Zuweisung über Mandantengrenzen: Mitglied von A, Gruppe von B.
    const mA = member(KUNDE_A);
    const gB = { kundeId: KUNDE_B, id: randomUUID(), name: "G" };
    await t.store.members.insert(mA);
    await t.store.gruppen.insert(gB);
    await expect(t.store.gruppen.assign(KUNDE_A, mA.id, gB.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(t.store.gruppen.assign(KUNDE_B, mA.id, gB.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(await count("gruppe_mitgliedschaft")).toBe(0);
  });

  it("die App-Rolle kann die Kennung eines Kunden nicht ändern", async () => {
    await expect(
      t.db.withKunde(KUNDE_A, (trx) =>
        trx.updateTable("kunde").set({ slug: "uebernommen" }).execute(),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("Geburtsdatum und Kontaktperson", () => {
  it("werden als Kalendertag bzw. Text gespeichert und gelesen, Kunde B sieht sie nicht", async () => {
    const m = member(KUNDE_A, { geburtsdatum: "1985-03-07" });
    const f = firma(KUNDE_A, { kontaktperson: "Eva Muster" });
    await t.store.members.insert(m);
    await t.store.firmen.insert(f);
    expect((await t.store.members.get(KUNDE_A, m.id))?.geburtsdatum).toBe("1985-03-07");
    expect((await t.store.firmen.get(KUNDE_A, f.id))?.kontaktperson).toBe("Eva Muster");
    expect(await t.store.members.get(KUNDE_B, m.id)).toBeUndefined();
    expect(await t.store.firmen.get(KUNDE_B, f.id)).toBeUndefined();
  });

  it("die Datenbank lehnt ein Geburtsdatum vor 1900 und eine leere Kontaktperson ab", async () => {
    await expect(
      t.store.members.insert(member(KUNDE_A, { geburtsdatum: "1899-12-31" })),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      t.store.firmen.insert(firma(KUNDE_A, { kontaktperson: "" })),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("Constraints als AppError(409)", () => {
  it("doppelte E-Mail im Mandanten, nicht mandantenübergreifend; auch parallel", async () => {
    await t.reset();
    const email = "doppelt@example.test";
    await t.store.members.insert(member(KUNDE_A, { email }));
    await expect(t.store.members.insert(member(KUNDE_A, { email }))).rejects.toMatchObject({
      statusCode: 409,
    });
    await t.store.members.insert(member(KUNDE_B, { email })); // anderer Mandant: erlaubt

    const parallel = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        t.store.members.insert(member(KUNDE_A, { email: "rennen@example.test" })),
      ),
    );
    expect(parallel.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of parallel.filter((r) => r.status === "rejected")) {
      expect(r.reason).toMatchObject({ statusCode: 409 });
    }
  });

  it("doppelter Gruppenname (ohne Gross-/Kleinschreibung und Akzente) und doppelte UID", async () => {
    await t.reset();
    await t.store.gruppen.insert({ kundeId: KUNDE_A, id: randomUUID(), name: "Vorstand Zürich" });
    await expect(
      t.store.gruppen.insert({ kundeId: KUNDE_A, id: randomUUID(), name: "VORSTAND zurich" }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const uid = "CHE-123.456.788";
    await t.store.firmen.insert(firma(KUNDE_A, { uid }));
    await expect(
      t.store.firmen.insert(firma(KUNDE_A, { uid, name: "Zweite" })),
    ).rejects.toMatchObject({
      statusCode: 409,
    });
    // Abgelehnte Firmen blockieren die UID nicht.
    await t.store.firmen.insert(firma(KUNDE_A, { uid, name: "Abgelehnt", status: "abgelehnt" }));
  });
});

describe("Atomarität", () => {
  it("Import: schlägt die Transaktion fehl, bleibt der Bestand unverändert", async () => {
    await t.reset();
    const people = new PeopleService(t.store);
    await t.store.members.insert(member(KUNDE_A, { vorname: "Alt", email: "alt@example.test" }));

    // Zwischen Prüfung und Schreiben vergibt jemand anderes eine E-Mail: hier direkt im Store.
    const neu = [
      member(KUNDE_A, { vorname: "Eins", email: "eins@example.test" }),
      member(KUNDE_A, { vorname: "Zwei", email: "zwei@example.test" }),
      member(KUNDE_A, { vorname: "Drei", email: "alt@example.test" }),
    ];
    await expect(t.store.members.insertMany(KUNDE_A, neu)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await count("mitglied")).toBe(1);

    // Über den Import-Weg: CSV ohne Fehler, aber die letzte Adresse wird zwischen Trockenlauf und
    // Schreiben vergeben. Simuliert durch einen Store, der nach der Prüfung eine Zeile einfügt.
    const csv =
      "Vorname;Nachname;E-Mail\nA;A;a1@example.test\nB;B;b2@example.test\nC;C;c3@example.test";
    const racing = new PeopleService({
      ...t.store,
      members: {
        ...t.store.members,
        insertMany: async (kundeId, list) => {
          await t.store.members.insert(member(KUNDE_A, { email: "c3@example.test" }));
          return t.store.members.insertMany(kundeId, list);
        },
      },
    });
    await expect(importMembersCsv(racing, ctxA, csv, false)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await count("mitglied")).toBe(2); // Alt + der Störer, nichts vom Import

    const ok = await importMembersCsv(people, ctxA, csv.replace("c3@", "c4@"), false);
    expect(ok).toMatchObject({ importiert: 3, fehler: [] });
    expect(await count("mitglied")).toBe(5);
  });

  it("Zusammenführen: Fehler im letzten Schritt rollt Mitglieder und Quelle zurück", async () => {
    await t.reset();
    const ziel = firma(KUNDE_A, { name: "Ziel AG" });
    const quelle = firma(KUNDE_A, { name: "Quelle AG", uid: "CHE-123.456.788" });
    await t.store.firmen.insert(ziel);
    await t.store.firmen.insert(quelle);
    const m = member(KUNDE_A, { typ: "firma", firmaId: quelle.id });
    await t.store.members.insert(m);

    // Ziel mit ungültiger UID: scheitert am CHECK, nachdem Quelle und Mitglieder schon geändert sind.
    await expect(
      t.store.firmen.merge(KUNDE_A, { ...ziel, uid: "kaputt" }, quelle.id, now),
    ).rejects.toMatchObject({ code: "23514" });
    expect((await t.store.firmen.get(KUNDE_A, quelle.id))?.status).toBe("freigegeben");
    expect((await t.store.members.get(KUNDE_A, m.id))?.firmaId).toBe(quelle.id);

    // Erfolgsfall: die UID wandert zum Ziel, obwohl sie vorher bei der Quelle unique war.
    await t.store.firmen.merge(KUNDE_A, { ...ziel, uid: quelle.uid }, quelle.id, now);
    expect((await t.store.firmen.get(KUNDE_A, quelle.id))?.status).toBe("zusammengefuehrt");
    expect((await t.store.firmen.get(KUNDE_A, ziel.id))?.uid).toBe("CHE-123.456.788");
    expect((await t.store.members.get(KUNDE_A, m.id))?.firmaId).toBe(ziel.id);
  });

  it("gleichzeitiges Zusammenführen in beide Richtungen: eine gewinnt, kein Deadlock", async () => {
    await t.reset();
    const a = firma(KUNDE_A, { name: "A AG" });
    const b = firma(KUNDE_A, { name: "B AG" });
    await t.store.firmen.insert(a);
    await t.store.firmen.insert(b);
    const r = await Promise.allSettled([
      t.store.firmen.merge(KUNDE_A, a, b.id, now),
      t.store.firmen.merge(KUNDE_A, b, a.id, now),
    ]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await count("firma", "status = 'zusammengefuehrt'")).toBe(1);
  });
});

describe("Registrierungen (Double-Opt-in)", () => {
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  const reg = (token: string, ablaufAm: Date, kundeId = KUNDE_A) => ({
    tokenHash: hash(token),
    kundeId,
    art: "person" as const,
    daten: { vorname: "Anna", nachname: "Muster", email: "anna@example.test" },
    ablaufAm,
  });

  it("löst Mandant und Daten über den Token-Hash auf, genau einmal, auch parallel", async () => {
    await t.reset();
    const in1h = new Date(Date.now() + 3_600_000);
    await t.store.registrations.put(reg("token-1", in1h, KUNDE_B));
    const [x, y] = await Promise.all([
      t.store.registrations.take(hash("token-1")),
      t.store.registrations.take(hash("token-1")),
    ]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    expect(x ?? y).toMatchObject({ kundeId: KUNDE_B, art: "person" });
    expect((x ?? y)?.daten).toEqual(reg("x", in1h).daten);
    expect(await t.store.registrations.take(hash("unbekannt"))).toBeUndefined();
  });

  it("speichert nur den Hash und räumt abgelaufene Einträge des Kunden beim Anlegen auf", async () => {
    await t.reset();
    await t.store.registrations.put(reg("alt", new Date(Date.now() - 1000)));
    await t.store.registrations.put(reg("neu", new Date(Date.now() + 3_600_000)));
    const { rows } = await t.owner.query("SELECT token_hash FROM registrierung_offen");
    expect(rows).toEqual([{ token_hash: hash("neu") }]);
  });

  it("die App-Rolle liest fremde Einträge nicht, nur die Funktion löst per Token auf", async () => {
    await t.reset();
    await t.store.registrations.put(reg("geheim", new Date(Date.now() + 3_600_000), KUNDE_B));
    expect(
      await t.db.withKunde(KUNDE_A, (trx) =>
        trx.selectFrom("registrierung_offen").selectAll().execute(),
      ),
    ).toEqual([]);
  });

  it("Mandantenkennung wird über eine schmale Funktion aufgelöst", async () => {
    expect(await t.resolveTenant("verein-a")).toBe(KUNDE_A);
    expect(await t.resolveTenant("verein-b")).toBe(KUNDE_B);
    expect(await t.resolveTenant("gibt-es-nicht")).toBeUndefined();
    expect(await t.resolveTenant("' OR '1'='1")).toBeUndefined();
  });
});

describe("Grosse Mengen: Cursor-Paginierung und Suche in SQL", () => {
  const N = 100_000;

  beforeAll(async () => {
    await t.reset();
    const f = firma(KUNDE_A, { name: "Grossfirma AG" });
    await t.store.firmen.insert(f);
    // Als Eigentümer in einem Statement (inkl. Trigger für den Suchtext).
    await t.owner.query(
      `INSERT INTO mitglied (kunde_id, id, typ, vorname, nachname, email, ort, plz, strasse, land, firma_id)
       SELECT $1, uuidv7(), CASE WHEN i % 10 = 0 THEN 'firma' ELSE 'einzel' END, 'Vorname' || (i % 500),
              'Nachname' || lpad((i % 20000)::text, 5, '0'), 'person' || i || '@example.test',
              'Ort' || (i % 300), '8000', 'Weg', 'CH', CASE WHEN i % 10 = 0 THEN $2::uuid END
       FROM generate_series(1, $3) i`,
      [KUNDE_A, f.id, N],
    );
    await t.owner.query("ANALYZE mitglied");
  }, 300_000);

  const timed = async <T>(fn: () => Promise<T>) => {
    const start = performance.now();
    const value = await fn();
    return { value, ms: performance.now() - start };
  };

  it("blättert mit Cursor lückenlos und ohne Doppelte, tiefe Seiten sind nicht langsamer", async () => {
    const seen = new Set<string>();
    let last = "";
    let after: string | undefined;
    let slowest = 0;
    for (let i = 0; i < 100; i++) {
      const { value: page, ms } = await timed(() =>
        t.store.members.list(KUNDE_A, { limit: 200, status: "aktiv", after }),
      );
      slowest = Math.max(slowest, ms);
      for (const m of page.items) {
        expect(seen.has(m.id)).toBe(false);
        seen.add(m.id);
        const key = `${m.nachname}|${m.vorname}`;
        expect(key >= last).toBe(true);
        last = key;
      }
      after = page.next ?? undefined;
      if (!after) break;
    }
    expect(seen.size).toBe(20_000);
    expect(slowest).toBeLessThan(1_000);
  }, 120_000);

  it("Seite 400 von 500 (Cursor tief in der Liste) kommt schnell", async () => {
    // Cursor direkt aus einer Zeile mitten in der Liste bauen.
    const { rows } = await t.owner.query(
      "SELECT nachname_sort, vorname_sort, id FROM mitglied ORDER BY 1, 2, 3 OFFSET 80000 LIMIT 1",
    );
    const after = `${rows[0].nachname_sort}\u0001${rows[0].vorname_sort}\u0001${rows[0].id}`;
    const { value, ms } = await timed(() =>
      t.store.members.list(KUNDE_A, { limit: 50, status: "aktiv", after }),
    );
    expect(value.items).toHaveLength(50);
    expect(ms).toBeLessThan(500);
  });

  it("Suche (Teilstring, ohne Akzente) über 100'000 Mitglieder in unter einer Sekunde", async () => {
    const treffer = await timed(() =>
      t.store.members.list(KUNDE_A, { limit: 50, status: "aktiv", q: "person99999@EXAMPLE" }),
    );
    expect(treffer.value.items.map((m) => m.email)).toEqual(["person99999@example.test"]);
    expect(treffer.ms).toBeLessThan(1_000);

    const mehrere = await timed(() =>
      t.store.members.list(KUNDE_A, { limit: 50, status: "aktiv", q: "nachname00042 ort42" }),
    );
    expect(mehrere.value.items.length).toBeGreaterThan(0);
    expect(mehrere.ms).toBeLessThan(1_000);

    // Der Firmenname steckt im Suchtext der Firmenmitglieder.
    const ueberFirma = await timed(() =>
      t.store.members.list(KUNDE_A, { limit: 200, status: "aktiv", q: "grossfirma", typ: "firma" }),
    );
    expect(ueberFirma.value.items).toHaveLength(200);
    expect(ueberFirma.ms).toBeLessThan(1_000);
  });

  it("Umbenennen der Firma zieht den Suchtext der Mitglieder nach", async () => {
    const small = member(KUNDE_A, { vorname: "Zora", nachname: "Zzz" });
    const f = firma(KUNDE_A, { name: "Alpha Bau AG" });
    await t.store.firmen.insert(f);
    await t.store.members.insert({ ...small, typ: "firma", firmaId: f.id });
    const finde = (q: string) =>
      t.store.members.list(KUNDE_A, { limit: 10, status: "aktiv", q }).then((p) => p.items);
    expect(await finde("alpha bau")).toHaveLength(1);
    await t.store.firmen.save({ ...f, name: "Omega Hoch AG" });
    expect(await finde("alpha bau")).toHaveLength(0);
    expect(await finde("omega")).toHaveLength(1);
  });

  it("Pläne: Sortierung und Suche nutzen die Indizes", async () => {
    const plan = async (query: string) =>
      (await t.owner.query(`EXPLAIN ${query}`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
    const sortiert = await plan(
      `SELECT * FROM mitglied WHERE kunde_id = '${KUNDE_A}' AND status = 'aktiv'
       ORDER BY nachname_sort, vorname_sort, id LIMIT 51`,
    );
    expect(sortiert).toContain("mitglied_sortierung");
    expect(sortiert).not.toMatch(/Sort\b/);
    const suche = await plan(
      `SELECT * FROM mitglied WHERE kunde_id = '${KUNDE_A}' AND suchtext LIKE '%person99999%'`,
    );
    expect(suche).toContain("mitglied_suche");
  });
});

describe("Verdrahtung in der App (DATABASE_URL)", () => {
  const secret = Buffer.alloc(32, 1).toString("base64");

  it("die App läuft auf PostgreSQL: geschützt ohne Anmeldung, öffentlich nur mit bekanntem Mandanten", async () => {
    const app = await buildApp(
      loadConfig({ LOG_LEVEL: "silent", DATABASE_URL: t.appUrl, FORM_SECRET: secret }),
    );
    try {
      expect((await app.inject({ method: "GET", url: "/api/mitglieder" })).statusCode).toBe(401);
      const bekannt = await app.inject({
        method: "GET",
        url: "/public/verein-a/registrierung/formular",
      });
      expect(bekannt.statusCode).toBe(200);
      expect(bekannt.json().formToken).toMatch(/^\d+\./);
      const unbekannt = await app.inject({
        method: "GET",
        url: "/public/unbekannt/registrierung/formular",
      });
      expect(unbekannt.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("fail closed: DATABASE_URL ohne ausreichendes FORM_SECRET bricht den Start ab", () => {
    const env = { DATABASE_URL: t.appUrl };
    expect(() => loadConfig(env)).toThrow();
    expect(() => loadConfig({ ...env, FORM_SECRET: "zu-kurz" })).toThrow();
    expect(loadConfig({ ...env, FORM_SECRET: secret }).FORM_SECRET).toHaveLength(32);
  });
});
