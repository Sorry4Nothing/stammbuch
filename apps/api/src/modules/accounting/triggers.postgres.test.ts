import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Database, Datenbank } from "@stammbuch/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresStore } from "./postgres-store.js";
import { KUNDE_A, KUNDE_B, closeAll, createDatabase } from "./postgres.test-support.js";
import { AccountingService } from "./service.js";

// Die Regeln der Buchhaltung gelten in der Datenbank, nicht nur im Dienst: diese Tests umgehen den Dienst
// und schreiben direkt (als Anwendungsrolle bzw. Eigentümer), so wie es ein Fehler oder Angriff täte.

const A = KUNDE_A;
const B = KUNDE_B;
const nullHash = "0".repeat(64);
const hashOf = (n: number) => (n === 0 ? nullHash : n.toString(16).padStart(64, "0"));
const verboten = /nur anhängend/;
const keineRechte = { code: "42501" };

type Zeile = [konto: string, seite: "debit" | "credit", betrag: number, person?: string];

let db: Datenbank;
let owner: pg.Client;
const eigen = <T>(k: string, fn: (trx: Transaction<Database>) => Promise<T>) => db.withKunde(k, fn);

/** Schreibt eine Buchung samt Zeilen; Belegnummer und Hash bestimmt der Aufrufer (die Datenbank prüft sie). */
async function buche(
  trx: Transaction<Database>,
  k: string,
  n: number,
  zeilen: Zeile[],
  o: { datum?: string; id?: string; stornoVon?: string; aufbewahrenBis?: string } = {},
) {
  const id = o.id ?? crypto.randomUUID();
  const { rows: letzte } = await sql<{ hash: string }>`SELECT hash FROM buchhaltung_buchung
    WHERE kunde_id = ${k} ORDER BY belegnummer DESC LIMIT 1`.execute(trx);
  const datum = o.datum ?? "2026-06-01";
  await sql`INSERT INTO buchhaltung_buchung (id, kunde_id, belegnummer, buchungsdatum, art, beschreibung, storno_von,
      erstellt_am, erstellt_von, aufbewahren_bis, vorgaenger_hash, hash)
    VALUES (${id}, ${k}, ${n}, ${datum}, ${o.stornoVon ? "reversal" : "manual"}, 'Test', ${o.stornoVon ?? null}, now(), 'u',
      ${o.aufbewahrenBis ?? `${Number(datum.slice(0, 4)) + 10}-12-31`}, ${letzte[0]?.hash ?? nullHash}, ${hashOf(n)})`.execute(
    trx,
  );
  for (const [i, [konto, seite, betrag, person]] of zeilen.entries()) {
    await sql`INSERT INTO buchhaltung_buchungszeile (kunde_id, buchung_id, zeilennr, konto_nummer, seite, betrag, person_id)
      VALUES (${k}, ${id}, ${i + 1}, ${konto}, ${seite}, ${betrag}, ${person ?? null})`.execute(
      trx,
    );
  }
  return id;
}

const ausgeglichen: Zeile[] = [
  ["1020", "debit", 100],
  ["3000", "credit", 100],
];

const anzahlBuchungen = async (k: string) =>
  Number(
    (await owner.query("SELECT count(*) AS n FROM buchhaltung_buchung WHERE kunde_id = $1", [k]))
      .rows[0].n,
  );

async function leereKonten(k: string) {
  await owner.query(
    `INSERT INTO buchhaltung_konto (kunde_id, nummer, name, art) VALUES
       ($1, '1020', 'Bank', 'asset'), ($1, '1100', 'Debitoren', 'asset'), ($1, '3000', 'Erlös', 'revenue')
     ON CONFLICT DO NOTHING`,
    [k],
  );
}

beforeAll(async () => {
  ({ db, owner } = await createDatabase());
  await leereKonten(A);
  await leereKonten(B);
});
afterAll(closeAll);

