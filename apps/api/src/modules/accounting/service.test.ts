import { describe, expect, it } from "vitest";
import { DomainError } from "./domain.js";
import type { JournalEntry } from "./domain.js";
import { createMemoryStore } from "./repository.js";
import type { OpenItem } from "./repository.js";
import type { AccountingStore } from "./repository.js";
import { AccountingService } from "./service.js";
import type { Ctx } from "./service.js";

const A: Ctx = { tenantId: "t-a", userId: "u-1" };
const B: Ctx = { tenantId: "t-b", userId: "u-2" };
const page = { offset: 0, limit: 500 };

let seq = 0;
const key = () => `key-${(seq++).toString().padStart(8, "0")}`;

function setup(store: AccountingStore = createMemoryStore()) {
  const svc = new AccountingService(store, () => new Date("2026-06-15T10:00:00Z"));
  const invoice = async (
    personId: string,
    chf: number,
    over: Partial<{ bookingDate: string; dueDate: string }> = {},
  ) =>
    (
      await svc.postReceivable(A, {
        idempotencyKey: key(),
        kind: "invoice",
        personId,
        reference: `R-${seq}`,
        bookingDate: over.bookingDate ?? "2026-06-01",
        dueDate: over.dueDate ?? "2026-07-01",
        counterLines: [{ accountCode: "3000", amount: chf * 100 }],
      })
    ).result;
  const payment = async (personId: string, chf: number, valueDate = "2026-06-10") =>
    (
      await svc.bookPayment(A, {
        idempotencyKey: key(),
        personId,
        bankAccountCode: "1020",
        valueDate,
        amount: chf * 100,
        reference: `Z-${seq}`,
      })
    ).result;
  const allocate = (creditId: string, ...a: [string, number][]) =>
    svc.allocate(A, {
      idempotencyKey: key(),
      creditId,
      allocations: a.map(([openItemId, chf]) => ({ openItemId, amount: chf * 100 })),
    });
  return { svc, invoice, payment, allocate };
}

const rejects = async (p: Promise<unknown>, code?: string) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(DomainError);
  if (code) expect((e as DomainError).code).toBe(code);
};

describe("Rechnung und Debitorenkonto", () => {
  it("bucht Soll Debitoren / Haben Erlös, legt offenen Posten an und stimmt ab", async () => {
    const { svc, invoice } = setup();
    const { entry, openItem } = await invoice("p1", 108);
    expect(entry.lines).toEqual([
      { accountCode: "1100", side: "debit", amount: 10800, personId: "p1" },
      { accountCode: "3000", side: "credit", amount: 10800 },
    ]);
    expect(entry.retentionUntil).toBe("2036-12-31");
    expect(openItem?.amount).toBe(10800);

    const ledger = await svc.personLedger(A, "p1", { offset: 0, limit: 50 });
    expect(ledger.balance).toBe(10800);
    expect(ledger.openItems).toHaveLength(1);
    expect((await svc.trialBalance(A, {})).balanced).toBe(true);
    expect((await svc.reconcileDebtors(A)).difference).toBe(0);
  });

  it("splittet Erlös und Mehrwertsteuer auf Gegenkonten", async () => {
    const { svc } = setup();
    const { result } = await svc.postReceivable(A, {
      idempotencyKey: key(),
      kind: "invoice",
      personId: "p1",
      reference: "R-MWST",
      bookingDate: "2026-06-01",
      dueDate: "2026-07-01",
      counterLines: [
        { accountCode: "3400", amount: 10000 },
        { accountCode: "2200", amount: 810 },
      ],
    });
    expect(result.openItem?.amount).toBe(10810);
    const tb = await svc.trialBalance(A, {});
    expect(tb.rows.find((r) => r.code === "2200")?.balance).toBe(810);
  });

  it("verweigert Gegenkonto Bank, Debitoren-Sammelkonto in freier Buchung und unbekannte Konten", async () => {
    const { svc } = setup();
    const base = {
      kind: "invoice" as const,
      personId: "p1",
      reference: "R",
      bookingDate: "2026-06-01",
      dueDate: "2026-07-01",
    };
    await rejects(
      svc.postReceivable(A, {
        ...base,
        idempotencyKey: key(),
        counterLines: [{ accountCode: "1020", amount: 100 }],
      }),
      "RULE_VIOLATION",
    );
    await rejects(
      svc.postReceivable(A, {
        ...base,
        idempotencyKey: key(),
        counterLines: [{ accountCode: "9999", amount: 100 }],
      }),
      "RULE_VIOLATION",
    );
    await rejects(
      svc.postManualEntry(A, {
        idempotencyKey: key(),
        bookingDate: "2026-06-01",
        description: "Umgehung",
        lines: [
          { accountCode: "1100", side: "debit", amount: 100, personId: "p1" },
          { accountCode: "3000", side: "credit", amount: 100 },
        ],
      }),
      "RULE_VIOLATION",
    );
  });

  it("verweigert unausgeglichene freie Buchungen und Person auf Nicht-Debitorenkonto", async () => {
    const { svc } = setup();
    await rejects(
      svc.postManualEntry(A, {
        idempotencyKey: key(),
        bookingDate: "2026-06-01",
        description: "schief",
        lines: [
          { accountCode: "1020", side: "debit", amount: 100 },
          { accountCode: "3000", side: "credit", amount: 99 },
        ],
      }),
      "UNBALANCED",
    );
    await rejects(
      svc.postManualEntry(A, {
        idempotencyKey: key(),
        bookingDate: "2026-06-01",
        description: "Person am falschen Konto",
        lines: [
          { accountCode: "1020", side: "debit", amount: 100, personId: "p1" },
          { accountCode: "3000", side: "credit", amount: 100 },
        ],
      }),
      "RULE_VIOLATION",
    );
  });
});

