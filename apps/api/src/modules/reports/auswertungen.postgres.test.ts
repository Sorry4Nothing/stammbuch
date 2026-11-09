import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresLedger } from "../accounting/ledger-read.js";
import { createPostgresStore } from "../accounting/postgres-store.js";
import { KUNDE_A, KUNDE_B, closeAll, createDatabase } from "../accounting/postgres.test-support.js";
import { AccountingService } from "../accounting/service.js";
import { createPostgresPeriodFacts } from "./facts-postgres.js";
import { PeriodError, PeriodService } from "./periods.js";
import { createPostgresPeriodStore } from "./periods-postgres.js";
import { debtorsReport, vatReport } from "./reports.js";

afterAll(closeAll);

const KUNDE_C = "33333333-3333-4333-8333-333333333333";
const A = { tenantId: KUNDE_A, userId: "u-a" };

// Erfundene Daten (SR-41). Mandant A, Januar bis Februar 2026:
//   R-1 (Mitglied m1) 100.00, gebucht, am 01.03. erinnert (Stufe 1), am 15.03. gemahnt (Stufe 2)
//   R-2 (Firma f1) 200.00, gebucht, nie gemahnt
//   R-9 versendet am 20.01., aber nicht gebucht; ein Entwurf vom 25.01.
//   Restposten vom 28.01. (Referenz fehlt) und vom 10.02. (Betrag weicht ab), ein zugeordneter Eingang
let seq = 0;
const key = () => `key-${(seq++).toString().padStart(8, "0")}`;
const hex = (n: number) => n.toString(16).padStart(64, "0");