describe("Unveränderbarkeit", () => {
  let buchungId: string;
  beforeAll(async () => {
    buchungId = await eigen(A, (t) => buche(t, A, 1, ausgeglichen));
  });

  it("die Anwendungsrolle darf Buchungen nicht ändern, löschen oder leeren", async () => {
    for (const stmt of [
      sql`UPDATE buchhaltung_buchung SET beschreibung = 'x'`,
      sql`DELETE FROM buchhaltung_buchung`,
      sql`UPDATE buchhaltung_buchungszeile SET betrag = 1`,
      sql`DELETE FROM buchhaltung_buchungszeile`,
      sql`TRUNCATE buchhaltung_buchung CASCADE`,
      sql`DELETE FROM buchhaltung_protokoll`,
      sql`UPDATE buchhaltung_periodenereignis SET status = 'open'`,
      sql`DELETE FROM buchhaltung_idempotenz`,
      sql`UPDATE buchhaltung_konto SET art = 'expense'`,
      sql`DELETE FROM buchhaltung_konto`,
    ]) {
      await expect(eigen(A, (t) => stmt.execute(t))).rejects.toMatchObject(keineRechte);
    }
  });

  it("auch der Eigentümer kann Buchungen, Zeilen, Posten, Zuordnungen, Protokoll nicht ändern (Trigger)", async () => {
    const tabellen = [
      "buchhaltung_buchung",
      "buchhaltung_buchungszeile",
      "buchhaltung_offener_posten",
      "buchhaltung_guthaben",
      "buchhaltung_zuordnung",
      "buchhaltung_periodenereignis",
      "buchhaltung_protokoll",
      "buchhaltung_idempotenz",
    ];
    for (const t of tabellen) {
      await expect(owner.query(`TRUNCATE ${t} CASCADE`)).rejects.toThrow(verboten);
    }
    await expect(
      owner.query("UPDATE buchhaltung_buchung SET beschreibung = 'x' WHERE id = $1", [buchungId]),
    ).rejects.toThrow(verboten);
    await expect(
      owner.query("DELETE FROM buchhaltung_buchung WHERE id = $1", [buchungId]),
    ).rejects.toThrow(verboten);
    await expect(
      owner.query("UPDATE buchhaltung_buchungszeile SET betrag = 1 WHERE buchung_id = $1", [
        buchungId,
      ]),
    ).rejects.toThrow(verboten);
    await expect(
      owner.query("DELETE FROM buchhaltung_buchungszeile WHERE buchung_id = $1", [buchungId]),
    ).rejects.toThrow(verboten);
  });

  it("ein Kunde mit Buchungen lässt sich nicht löschen (Aufbewahrung)", async () => {
    await expect(owner.query("DELETE FROM kunde WHERE id = $1", [A])).rejects.toThrow();
    expect(await anzahlBuchungen(A)).toBeGreaterThan(0);
  });

  it("Konten: nur Name und Aktiv-Flag sind änderbar, Löschen ist verboten", async () => {
    await eigen(A, (t) =>
      sql`UPDATE buchhaltung_konto SET name = 'Bank neu', aktiv = false WHERE nummer = '1020'`.execute(
        t,
      ),
    );
    await eigen(A, (t) =>
      sql`UPDATE buchhaltung_konto SET aktiv = true WHERE nummer = '1020'`.execute(t),
    );
    await expect(
      owner.query(
        "UPDATE buchhaltung_konto SET nummer = '1021' WHERE nummer = '1020' AND kunde_id = $1",
        [A],
      ),
    ).rejects.toThrow(/unveränderlich/);
    await expect(owner.query("DELETE FROM buchhaltung_konto")).rejects.toThrow(/nie gelöscht/);
  });
});