describe("Idempotenz", () => {
  it("liefert bei gleichem Schlüssel und gleicher Anfrage dasselbe Ergebnis ohne zweite Buchung", async () => {
    const { svc } = setup();
    const input = {
      idempotencyKey: "invoice-2026-0001",
      kind: "invoice" as const,
      personId: "p1",
      reference: "R-1",
      bookingDate: "2026-06-01",
      dueDate: "2026-07-01",
      counterLines: [{ accountCode: "3000", amount: 5000 }],
    };
    const first = await svc.postReceivable(A, input);
    const again = await svc.postReceivable(A, input);
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.result.entry.id).toBe(first.result.entry.id);
    expect(await svc.listEntries(A, {}, page)).toHaveLength(1);
    expect((await svc.personLedger(A, "p1", page)).balance).toBe(5000);
  });

  it("verweigert denselben Schlüssel für eine andere Anfrage", async () => {
    const { svc } = setup();
    const input = {
      idempotencyKey: "invoice-2026-0001",
      kind: "invoice" as const,
      personId: "p1",
      reference: "R-1",
      bookingDate: "2026-06-01",
      dueDate: "2026-07-01",
      counterLines: [{ accountCode: "3000", amount: 5000 }],
    };
    await svc.postReceivable(A, input);
    await rejects(
      svc.postReceivable(A, { ...input, counterLines: [{ accountCode: "3000", amount: 5001 }] }),
      "CONFLICT",
    );
  });

  it("gleichzeitige Wiederholungen ergeben genau eine Buchung", async () => {
    const { svc } = setup();
    const input = {
      idempotencyKey: "parallel-0001",
      personId: "p1",
      bankAccountCode: "1020",
      valueDate: "2026-06-10",
      amount: 7000,
      reference: "Z",
    };
    const rs = await Promise.all(Array.from({ length: 10 }, () => svc.bookPayment(A, input)));
    expect(rs.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await svc.listEntries(A, {}, page)).toHaveLength(1);
  });
});

