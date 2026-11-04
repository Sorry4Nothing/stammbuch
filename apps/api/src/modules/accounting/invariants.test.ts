import { describe, expect, it } from "vitest";
import { DomainError } from "./domain.js";
import { createMemoryStore } from "./repository.js";
import { AccountingService } from "./service.js";
import type { Ctx } from "./service.js";

const ctx: Ctx = { tenantId: "t", userId: "u" };
const page = { offset: 0, limit: 1000 };

/** Deterministischer Zufall, damit ein Fehlschlag reproduzierbar ist. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.each([1, 2, 3, 4, 5])("Zufallsfolge von Buchungen (Seed %i)", (seed) => {
  it("hält nach jeder Operation alle Invarianten ein", async () => {
    const rand = rng(seed);
    const pick = <T>(xs: T[]): T | undefined => xs[Math.floor(rand() * xs.length)];
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const svc = new AccountingService(createMemoryStore(), () => new Date("2026-06-15T10:00:00Z"));
    const persons = ["p1", "p2", "p3"];
    const entries: string[] = [];
    const allocations: string[] = [];
    let n = 0;
    const key = () => `prop-${seed}-${(n++).toString().padStart(6, "0")}`;
    const day = () => `2026-0${int(1, 6)}-${String(int(1, 28)).padStart(2, "0")}`;

    for (let step = 0; step < 150; step++) {
      try {
        const op = rand();
        if (op < 0.25) {
          const lines = Array.from({ length: int(1, 3) }, () => ({
            accountCode: pick(["3000", "3200", "2200"])!,
            amount: int(1, 500_000),
          }));
          const { result } = await svc.postReceivable(ctx, {
            idempotencyKey: key(),
            kind: "invoice",
            personId: pick(persons)!,
            reference: "R",
            bookingDate: "2026-01-01",
            dueDate: "2026-12-31",
            counterLines: lines,
          });
          entries.push(result.entry.id);
        } else if (op < 0.4) {
          const { result } = await svc.bookPayment(ctx, {
            idempotencyKey: key(),
            personId: pick(persons)!,
            bankAccountCode: "1020",
            valueDate: day(),
            amount: int(1, 800_000),
            reference: "Z",
          });
          entries.push(result.entry.id);
        } else if (op < 0.5) {
          const { result } = await svc.postReceivable(ctx, {
            idempotencyKey: key(),
            kind: "credit_note",
            personId: pick(persons)!,
            reference: "G",
            bookingDate: day(),
            counterLines: [{ accountCode: "3800", amount: int(1, 100_000) }],
          });
          entries.push(result.entry.id);
        } else if (op < 0.8) {
          const credit = pick(await svc.openCredits(ctx));
          if (credit) {
            const items = (
              await svc.listOpenItems(ctx, { personId: credit.personId, onlyOpen: true }, page)
            ).slice(0, int(1, 3));
            let left = credit.available;
            const allocs = items.flatMap((i) => {
              const amount = Math.min(left, int(1, i.remaining));
              left -= amount;
              return amount > 0 ? [{ openItemId: i.id, amount }] : [];
            });
            if (allocs.length > 0) {
              const { result } = await svc.allocate(ctx, {
                idempotencyKey: key(),
                creditId: credit.id,
                allocations: allocs,
              });
              allocations.push(...result.allocations.map((a) => a.id));
            }
          }
        } else if (op < 0.9) {
          const id = pick(allocations);
          if (id) await svc.reverseAllocation(ctx, id, key());
        } else {
          const id = pick(entries);
          if (id) {
            await svc.reverseEntry(ctx, id, {
              idempotencyKey: key(),
              bookingDate: "2026-06-30",
              reason: "Test",
            });
          }
        }
      } catch (e) {
        // Regelverletzungen sind erwartet; alles andere (TypeError, ...) ist ein Fehler.
        expect(e).toBeInstanceOf(DomainError);
      }

      const tb = await svc.trialBalance(ctx, {});
      expect(tb.debit).toBe(tb.credit); // Soll = Haben
      expect((await svc.reconcileDebtors(ctx)).difference).toBe(0); // Sammelkonto = Posten - Guthaben
      const items = await svc.listOpenItems(ctx, { onlyOpen: false }, page);
      for (const i of items) {
        expect(i.remaining).toBeGreaterThanOrEqual(0);
        expect(i.allocated).toBeGreaterThanOrEqual(0);
        expect(i.allocated).toBeLessThanOrEqual(i.amount);
      }
      const debtors = await svc.debtorList(ctx, { nonZero: false }, page);
      const control = tb.rows.find((r) => r.code === "1100")!.balance;
      expect(debtors.reduce((s, d) => s + d.balance, 0)).toBe(control); // Summe Debitorenkonten = Sammelkonto
    }
    expect((await svc.verifyIntegrity(ctx)).ok).toBe(true);
  });
});