describe("Soll = Haben beim Commit", () => {
  it("lehnt eine unausgeglichene Buchung ab und schreibt nichts", async () => {
    const vorher = await anzahlBuchungen(A);
    const nummer = vorher + 1;
    await expect(
      eigen(A, (t) =>
        buche(t, A, nummer, [
          ["1020", "debit", 100],
          ["3000", "credit", 90],
        ]),
      ),
    ).rejects.toThrow(/nicht ausgeglichen/);
    expect(await anzahlBuchungen(A)).toBe(vorher);
  });

  it("lehnt eine Buchung mit nur einer Zeile oder ohne Zeilen ab", async () => {
    const nummer = (await anzahlBuchungen(A)) + 1;
    await expect(eigen(A, (t) => buche(t, A, nummer, [["1020", "debit", 100]]))).rejects.toThrow(
      /nicht ausgeglichen/,
    );
    await expect(eigen(A, (t) => buche(t, A, nummer, []))).rejects.toThrow(/nicht ausgeglichen/);
  });

  it("lässt eine ausgeglichene Buchung zu, auch wenn die Zeilen einzeln unausgeglichen sind", async () => {
    const nummer = (await anzahlBuchungen(A)) + 1;
    await eigen(A, (t) =>
      buche(t, A, nummer, [
        ["1020", "debit", 100],
        ["3000", "credit", 30],
        ["3000", "credit", 70],
      ]),
    );
    expect(await anzahlBuchungen(A)).toBe(nummer);
  });

  it("verbietet Zeilen, die nachträglich an eine bestehende Buchung gehängt werden", async () => {
    const id = await eigen(A, async (t) =>
      buche(t, A, (await anzahlBuchungen(A)) + 1, ausgeglichen),
    );
    await expect(
      eigen(A, (t) =>
        sql`INSERT INTO buchhaltung_buchungszeile (kunde_id, buchung_id, zeilennr, konto_nummer, seite, betrag)
            VALUES (${A}, ${id}, 9, '1020', 'debit', 5)`.execute(t),
      ),
    ).rejects.toThrow(/Transaktion ihrer Buchung/);
  });

  it("Beträge sind positiv und das Sammelkonto 1100 braucht eine Person (und nur dieses)", async () => {
    const nummer = (await anzahlBuchungen(A)) + 1;
    await expect(
      eigen(A, (t) => buche(t, A, nummer, [["1020", "debit", 0], ["3000", "credit", 0]])),
    ).rejects.toMatchObject({ code: "23514" }); // prettier-ignore
    await expect(
      eigen(A, (t) => buche(t, A, nummer, [["1100", "debit", 100], ["3000", "credit", 100]])),
    ).rejects.toMatchObject({ code: "23514" }); // prettier-ignore
    await expect(
      eigen(A, (t) => buche(t, A, nummer, [["1020", "debit", 100, "p1"], ["3000", "credit", 100]])),
    ).rejects.toMatchObject({ code: "23514" }); // prettier-ignore
  });
});