describe("Storno per Gegenbuchung", () => {
  it("lässt das Original unverändert und gleicht den Saldo aus", async () => {
    const { svc, invoice } = setup();
    const { entry } = await invoice("p1", 100);
    const { result: rev } = await svc.reverseEntry(A, entry.id, {
      idempotencyKey: key(),
      bookingDate: "2026-06-02",
      reason: "Falsche Person",
    });
    expect(rev.reversalOf).toBe(entry.id);
    expect(rev.kind).toBe("reversal");
    expect(rev.lines.map((l) => l.side)).toEqual(["credit", "debit"]);

    const after = await svc.getEntry(A, entry.id);
    expect(after.entry).toEqual(entry);
    expect(after.reversedBy).toBe(rev.id);
    expect((await svc.personLedger(A, "p1", page)).balance).toBe(0);
    const [item] = await svc.listOpenItems(A, { onlyOpen: false }, page);
    expect(item).toMatchObject({ status: "reversed", remaining: 0 });
    expect((await svc.reconcileDebtors(A)).difference).toBe(0);
  });

  it("verweigert doppeltes Storno, Storno eines Stornos und Stornodatum vor dem Original", async () => {
    const { svc, invoice } = setup();
    const { entry } = await invoice("p1", 100);
    await rejects(
      svc.reverseEntry(A, entry.id, {
        idempotencyKey: key(),
        bookingDate: "2026-05-31",
        reason: "zu früh",
      }),
      "RULE_VIOLATION",
    );
    const { result: rev } = await svc.reverseEntry(A, entry.id, {
      idempotencyKey: key(),
      bookingDate: "2026-06-02",
      reason: "Fehler",
    });
    await rejects(
      svc.reverseEntry(A, entry.id, {
        idempotencyKey: key(),
        bookingDate: "2026-06-03",
        reason: "nochmals",
      }),
      "CONFLICT",
    );
    await rejects(
      svc.reverseEntry(A, rev.id, {
        idempotencyKey: key(),
        bookingDate: "2026-06-03",
        reason: "Storno Storno",
      }),
      "RULE_VIOLATION",
    );
  });

  it("verlangt zuerst die Aufhebung der Zuordnung", async () => {
    const { svc, invoice, payment, allocate } = setup();
    const { entry, openItem } = await invoice("p1", 100);
    const { credit } = await payment("p1", 100);
    const { result } = await allocate(credit.id, [openItem!.id, 100]);

    const reverse = () =>
      svc.reverseEntry(A, entry.id, {
        idempotencyKey: key(),
        bookingDate: "2026-06-12",
        reason: "Irrtum",
      });
    await rejects(reverse(), "RULE_VIOLATION");
    await svc.reverseAllocation(A, result.allocations[0]!.id, key());
    await reverse();
    expect((await svc.reconcileDebtors(A)).difference).toBe(0);
  });

  it("verweigert Zuordnung auf stornierte Rechnung und stornierte Zahlung", async () => {
    const { svc, invoice, payment, allocate } = setup();
    const { entry, openItem } = await invoice("p1", 100);
    const { credit, entry: payEntry } = await payment("p1", 100);
    await svc.reverseEntry(A, entry.id, {
      idempotencyKey: key(),
      bookingDate: "2026-06-12",
      reason: "Irrtum",
    });
    await rejects(allocate(credit.id, [openItem!.id, 100]), "RULE_VIOLATION");

    const second = await invoice("p1", 50);
    await svc.reverseEntry(A, payEntry.id, {
      idempotencyKey: key(),
      bookingDate: "2026-06-12",
      reason: "Rückbuchung",
    });
    await rejects(allocate(credit.id, [second.openItem!.id, 50]), "RULE_VIOLATION");
  });
});