async function setup() {
  const { db, owner } = await createDatabase([KUNDE_A, KUNDE_B, KUNDE_C]);
  const m1 = randomUUID();
  const f1 = randomUUID();
  const u1 = randomUUID();
  let now = new Date("2026-01-15T10:00:00Z");
  const svc = new AccountingService(createPostgresStore(db), () => now);

  await owner.query(
    `INSERT INTO mitglied (kunde_id, id, typ, vorname, nachname) VALUES ($1, $2, 'einzel', 'Anna', 'Muster')`,
    [KUNDE_A, m1],
  );
  await owner.query(
    `INSERT INTO firma (kunde_id, id, name, strasse, plz, ort, status)
     VALUES ($1, $2, 'Beispiel AG', 'Hauptstrasse', '8000', 'Zürich', 'freigegeben')`,
    [KUNDE_A, f1],
  );
  for (const [kunde, id, name] of [
    [KUNDE_A, u1, "Sabine Muster"],
    [KUNDE_B, randomUUID(), "Fremder Benutzer"],
  ] as const) {
    await owner.query(
      `INSERT INTO benutzer (id, kunde_id, email, name, passwort_hash) VALUES ($1, $2, $3, $4, 'x')`,
      [id, kunde, `${name.split(" ")[0]!.toLowerCase()}@example.test`, name],
    );
  }

  let lauf = 0;
  const invoice = async (
    person: string,
    nummer: string,
    datum: string,
    betrag: number,
    opts: { book?: boolean; status?: string } = {},
  ) => {
    const draft = opts.status === "entwurf";
    const id = randomUUID();
    await owner.query(
      `INSERT INTO rechnung (id, kunde_id, art, status, nummer, laufnummer, kundennummer, debitor, waehrung,
         rechnungsdatum, faelligkeitsdatum, mwst_modus, runden_5, betreff, notizen, netto_rappen, mwst_rappen,
         brutto_rappen, rundung_rappen, total_rappen, mwst_saetze, versendet_am, erstellt_am, geaendert_am, version)
       VALUES ($1, $2, 'rechnung', $3, $4, $5, $6, '{}', 'CHF', $7::date, ($7::date + 30), 'ohne', false, 'Test', '',
         $8, 0, $8, 0, $8, '[]', $9, now(), now(), 1)`,
      [
        id,
        KUNDE_A,
        opts.status ?? "versendet",
        draft ? null : nummer,
        draft ? null : ++lauf,
        person,
        datum,
        betrag,
        draft ? null : now.toISOString(),
      ],
    );
    if (opts.book !== false && !draft) {
      now = new Date(`${datum}T10:00:00Z`);
      await svc.postReceivable(A, {
        idempotencyKey: key(),
        kind: "invoice",
        personId: person,
        reference: nummer,
        bookingDate: datum,
        dueDate: addDays(datum, 30),
        counterLines: [{ accountCode: "3000", amount: betrag }],
      });
    }
    return id;
  };

  const r1 = await invoice(m1, "R-1", "2026-01-15", 10_000);
  await invoice(f1, "R-2", "2026-02-10", 20_000);
  await invoice(m1, "R-9", "2026-01-20", 5_000, { book: false });
  await invoice(m1, "-", "2026-01-25", 1_000, { status: "entwurf" });
  for (const [stufe, datum] of [
    [1, "2026-03-01"],
    [2, "2026-03-15"],
  ] as const) {
    await owner.query(
      `INSERT INTO mahnung (id, kunde_id, rechnung_id, stufe, titel, ausgestellt_am, faellig_am,
         gebuehr_rappen, offen_rappen, total_rappen, erstellt_am)
       VALUES ($1, $2, $3, $4, 'Mahnung', $5::date, ($5::date + 10), 0, 10000, 10000, now())`,
      [randomUUID(), KUNDE_A, r1, stufe, datum],
    );
  }

  const importId = randomUUID();
  await owner.query(
    `INSERT INTO camt_import (id, kunde_id, datei_hash, art, version, nachricht_id, zaehler)
     VALUES ($1, $2, $3, 'camt.053', '04', 'msg-1', '{}')`,
    [importId, KUNDE_A, hex(1)],
  );
  const payment = (
    n: number,
    status: string,
    datum: string,
    rappen: number,
    grund: string | null,
  ) =>
    owner.query(
      `INSERT INTO camt_zahlung (id, kunde_id, import_id, buchungsschluessel, status, rest_grund, offener_posten_id,
         buchungsdatum, betrag_rappen, waehrung, richtung, storno, transaktion)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, 'CHF', 'CREDIT', false, $10::jsonb)`,
      [
        randomUUID(),
        KUNDE_A,
        importId,
        hex(100 + n),
        status,
        grund,
        status === "REST" ? null : "op-1",
        datum,
        rappen,
        JSON.stringify({ debtorName: `Zahler ${n}`, valueDate: datum, bookingDate: datum }),
      ],
    );
  await payment(1, "REST", "2026-01-28", 84_600, "NO_REFERENCE");
  await payment(2, "REST", "2026-02-10", 10_000, "AMOUNT_MISMATCH");
  await payment(3, "MATCHED", "2026-01-29", 5_000, null);

  now = new Date("2026-02-20T10:00:00Z");
  await svc.bookPayment(A, {
    idempotencyKey: key(),
    personId: m1,
    bankAccountCode: "1020",
    valueDate: "2026-02-20",
    amount: 4_000,
    reference: "Z-1",
  });

  // Mandant B: Restposten und Entwurf, die A nie sehen darf.
  await owner.query(
    `INSERT INTO camt_import (id, kunde_id, datei_hash, art, version, nachricht_id, zaehler)
     VALUES ($1, $2, $3, 'camt.053', '04', 'msg-b', '{}')`,
    [randomUUID(), KUNDE_B, hex(2)],
  );

  const ledger = createPostgresLedger(db);
  const facts = createPostgresPeriodFacts(db);
  const store = createPostgresPeriodStore(db);
  return { db, owner, ledger, facts, store, ids: { m1, f1, u1 } };
}

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