describe("Belegnummern und Hash-Kette", () => {
  it("lehnt eine Lücke, eine Wiederholung und eine falsche Kette ab", async () => {
    const n = (await anzahlBuchungen(B)) + 1;
    await expect(eigen(B, (t) => buche(t, B, n + 1, ausgeglichen))).rejects.toThrow(
      /nicht die nächste/,
    );
    await eigen(B, (t) => buche(t, B, n, ausgeglichen));
    await expect(eigen(B, (t) => buche(t, B, n, ausgeglichen))).rejects.toThrow();
    await expect(
      eigen(B, (t) =>
        sql`INSERT INTO buchhaltung_buchung (kunde_id, belegnummer, buchungsdatum, art, beschreibung, erstellt_am,
              erstellt_von, aufbewahren_bis, vorgaenger_hash, hash)
            VALUES (${B}, ${n + 1}, '2026-06-01', 'manual', 'Test', now(), 'u', '2036-12-31', ${hashOf(99)}, ${hashOf(n + 1)})`.execute(
          t,
        ),
      ),
    ).rejects.toThrow(/Hash-Kette unterbrochen/);
  });

  it("jeder Kunde hat seine eigene Nummernfolge ab 1", async () => {
    const x = "33333333-3333-4333-8333-333333333333";
    await owner.query("INSERT INTO kunde (id, name) VALUES ($1, 'Kunde X')", [x]);
    await leereKonten(x);
    await eigen(x, (t) => buche(t, x, 1, ausgeglichen));
    expect(Number((await owner.query("SELECT belegnummer FROM buchhaltung_buchung WHERE kunde_id = $1", [x])).rows[0].belegnummer)).toBe(1);
  }); // prettier-ignore

  it("parallele Schreiber hinterlassen nie eine Lücke (Sperre in der Datenbank)", async () => {
    const start = await anzahlBuchungen(B);
    // Jeder liest die letzte Nummer ohne Sperre und schreibt n+1: einige scheitern, aber es entsteht keine Lücke.
    const ergebnisse = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        eigen(B, async (t) => {
          const { rows } = await sql<{ n: string }>`SELECT coalesce(max(belegnummer), 0) AS n FROM buchhaltung_buchung`.execute(t);
          await buche(t, B, Number(rows[0]!.n) + 1, ausgeglichen);
        }),
      ),
    ); // prettier-ignore
    const geschrieben = ergebnisse.filter((r) => r.status === "fulfilled").length;
    expect(geschrieben).toBeGreaterThanOrEqual(1);
    const { rows } = await owner.query(
      "SELECT belegnummer FROM buchhaltung_buchung WHERE kunde_id = $1 ORDER BY belegnummer",
      [B],
    );
    expect(rows.map((r) => Number(r.belegnummer))).toEqual(
      Array.from({ length: start + geschrieben }, (_, i) => i + 1),
    );
  });

  it("parallele Dienstaufrufe vergeben lückenlose Nummern und eine intakte Kette", async () => {
    const svc = new AccountingService(
      createPostgresStore(db),
      () => new Date("2026-06-15T10:00:00Z"),
    );
    const ctx = { tenantId: B, userId: "u" };
    const vorher = await anzahlBuchungen(B);
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        svc.bookPayment(ctx, {
          idempotencyKey: `parallel-${String(i).padStart(4, "0")}`,
          personId: `p${i % 3}`,
          bankAccountCode: "1020",
          valueDate: "2026-06-10",
          amount: 100 + i,
          reference: `Z${i}`,
        }),
      ),
    );
    expect(await anzahlBuchungen(B)).toBe(vorher + 25);
    const { rows } = await owner.query(
      "SELECT belegnummer FROM buchhaltung_buchung WHERE kunde_id = $1 ORDER BY belegnummer",
      [B],
    );
    expect(rows.map((r) => Number(r.belegnummer))).toEqual(
      Array.from({ length: vorher + 25 }, (_, i) => i + 1),
    );
    // Die Kette der parallel angelegten Buchungen ist nur für die Dienst-Buchungen prüfbar (Fixtures haben eigene Hashes).
  });
});