describe("Zahlungszuordnung (Tabelle)", () => {
  // [Rechnungen in CHF, Zahlung in CHF, Zuordnung je Rechnung, Rest offen je Rechnung, nicht zugeordnet, Saldo]
  const cases: [string, number[], number, number[], number[], number, number][] = [
    ["volle Zahlung", [100], 100, [100], [0], 0, 0],
    ["Teilzahlung", [100], 40, [40], [60], 0, 60],
    ["Teilzahlung, Rest später", [100], 100, [30], [70], 70, 0],
    ["Mehrzahlung auf zwei Rechnungen", [100, 50], 150, [100, 50], [0, 0], 0, 0],
    ["Überzahlung bleibt Guthaben", [100], 130, [100], [0], 30, -30],
    ["Zahlung ohne Zuordnung", [100], 100, [0], [100], 100, 0],
  ];
  it.each(cases)("%s", async (_n, invoices, pay, allocs, remaining, unallocated, balance) => {
    const { svc, invoice, payment, allocate } = setup();
    const items: OpenItem[] = [];
    for (const chf of invoices) items.push((await invoice("p1", chf)).openItem!);
    const { credit } = await payment("p1", pay);
    const rows = allocs.flatMap((chf, i): [string, number][] =>
      chf > 0 ? [[items[i]!.id, chf]] : [],
    );
    if (rows.length > 0) await allocate(credit.id, ...rows);

    const view = await svc.listOpenItems(A, { onlyOpen: false }, page);
    const byId = new Map(view.map((v) => [v.id, v]));
    expect(items.map((i) => byId.get(i.id)!.remaining)).toEqual(remaining.map((r) => r * 100));
    const ledger = await svc.personLedger(A, "p1", page);
    expect(ledger.unallocatedCredits.reduce((s, c) => s + c.available, 0)).toBe(unallocated * 100);
    expect(ledger.balance).toBe(balance * 100);
    expect((await svc.reconcileDebtors(A)).difference).toBe(0);
  });

  it("markiert Status offen / teilbezahlt / bezahlt", async () => {
    const { svc, invoice, payment, allocate } = setup();
    const a = (await invoice("p1", 100)).openItem!;
    const b = (await invoice("p1", 100)).openItem!;
    await invoice("p1", 100);
    const { credit } = await payment("p1", 160);
    await allocate(credit.id, [a.id, 100], [b.id, 60]);
    const status = (await svc.listOpenItems(A, { onlyOpen: false }, page))
      .map((i) => i.status)
      .sort();
    expect(status).toEqual(["open", "paid", "partial"]);
    expect(await svc.listOpenItems(A, { onlyOpen: true }, page)).toHaveLength(2);
  });

  it("verweigert Zuordnungen über Guthaben, über Rest, doppelte Posten, fremde Person, fremde Mandanten", async () => {
    const { svc, invoice, payment, allocate } = setup();
    const i1 = (await invoice("p1", 100)).openItem!;
    const i2 = (await invoice("p1", 100)).openItem!;
    const other = (await invoice("p2", 100)).openItem!;
    const { credit } = await payment("p1", 120);

    await rejects(allocate(credit.id, [i1.id, 100], [i2.id, 21]), "RULE_VIOLATION"); // über Guthaben
    await rejects(allocate(credit.id, [i1.id, 101]), "RULE_VIOLATION"); // über Rest
    await rejects(allocate(credit.id, [i1.id, 10], [i1.id, 10]), "RULE_VIOLATION"); // doppelt
    await rejects(allocate(credit.id, [other.id, 10]), "RULE_VIOLATION"); // andere Person
    await rejects(allocate(credit.id, ["00000000-0000-4000-8000-000000000000", 10]), "NOT_FOUND");
    // Nichts wurde teilweise geschrieben.
    expect(
      (await svc.listOpenItems(A, { onlyOpen: false }, page)).every((i) => i.allocated === 0),
    ).toBe(true);

    await allocate(credit.id, [i1.id, 100], [i2.id, 20]);
    await rejects(allocate(credit.id, [i2.id, 1]), "RULE_VIOLATION"); // Guthaben aufgebraucht

    // anderer Mandant sieht weder Zahlung noch Posten
    await rejects(
      svc.allocate(B, {
        idempotencyKey: key(),
        creditId: credit.id,
        allocations: [{ openItemId: i1.id, amount: 1 }],
      }),
      "NOT_FOUND",
    );
  });

  it("hebt eine Zuordnung per Gegeneintrag auf, genau einmal", async () => {
    const { svc, invoice, payment, allocate } = setup();
    const item = (await invoice("p1", 100)).openItem!;
    const { credit } = await payment("p1", 100);
    const { result } = await allocate(credit.id, [item.id, 100]);
    const id = result.allocations[0]!.id;
    const { result: undo } = await svc.reverseAllocation(A, id, key());
    expect(undo.allocation.amount).toBe(-10000);
    expect((await svc.listOpenItems(A, { onlyOpen: true }, page))[0]?.remaining).toBe(10000);
    await rejects(svc.reverseAllocation(A, id, key()), "CONFLICT");
    await rejects(svc.reverseAllocation(A, undo.allocation.id, key()), "RULE_VIOLATION");
    // erneut zuordnen ist möglich
    await allocate(credit.id, [item.id, 100]);
  });

  it("Gutschrift wird wie eine Zahlung zugeordnet", async () => {
    const { svc, invoice, allocate } = setup();
    const item = (await invoice("p1", 100)).openItem!;
    const { result } = await svc.postReceivable(A, {
      idempotencyKey: key(),
      kind: "credit_note",
      personId: "p1",
      reference: "G-1",
      bookingDate: "2026-06-05",
      counterLines: [{ accountCode: "3800", amount: 3000 }],
    });
    expect((await svc.personLedger(A, "p1", page)).balance).toBe(7000);
    await allocate(result.credit!.id, [item.id, 30]);
    expect((await svc.listOpenItems(A, { onlyOpen: true }, page))[0]?.remaining).toBe(7000);
    expect((await svc.reconcileDebtors(A)).difference).toBe(0);
  });
});