describe("Debitorenliste und MwSt auf den Tabellen", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    s = await setup();
  });

  it("Art der Person aus Mitglied und Firma", async () => {
    const debtors = await s.ledger.listDebtors(KUNDE_A);
    const by = Object.fromEntries(debtors.map((d) => [d.id, d]));
    expect(by[s.ids.m1]).toMatchObject({ name: "Anna Muster", type: "person" });
    expect(by[s.ids.f1]).toMatchObject({ name: "Beispiel AG", type: "company" });
  });

  it("Mahnstufe gilt ab Ausstellung der Mahnung, Aufteilung nach Sammelkonto", async () => {
    const level = async (asOf: string, id: string) =>
      (await debtorsReport(s.ledger, KUNDE_A, { asOf })).rows.find((r) => r.debtorId === id)
        ?.dunningLevel;
    expect(await level("2026-02-28", s.ids.m1)).toBe(0);
    expect(await level("2026-03-10", s.ids.m1)).toBe(1);
    expect(await level("2026-03-31", s.ids.m1)).toBe(2);
    expect(await level("2026-03-31", s.ids.f1)).toBe(0);

    const r = await debtorsReport(s.ledger, KUNDE_A, { asOf: "2026-03-31" });
    expect(r.accounts).toEqual([expect.objectContaining({ number: "1100", debtors: 2, items: 3 })]);
    expect(r.accounts?.[0]?.balanceCents).toBe(r.totals.openCents);
    expect(r.totals.differenceCents).toBe(0);
  });

  it("erste Buchung und Steuerkonto", async () => {
    expect(await s.ledger.earliestBookingDate(KUNDE_A)).toBe("2026-01-15");
    expect(await s.ledger.earliestBookingDate(KUNDE_B)).toBeUndefined();
    const v = await vatReport(s.ledger, KUNDE_A, {
      from: "2026-01-01",
      to: "2026-12-31",
      method: "effective",
    });
    expect(v.rows.every((r) => r.account === "2200")).toBe(true);
    // Beiträge ohne Steuerzeile: Umsatz zu 0 %.
    expect(v.totals.untaxedCents).toBe(v.totals.turnoverCents);
  });
});

describe("Angaben zum Periodenabschluss auf den Tabellen", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    s = await setup();
  });

  it("zählt Belege, Entwürfe, Restposten und Buchungen des Zeitraums", async () => {
    const jan = await s.facts.periodFacts(KUNDE_A, { from: "2026-01-01", to: "2026-01-31" });
    expect(jan.invoices).toEqual({ total: 2, unbooked: 1 });
    expect(jan.drafts).toBe(1);
    expect(jan.leftovers).toEqual({
      count: 1,
      totalCents: 84_600,
      rows: [
        {
          id: expect.any(String),
          valueDate: "2026-01-28",
          payer: "Zahler 1",
          amountCents: 84_600,
          reason: "Referenz fehlt",
        },
      ],
    });
    expect(jan.stats).toEqual({ bookings: 1, invoices: 1, payments: 0, reversals: 0 });

    const feb = await s.facts.periodFacts(KUNDE_A, { from: "2026-02-01", to: "2026-02-28" });
    expect(feb.invoices).toEqual({ total: 1, unbooked: 0 });
    expect(feb.leftovers).toMatchObject({ count: 1, totalCents: 10_000 });
    expect(feb.leftovers.rows[0]?.reason).toBe("Betrag weicht ab");
    expect(feb.stats).toEqual({ bookings: 2, invoices: 1, payments: 1, reversals: 0 });
  });

  it("Mandanten sind getrennt", async () => {
    const b = await s.facts.periodFacts(KUNDE_B, { from: "2026-01-01", to: "2026-12-31" });
    expect(b.invoices.total).toBe(0);
    expect(b.leftovers.count).toBe(0);
    expect(b.stats.bookings).toBe(0);
    expect(await s.facts.userNames(KUNDE_B, [s.ids.u1])).toEqual(new Map());
  });

  it("Buchungsanzahl je Zeitraum und Namen zu Kennungen", async () => {
    expect(
      await s.facts.bookingCounts(KUNDE_A, [
        { from: "2026-01-01", to: "2026-01-31" },
        { from: "2026-02-01", to: "2026-02-28" },
        { from: "2026-04-01", to: "2026-04-30" },
      ]),
    ).toEqual([1, 2, 0]);
    expect(await s.facts.bookingCounts(KUNDE_A, [])).toEqual([]);
    const names = await s.facts.userNames(KUNDE_A, [s.ids.u1, "kein-benutzer", "u-a"]);
    expect([...names]).toEqual([[s.ids.u1, "Sabine Muster"]]);
  });
});