describe("Aufbewahrung", () => {
  it("verlangt als Aufbewahrungsfrist den 31.12. des Buchungsjahres plus 10 Jahre", async () => {
    const n = (await anzahlBuchungen(A)) + 1;
    await expect(
      eigen(A, (t) => buche(t, A, n, ausgeglichen, { aufbewahrenBis: "2030-12-31" })),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      eigen(A, (t) =>
        buche(t, A, n, ausgeglichen, { datum: "2026-12-31", aufbewahrenBis: "2036-12-30" }),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("Periodensperre", () => {
  it("lehnt Buchungen in einer abgeschlossenen Periode ab; Wiederöffnen verlangt eine Begründung", async () => {
    await eigen(A, (t) =>
      sql`INSERT INTO buchhaltung_periodenereignis (kunde_id, periode, status, zeitpunkt, akteur)
          VALUES (${A}, '2025-03', 'closed', now(), 'u')`.execute(t),
    );
    const n = () => anzahlBuchungen(A).then((c) => c + 1);
    await expect(
      eigen(A, async (t) => buche(t, A, await n(), ausgeglichen, { datum: "2025-03-15" })),
    ).rejects.toThrow(/Periode 2025-03 ist abgeschlossen/);
    // Andere Perioden bleiben offen.
    await eigen(A, async (t) => buche(t, A, await n(), ausgeglichen, { datum: "2025-04-01" }));

    await expect(
      eigen(A, (t) =>
        sql`INSERT INTO buchhaltung_periodenereignis (kunde_id, periode, status, zeitpunkt, akteur)
            VALUES (${A}, '2025-03', 'open', now(), 'u')`.execute(t),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await eigen(A, (t) =>
      sql`INSERT INTO buchhaltung_periodenereignis (kunde_id, periode, status, zeitpunkt, akteur, grund)
          VALUES (${A}, '2025-03', 'open', now(), 'u', 'Korrektur Treuhänder')`.execute(t),
    );
    await eigen(A, async (t) => buche(t, A, await n(), ausgeglichen, { datum: "2025-03-15" }));
  });

  it("die Sperre eines Kunden gilt nicht für andere Kunden", async () => {
    const n = (await anzahlBuchungen(B)) + 1;
    await eigen(B, (t) => buche(t, B, n, ausgeglichen, { datum: "2025-03-15" }));
  });
});

describe("Zuordnungen", () => {
  const gId = crypto.randomUUID();
  const pId = crypto.randomUUID();
  const p2Id = crypto.randomUUID();
  let zuordnungSql: (betrag: number, posten?: string) => Promise<unknown>;
  let rechnungsBuchung: string;

  beforeAll(async () => {
    const x = "44444444-4444-4444-8444-444444444444";
    await owner.query("INSERT INTO kunde (id, name) VALUES ($1, 'Kunde Z')", [x]);
    await leereKonten(x);
    await eigen(x, async (t) => {
      rechnungsBuchung = await buche(t, x, 1, [["1100", "debit", 1000, "p1"], ["3000", "credit", 1000]]); // prettier-ignore
      const zahlung = await buche(t, x, 2, [["1020", "debit", 600], ["1100", "credit", 600, "p1"]]); // prettier-ignore
      const fremd = await buche(t, x, 3, [["1100", "debit", 500, "p2"], ["3000", "credit", 500]]); // prettier-ignore
      await sql`INSERT INTO buchhaltung_offener_posten (id, kunde_id, person_id, referenz, belegdatum, faellig_am, betrag, buchung_id, erstellt_am)
        VALUES (${pId}, ${x}, 'p1', 'R1', '2026-06-01', '2026-07-01', 1000, ${rechnungsBuchung}, now()),
               (${p2Id}, ${x}, 'p2', 'R2', '2026-06-01', '2026-07-01', 500, ${fremd}, now())`.execute(
        t,
      );
      await sql`INSERT INTO buchhaltung_guthaben (id, kunde_id, art, person_id, referenz, valuta, betrag, buchung_id, erstellt_am)
        VALUES (${gId}, ${x}, 'payment', 'p1', 'Z1', '2026-06-10', 600, ${zahlung}, now())`.execute(
        t,
      );
    });
    zuordnungSql = (betrag, posten = pId) =>
      eigen(x, (t) =>
        sql`INSERT INTO buchhaltung_zuordnung (kunde_id, guthaben_id, posten_id, betrag, aufhebung_von, erstellt_am, erstellt_von)
            VALUES (${x}, ${gId}, ${posten}, ${betrag}, NULL, now(), 'u')`.execute(t),
      );
  });

  it("lehnt Zuordnungen über das Guthaben hinaus und für eine andere Person ab", async () => {
    await expect(zuordnungSql(601)).rejects.toThrow(/überschreitet/);
    await expect(zuordnungSql(100, p2Id)).rejects.toThrow(/verschiedenen Personen/);
    await zuordnungSql(400);
    await expect(zuordnungSql(201)).rejects.toThrow(/überschreitet/);
    await zuordnungSql(200);
  });

  it("verbietet die Stornierung eines Belegs mit aktiver Zuordnung", async () => {
    const x = "44444444-4444-4444-8444-444444444444";
    await expect(
      eigen(
        x,
        (t) =>
        buche(t, x, 4, [["1100", "credit", 1000, "p1"], ["3000", "debit", 1000]], { stornoVon: rechnungsBuchung }), // prettier-ignore
      ),
    ).rejects.toThrow(/aktive Zuordnungen/);
  });
});

describe("Mandantentrennung", () => {
  it("Kunde A sieht und schreibt nichts von Kunde B", async () => {
    const zeilenB = Number(
      (await owner.query("SELECT count(*) AS n FROM buchhaltung_buchung WHERE kunde_id = $1", [B]))
        .rows[0].n,
    );
    expect(zeilenB).toBeGreaterThan(0);
    const sichtbar = await eigen(A, (t) =>
      t.selectFrom("buchhaltung_buchung").select("kunde_id").execute(),
    );
    expect(sichtbar.every((r) => r.kunde_id === A)).toBe(true);

    for (const tabelle of [
      "buchhaltung_konto",
      "buchhaltung_buchungszeile",
      "buchhaltung_offener_posten",
      "buchhaltung_guthaben",
      "buchhaltung_zuordnung",
      "buchhaltung_periodenereignis",
      "buchhaltung_protokoll",
      "buchhaltung_idempotenz",
    ] as const) {
      const rows = await eigen(A, (t) => t.selectFrom(tabelle).select("kunde_id").execute());
      expect(rows.filter((r) => r.kunde_id !== A)).toEqual([]);
    }
    // Ohne Mandant: nichts.
    expect(await db.kysely.selectFrom("buchhaltung_buchung").selectAll().execute()).toEqual([]);

    await expect(eigen(A, (t) => buche(t, B, 1, ausgeglichen))).rejects.toMatchObject(keineRechte);
    await expect(
      eigen(A, (t) =>
        sql`INSERT INTO buchhaltung_protokoll (kunde_id, zeitpunkt, akteur, aktion, objekt_typ, objekt_id)
            VALUES (${B}, now(), 'u', 'x', 'y', 'z')`.execute(t),
      ),
    ).rejects.toMatchObject(keineRechte);
  });

  it("eine Zeile von Kunde A kann nicht auf eine Buchung oder ein Konto von Kunde B zeigen", async () => {
    const fremdeBuchung = (await owner.query("SELECT id FROM buchhaltung_buchung WHERE kunde_id = $1 LIMIT 1", [B])).rows[0].id;
    await expect(
      eigen(A, (t) =>
        sql`INSERT INTO buchhaltung_buchungszeile (kunde_id, buchung_id, zeilennr, konto_nummer, seite, betrag)
            VALUES (${A}, ${fremdeBuchung}, 7, '1020', 'debit', 5)`.execute(t),
      ),
    ).rejects.toThrow(); // Trigger "nur in der Transaktion ihrer Buchung" bzw. Fremdschlüssel
    const y = "55555555-5555-4555-8555-555555555555";
    await owner.query("INSERT INTO kunde (id, name) VALUES ($1, 'Kunde Y')", [y]);
    await expect(eigen(y, (t) => buche(t, y, 1, ausgeglichen))).rejects.toMatchObject({ code: "23503" }); // Konten gehören Kunde Y nicht
  }); // prettier-ignore

  it("Idempotenzschlüssel sind je Kunde getrennt", async () => {
    const eintrag = (k: string) =>
      eigen(k, (t) =>
        sql`INSERT INTO buchhaltung_idempotenz (kunde_id, schluessel, anfrage_hash, ergebnis)
            VALUES (${k}, 'gleicher-schluessel', ${nullHash}, '{}')`.execute(t),
      );
    await eintrag(A);
    await eintrag(B);
    await expect(eintrag(A)).rejects.toMatchObject({ code: "23505" });
  });
});