describe("Offene-Posten-Liste und Alterung", () => {
  it("berechnet Überfälligkeit und Altersklasse relativ zum Stichtag", async () => {
    const { svc, invoice } = setup();
    await invoice("p1", 10, { bookingDate: "2026-01-01", dueDate: "2026-02-01" }); // 134 Tage
    await invoice("p1", 10, { bookingDate: "2026-04-01", dueDate: "2026-05-01" }); // 45 Tage
    await invoice("p1", 10, { bookingDate: "2026-06-01", dueDate: "2026-07-15" }); // nicht fällig
    const rows = await svc.listOpenItems(A, { onlyOpen: true, asOf: "2026-06-15" }, page);
    expect(rows.map((r) => [r.overdueDays, r.agingBucket])).toEqual([
      [134, "d90_plus"],
      [45, "d31_60"],
      [0, "not_due"],
    ]);
  });

  it("paginiert", async () => {
    const { svc, invoice } = setup();
    for (let i = 0; i < 5; i++) await invoice("p1", 10);
    expect(await svc.listOpenItems(A, { onlyOpen: true }, { offset: 3, limit: 10 })).toHaveLength(
      2,
    );
  });
});

describe("Debitorenliste und Saldenliste", () => {
  it("führt Saldo je Person und sortiert nach Forderung", async () => {
    const { svc, invoice, payment } = setup();
    await invoice("p1", 100);
    await invoice("p2", 300);
    await payment("p3", 50);
    const list = await svc.debtorList(A, { nonZero: true }, { offset: 0, limit: 50 });
    expect(list.map((r) => [r.personId, r.balance])).toEqual([
      ["p2", 30000],
      ["p1", 10000],
      ["p3", -5000],
    ]);
  });

  it("Saldenliste ist ausgeglichen und respektiert den Zeitraum", async () => {
    const { svc, invoice, payment } = setup();
    await invoice("p1", 100, { bookingDate: "2026-05-10", dueDate: "2026-06-10" });
    await payment("p1", 100, "2026-06-10");
    const may = await svc.trialBalance(A, { from: "2026-05-01", to: "2026-05-31" });
    expect(may.rows.find((r) => r.code === "1100")?.balance).toBe(10000);
    expect(may.balanced).toBe(true);
    const all = await svc.trialBalance(A, {});
    expect(all.rows.find((r) => r.code === "1100")?.balance).toBe(0);
    expect(all.rows.find((r) => r.code === "1020")?.balance).toBe(10000);
  });
});

describe("Perioden", () => {
  it("sperrt Buchungen in abgeschlossener Periode, auch Stornos, und öffnet mit Begründung wieder", async () => {
    const { svc, invoice } = setup();
    const { entry } = await invoice("p1", 100, {
      bookingDate: "2026-05-10",
      dueDate: "2026-06-10",
    });
    await svc.closePeriod(A, "2026-05");
    await rejects(invoice("p1", 10, { bookingDate: "2026-05-20" }), "PERIOD_CLOSED");
    await rejects(
      svc.reverseEntry(A, entry.id, {
        idempotencyKey: key(),
        bookingDate: "2026-05-31",
        reason: "Korrektur",
      }),
      "PERIOD_CLOSED",
    );
    // Korrektur im offenen Folgemonat bleibt möglich
    await svc.reverseEntry(A, entry.id, {
      idempotencyKey: key(),
      bookingDate: "2026-06-01",
      reason: "Korrektur",
    });

    await rejects(svc.closePeriod(A, "2026-05"), "CONFLICT");
    await svc.reopenPeriod(A, "2026-05", "Nachbuchung Treuhänder");
    await invoice("p1", 10, { bookingDate: "2026-05-20" });
    expect((await svc.listPeriods(A)).map((p) => [p.period, p.status])).toEqual([
      ["2026-05", "open"],
    ]);
    await rejects(svc.reopenPeriod(A, "2026-05", "nochmals"), "CONFLICT");
  });

  it("schliesst keine zukünftige Periode", async () => {
    const { svc } = setup();
    await rejects(svc.closePeriod(A, "2026-07"), "RULE_VIOLATION");
    await svc.closePeriod(A, "2026-06");
  });

  it("Zuordnung ist in abgeschlossener Periode möglich (ändert das Journal nicht)", async () => {
    const { svc, invoice, payment, allocate } = setup();
    const item = (await invoice("p1", 100, { bookingDate: "2026-05-10", dueDate: "2026-06-10" }))
      .openItem!;
    const { credit } = await payment("p1", 100, "2026-05-12");
    await svc.closePeriod(A, "2026-05");
    await allocate(credit.id, [item.id, 100]);
  });
});