describe("Perioden in der Datenbank", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    s = await setup();
  });
  const service = (now = "2026-03-20T10:00:00Z") =>
    new PeriodService({
      ledger: s.ledger,
      facts: s.facts,
      store: s.store,
      now: () => new Date(now),
    });

  it("legt Monate an, bleibt nach erneutem Aufruf gleich und trennt Mandanten", async () => {
    const first = await service().ensureMonths(KUNDE_A);
    expect(first.map((p) => p.label)).toEqual(["Januar 2026", "Februar 2026", "März 2026"]);
    const again = await service().ensureMonths(KUNDE_A);
    expect(again.map((p) => p.id)).toEqual(first.map((p) => p.id));
    expect(await s.store.list(KUNDE_C)).toEqual([]);
    expect(await s.store.get(KUNDE_C, first[0]!.id)).toBeUndefined();
    expect(await s.store.get(KUNDE_A, "keine-uuid")).toBeUndefined();
  });

  it("Prüfung findet den nicht gebuchten Beleg; Warnungen sperren nicht", async () => {
    const [jan, feb] = await service().ensureMonths(KUNDE_A);
    const checkedJan = await service().runCheck(KUNDE_A, jan!.id, "u-a");
    expect(checkedJan.state).toBe("open");
    expect(checkedJan.issues.map((i) => [i.code, i.severity])).toEqual(
      expect.arrayContaining([
        ["INVOICE_NOT_BOOKED", "error"],
        ["PAYMENT_LEFTOVERS", "warning"],
        ["DRAFT_INVOICES", "warning"],
      ]),
    );
    const checkedFeb = await service().runCheck(KUNDE_A, feb!.id, "u-a");
    expect(checkedFeb.state).toBe("checked");
    expect(checkedFeb.issues.map((i) => i.code)).toEqual(["PAYMENT_LEFTOVERS"]);
    // Gespeichert und wieder gelesen.
    const stored = await s.store.get(KUNDE_A, feb!.id);
    expect(stored).toMatchObject({
      state: "checked",
      version: 2,
      checkFingerprint: expect.any(String),
    });
    expect(stored?.history).toHaveLength(1);
  });

  it("optimistische Sperre und doppelter Beginn", async () => {
    const [jan] = await s.store.list(KUNDE_A);
    await expect(s.store.save(KUNDE_A, { ...jan!, version: 99 }, 98)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      s.store.save(KUNDE_A, { ...jan!, id: randomUUID(), version: 1, issues: [], history: [] }),
    ).rejects.toBeInstanceOf(PeriodError);
  });

  it("eine abgeschlossene Periode ist unveränderlich und wird nie gelöscht", async () => {
    // Mandant C ist leer: Prüfung und Abschluss laufen ohne Befunde durch.
    const svc = service();
    const [p] = await svc.ensureMonths(KUNDE_C);
    await svc.runCheck(KUNDE_C, p!.id, "u-c");
    const closed = await svc.confirm(KUNDE_C, p!.id, "u-c");
    expect(closed.state).toBe("closed");

    await expect(
      s.store.save(KUNDE_C, { ...closed, version: closed.version + 1 }, closed.version),
    ).rejects.toThrow();
    await expect(
      s.owner.query(`UPDATE auswertung_periode SET version = version + 1 WHERE id = $1`, [p!.id]),
    ).rejects.toThrow(/unveränderlich/);
    await expect(
      s.owner.query(`DELETE FROM auswertung_periode WHERE id = $1`, [p!.id]),
    ).rejects.toThrow(/nie gelöscht/);
    expect((await s.store.get(KUNDE_C, p!.id))?.state).toBe("closed");
  });
});