describe("Mandantentrennung und Protokoll", () => {
  it("trennt Konten, Buchungen und Salden strikt nach Mandant", async () => {
    const { svc, invoice } = setup();
    const { entry } = await invoice("p1", 100);
    await rejects(svc.getEntry(B, entry.id), "NOT_FOUND");
    expect(await svc.listEntries(B, {}, page)).toEqual([]);
    expect((await svc.personLedger(B, "p1", page)).balance).toBe(0);
    await svc.createAccount(B, { code: "3999", name: "Nur B", type: "revenue" });
    expect((await svc.listAccounts(A)).some((a) => a.code === "3999")).toBe(false);
  });

  it("protokolliert Buchung, Storno, Zuordnung und Periodenaktionen ohne Freitexte", async () => {
    const { svc, invoice, payment, allocate } = setup();
    const { entry, openItem } = await invoice("p1", 100);
    const { credit } = await payment("p1", 100);
    await allocate(credit.id, [openItem!.id, 100]);
    await svc.closePeriod(A, "2026-06");
    const log = await svc.listAudit(A, page);
    const actions = log.map((l) => l.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "entry.posted",
        "payment.booked",
        "allocation.created",
        "period.closed",
      ]),
    );
    expect(log.every((l) => l.actor === "u-1")).toBe(true);
    expect(JSON.stringify(log)).not.toContain("Rechnung");
    expect(log.find((l) => l.objectId === entry.id)).toBeDefined();
  });

  it("verweigert doppelte Konten", async () => {
    const { svc } = setup();
    await rejects(
      svc.createAccount(A, { code: "1100", name: "Doppelt", type: "asset" }),
      "CONFLICT",
    );
  });
});

describe("Integrität (Hash-Kette)", () => {
  it("erkennt ein unverändertes Journal als intakt", async () => {
    const { svc, invoice, payment } = setup();
    await invoice("p1", 100);
    await payment("p1", 20);
    expect(await svc.verifyIntegrity(A)).toEqual({ ok: true, checked: 2, error: null });
    expect(await svc.verifyIntegrity(B)).toEqual({ ok: true, checked: 0, error: null });
  });

  it("erkennt nachträgliche Änderung, Löschung und Umordnung", async () => {
    const real = createMemoryStore();
    let tamper: ((rows: JournalEntry[]) => JournalEntry[]) | null = null;
    const store: AccountingStore = {
      transaction: (tenant, fn) =>
        real.transaction(tenant, (tx) =>
          fn({
            ...tx,
            listEntries: async (f, p) =>
              tamper ? tamper(await tx.listEntries(f, p)) : tx.listEntries(f, p),
          }),
        ),
    };
    const { svc, invoice } = setup(store);
    await invoice("p1", 100);
    await invoice("p1", 200);
    await invoice("p1", 300);

    tamper = (rows) =>
      rows.map((r, i) =>
        i === 1 ? { ...r, lines: r.lines.map((l) => ({ ...l, amount: l.amount + 1 })) } : r,
      );
    expect((await svc.verifyIntegrity(A)).error?.number).toBe(2);

    tamper = (rows) => rows.filter((_, i) => i !== 1);
    expect((await svc.verifyIntegrity(A)).error).toMatchObject({
      number: 3,
      reason: "Belegnummer lückenhaft",
    });

    tamper = (rows) => rows.map((r, i) => (i === 2 ? { ...r, description: "anders" } : r));
    expect((await svc.verifyIntegrity(A)).error?.number).toBe(3);

    tamper = null;
    expect((await svc.verifyIntegrity(A)).ok).toBe(true);
  });
});
