import { randomUUID } from "node:crypto";
import {
  DEBTOR_CONTROL_ACCOUNT,
  DEFAULT_CHART,
  DomainError,
  GENESIS_HASH,
  MAX_AMOUNT,
  assertBalanced,
  daysBetween,
  entryHash,
  normalSide,
  periodOf,
  retentionUntil,
  sha256,
  stableStringify,
} from "./domain.js";
import type { Account, EntryKind, EntryLine, JournalEntry, Rappen } from "./domain.js";
import type {
  AccountingStore,
  AccountingTx,
  Allocation,
  AuditEvent,
  Credit,
  OpenItem,
  OpenItemState,
  Page,
  PeriodEvent,
} from "./repository.js";
import type {
  AllocateInput,
  CreateAccountInput,
  ManualEntryInput,
  PaymentInput,
  ReceivableInput,
  ReturnPaymentInput,
  ReverseEntryInput,
} from "./schemas.js";

/** Akteur und Mandant stammen ausschliesslich aus der Authentifizierung, nie aus dem Request-Body. */
export interface Ctx {
  tenantId: string;
  userId: string;
}

/** `replayed`: die Anfrage mit diesem Idempotenzschlüssel lief schon, es wird das erste Ergebnis geliefert. */
export interface Idem<T> {
  result: T;
  replayed: boolean;
}

export type AgingBucket = "not_due" | "d0_30" | "d31_60" | "d61_90" | "d90_plus";

const NOT_FOUND = (what: string) => new DomainError("NOT_FOUND", `${what} nicht gefunden.`);
const RULE = (msg: string) => new DomainError("RULE_VIOLATION", msg);
const iso = (d: Date) => d.toISOString();

function bucket(overdueDays: number): AgingBucket {
  if (overdueDays <= 0) return "not_due";
  if (overdueDays <= 30) return "d0_30";
  if (overdueDays <= 60) return "d31_60";
  if (overdueDays <= 90) return "d61_90";
  return "d90_plus";
}

async function drain<T>(fetch: (p: Page) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const rows = await fetch({ offset, limit: 1000 });
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

export class AccountingService {
  constructor(
    private readonly store: AccountingStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private run<T>(ctx: Ctx, fn: (tx: AccountingTx) => Promise<T>): Promise<T> {
    return this.store.transaction(ctx.tenantId, async (tx) => {
      if (!(await tx.getAccount(DEBTOR_CONTROL_ACCOUNT))) {
        for (const a of DEFAULT_CHART) await tx.insertAccount({ ...a });
      }
      return fn(tx);
    });
  }

  private today = () => iso(this.now()).slice(0, 10);

  private async audit(
    tx: AccountingTx,
    ctx: Ctx,
    action: string,
    objectType: string,
    objectId: string,
    detail: AuditEvent["detail"] = {},
  ) {
    await tx.appendAudit({
      id: randomUUID(),
      at: iso(this.now()),
      actor: ctx.userId,
      action,
      objectType,
      objectId,
      detail,
    });
  }

  /** Gleicher Schlüssel + gleiche Anfrage = gleiches Ergebnis; gleicher Schlüssel + andere Anfrage = Konflikt. */
  private async once<T>(
    tx: AccountingTx,
    key: string,
    scope: string,
    payload: unknown,
    fn: () => Promise<T>,
  ): Promise<Idem<T>> {
    const requestHash = sha256(stableStringify([scope, payload]));
    const hit = await tx.getIdempotency(key);
    if (hit) {
      if (hit.requestHash !== requestHash) {
        throw new DomainError(
          "CONFLICT",
          "Der Idempotenzschlüssel gehört zu einer anderen Anfrage.",
        );
      }
      return { result: hit.result as T, replayed: true };
    }
    const result = await fn();
    await tx.putIdempotency(key, { requestHash, result });
    return { result, replayed: false };
  }

  private async assertPeriodOpen(tx: AccountingTx, date: string) {
    if ((await tx.lastPeriodEvent(periodOf(date)))?.status === "closed") {
      throw new DomainError("PERIOD_CLOSED", "Die Buchungsperiode ist abgeschlossen.");
    }
  }

  /** Einziger Weg, eine Buchung zu schreiben. Prüft alle Invarianten vor dem Schreiben. */
  private async postEntry(
    tx: AccountingTx,
    ctx: Ctx,
    p: {
      kind: EntryKind;
      bookingDate: string;
      description: string;
      lines: EntryLine[];
      reversalOf?: string;
    },
  ): Promise<JournalEntry> {
    assertBalanced(p.lines);
    for (const l of p.lines) {
      const account = await tx.getAccount(l.accountCode);
      if (!account?.active) throw RULE("Unbekanntes oder inaktives Konto.");
      if ((l.accountCode === DEBTOR_CONTROL_ACCOUNT) !== (l.personId !== undefined)) {
        throw RULE("Das Debitoren-Sammelkonto braucht eine Person, andere Konten nicht.");
      }
    }
    await this.assertPeriodOpen(tx, p.bookingDate);

    const last = await tx.lastEntry();
    const base = {
      number: (last?.number ?? 0) + 1,
      bookingDate: p.bookingDate,
      kind: p.kind,
      description: p.description,
      lines: p.lines.map((l) => ({
        accountCode: l.accountCode,
        side: l.side,
        amount: l.amount,
        ...(l.personId === undefined ? {} : { personId: l.personId }),
      })),
      reversalOf: p.reversalOf ?? null,
      createdAt: iso(this.now()),
      createdBy: ctx.userId,
      retentionUntil: retentionUntil(p.bookingDate),
      prevHash: last?.hash ?? GENESIS_HASH,
    };
    const entry: JournalEntry = { id: randomUUID(), ...base, hash: entryHash(ctx.tenantId, base) };
    await tx.insertEntry(entry);
    await this.audit(tx, ctx, "entry.posted", "entry", entry.id, {
      number: entry.number,
      kind: entry.kind,
      bookingDate: entry.bookingDate,
    });
    return entry;
  }

  // ---- Kontenplan ----------------------------------------------------------------------

  listAccounts(ctx: Ctx): Promise<Account[]> {
    return this.run(ctx, (tx) => tx.listAccounts());
  }

  createAccount(ctx: Ctx, input: CreateAccountInput): Promise<Account> {
    return this.run(ctx, async (tx) => {
      if (await tx.getAccount(input.code))
        throw new DomainError("CONFLICT", "Konto existiert bereits.");
      const account: Account = { ...input, active: true };
      await tx.insertAccount(account);
      await this.audit(tx, ctx, "account.created", "account", account.code, { type: account.type });
      return account;
    });
  }

  // ---- Buchungen -----------------------------------------------------------------------

  /** Freie Buchung. Das Debitoren-Sammelkonto ist gesperrt: dafür gibt es Rechnung und Zahlung. */
  postManualEntry(ctx: Ctx, input: ManualEntryInput): Promise<Idem<JournalEntry>> {
    const { idempotencyKey, ...payload } = input;
    return this.run(ctx, (tx) =>
      this.once(tx, idempotencyKey, "manual", payload, () => {
        if (input.lines.some((l) => l.accountCode === DEBTOR_CONTROL_ACCOUNT)) {
          throw RULE("Debitoren werden nur über Rechnungen und Zahlungen gebucht.");
        }
        return this.postEntry(tx, ctx, {
          kind: "manual",
          bookingDate: input.bookingDate,
          description: input.description,
          lines: input.lines,
        });
      }),
    );
  }

  /** Rechnung (Soll Debitoren) oder Gutschrift (Haben Debitoren) einer Person buchen. */
  postReceivable(
    ctx: Ctx,
    input: ReceivableInput,
  ): Promise<Idem<{ entry: JournalEntry; openItem: OpenItem | null; credit: Credit | null }>> {
    const { idempotencyKey, ...payload } = input;
    return this.run(ctx, (tx) =>
      this.once(tx, idempotencyKey, "receivable", payload, async () => {
        const invoice = input.kind === "invoice";
        let total = 0;
        for (const c of input.counterLines) {
          const type = (await tx.getAccount(c.accountCode))?.type;
          if (type !== "revenue" && type !== "expense" && type !== "liability") {
            throw RULE("Gegenkonto muss ein Erlös-, Aufwand- oder Passivkonto sein.");
          }
          total += c.amount;
        }
        if (total > MAX_AMOUNT) throw RULE("Betrag zu gross.");

        const entry = await this.postEntry(tx, ctx, {
          kind: input.kind,
          bookingDate: input.bookingDate,
          description:
            input.description ?? `${invoice ? "Rechnung" : "Gutschrift"} ${input.reference}`,
          lines: [
            {
              accountCode: DEBTOR_CONTROL_ACCOUNT,
              side: invoice ? "debit" : "credit",
              amount: total,
              personId: input.personId,
            },
            ...input.counterLines.map((c) => ({
              accountCode: c.accountCode,
              side: invoice ? ("credit" as const) : ("debit" as const),
              amount: c.amount,
            })),
          ],
        });
        const base = {
          id: randomUUID(),
          personId: input.personId,
          reference: input.reference,
          amount: total,
          entryId: entry.id,
          createdAt: entry.createdAt,
        };
        if (invoice) {
          const openItem: OpenItem = {
            ...base,
            documentDate: input.bookingDate,
            dueDate: input.dueDate ?? input.bookingDate,
          };
          await tx.insertOpenItem(openItem);
          return { entry, openItem, credit: null };
        }
        const credit: Credit = { ...base, kind: "credit_note", valueDate: input.bookingDate };
        await tx.insertCredit(credit);
        return { entry, openItem: null, credit };
      }),
    );
  }

  /** Zahlungseingang buchen (Soll Bank, Haben Debitoren). Zuordnung zu Rechnungen separat. */
  bookPayment(
    ctx: Ctx,
    input: PaymentInput,
  ): Promise<Idem<{ entry: JournalEntry; credit: Credit }>> {
    const { idempotencyKey, ...payload } = input;
    return this.run(ctx, (tx) =>
      this.once(tx, idempotencyKey, "payment", payload, async () => {
        const bank = await tx.getAccount(input.bankAccountCode);
        if (bank?.type !== "asset" || !/^10\d{2,4}$/.test(bank.code)) {
          throw RULE("Zahlungen werden auf einem Konto der flüssigen Mittel (10xx) gebucht.");
        }
        const entry = await this.postEntry(tx, ctx, {
          kind: "payment",
          bookingDate: input.valueDate,
          description: `Zahlung ${input.reference}`,
          lines: [
            { accountCode: bank.code, side: "debit", amount: input.amount },
            {
              accountCode: DEBTOR_CONTROL_ACCOUNT,
              side: "credit",
              amount: input.amount,
              personId: input.personId,
            },
          ],
        });
        const credit: Credit = {
          id: randomUUID(),
          kind: "payment",
          personId: input.personId,
          reference: input.reference,
          valueDate: input.valueDate,
          amount: input.amount,
          entryId: entry.id,
          createdAt: entry.createdAt,
        };
        await tx.insertCredit(credit);
        await this.audit(tx, ctx, "payment.booked", "credit", credit.id, { amount: credit.amount });
        return { entry, credit };
      }),
    );
  }

  /** Storno = Gegenbuchung mit vertauschten Seiten. Das Original bleibt unverändert bestehen. */
  reverseEntry(ctx: Ctx, entryId: string, input: ReverseEntryInput): Promise<Idem<JournalEntry>> {
    const { idempotencyKey, ...payload } = input;
    return this.run(ctx, (tx) =>
      this.once(tx, idempotencyKey, `reverse:${entryId}`, payload, () =>
        this.reverseEntryIn(tx, ctx, entryId, input),
      ),
    );
  }

  private async reverseEntryIn(
    tx: AccountingTx,
    ctx: Ctx,
    entryId: string,
    input: { bookingDate: string; reason: string },
  ): Promise<JournalEntry> {
    const orig = await tx.getEntry(entryId);
    if (!orig) throw NOT_FOUND("Buchung");
    if (orig.kind === "reversal") throw RULE("Eine Stornobuchung kann nicht storniert werden.");
    if (await tx.getReversalOf(orig.id)) throw new DomainError("CONFLICT", "Bereits storniert.");
    if (input.bookingDate < orig.bookingDate) {
      throw RULE("Das Stornodatum darf nicht vor der Originalbuchung liegen.");
    }
    const linked = (await tx.getOpenItemByEntry(orig.id)) ?? (await tx.getCreditByEntry(orig.id));
    if (linked && linked.allocated !== 0) {
      throw RULE("Zuerst die Zuordnungen dieses Belegs aufheben.");
    }
    const reversal = await this.postEntry(tx, ctx, {
      kind: "reversal",
      bookingDate: input.bookingDate,
      description: `Storno Beleg ${orig.number}: ${input.reason}`.slice(0, 200),
      reversalOf: orig.id,
      lines: orig.lines.map((l) => ({
        ...l,
        side: l.side === "debit" ? ("credit" as const) : ("debit" as const),
      })),
    });
    await this.audit(tx, ctx, "entry.reversed", "entry", orig.id, { reversalId: reversal.id });
    return reversal;
  }

  /**
   * Rückbuchung einer Zahlung (Rücklastschrift, Bankstorno): die Zahlung wird vollständig spiegelbildlich storniert
   * (Soll Debitoren, Haben Bank) und alle ihre Zuordnungen werden aufgehoben, damit die offenen Posten wieder offen
   * sind. Die Zahlung wird über den Idempotenzschlüssel ihrer Buchung gefunden (`paymentKey`). Alles läuft in einer
   * Transaktion; vor dem ersten Schreiben sind Periode und Datum geprüft, damit auch der Speicher ohne Rollback
   * nichts halb schreibt. Die Zuordnungen auf andere Posten der Person entfallen mit: die Zahlung gilt als nie erfolgt.
   */
  returnPayment(
    ctx: Ctx,
    input: ReturnPaymentInput,
  ): Promise<Idem<{ entry: JournalEntry; reopenedAmount: Rappen }>> {
    const { idempotencyKey, ...payload } = input;
    return this.run(ctx, (tx) =>
      this.once(tx, idempotencyKey, "payment-return", payload, async () => {
        const booked = (await tx.getIdempotency(input.paymentKey))?.result as
          { credit?: { id?: unknown } } | undefined;
        const creditId = booked?.credit?.id;
        const credit = typeof creditId === "string" ? await tx.getCredit(creditId) : null;
        if (credit?.kind !== "payment") {
          throw RULE("Die Zahlung ist in der Buchhaltung nicht gebucht.");
        }
        if (credit.reversed) {
          throw new DomainError("CONFLICT", "Die Zahlung ist bereits zurückgebucht.");
        }
        const original = await tx.getEntry(credit.entryId);
        if (!original) throw NOT_FOUND("Buchung");
        if (input.bookingDate < original.bookingDate) {
          throw RULE("Das Rückbuchungsdatum darf nicht vor der Zahlung liegen.");
        }
        await this.assertPeriodOpen(tx, input.bookingDate);

        let reopenedAmount: Rappen = 0;
        for (const a of await tx.listAllocations({ creditId: credit.id })) {
          if (a.reversalOf !== null || (await tx.getAllocationReversal(a.id))) continue;
          await this.reverseAllocationIn(tx, ctx, a.id);
          reopenedAmount += a.amount;
        }
        const entry = await this.reverseEntryIn(tx, ctx, original.id, {
          bookingDate: input.bookingDate,
          reason: input.reason,
        });
        await this.audit(tx, ctx, "payment.returned", "credit", credit.id, {
          amount: credit.amount,
          reopened: reopenedAmount,
        });
        return { entry, reopenedAmount };
      }),
    );
  }

  async getEntry(ctx: Ctx, id: string) {
    return this.run(ctx, async (tx) => {
      const entry = await tx.getEntry(id);
      if (!entry) throw NOT_FOUND("Buchung");
      return { entry, reversedBy: (await tx.getReversalOf(id))?.id ?? null };
    });
  }

  /**
   * Buchungen zu Idempotenzschlüsseln (z. B. alle Buchungen einer Rechnung), aufsteigend nach Belegnummer. Schlüssel
   * ohne Buchung entfallen. Nur lesend; die Konten dazu liefert `listAccounts`.
   */
  entriesByKeys(ctx: Ctx, keys: readonly string[]): Promise<JournalEntry[]> {
    return this.run(ctx, async (tx) => {
      const found = new Map<string, JournalEntry>();
      for (const key of keys) {
        const hit = (await tx.getIdempotency(key))?.result as
          { entry?: { id?: unknown } } | undefined;
        const id = hit?.entry?.id;
        const entry = typeof id === "string" ? await tx.getEntry(id) : null;
        if (entry) found.set(entry.id, entry);
      }
      return [...found.values()].sort((a, b) => a.number - b.number);
    });
  }

  listEntries(ctx: Ctx, filter: { from?: string; to?: string; accountCode?: string }, page: Page) {
    return this.run(ctx, (tx) => tx.listEntries(filter, page));
  }

  // ---- Zahlungszuordnung ---------------------------------------------------------------

  /**
   * Manuelle Zuordnung eines Guthabens (Zahlung/Gutschrift) auf offene Posten derselben Person.
   * Teilzahlung: Betrag kleiner als der Posten. Mehrzahlung: Posten mehrerer Rechnungen.
   * Überzahlung: der nicht zugeordnete Rest bleibt als Guthaben auf dem Debitorenkonto.
   */
  allocate(ctx: Ctx, input: AllocateInput): Promise<Idem<{ allocations: Allocation[] }>> {
    const { idempotencyKey, ...payload } = input;
    return this.run(ctx, (tx) =>
      this.once(tx, idempotencyKey, "allocate", payload, async () => {
        const credit = await tx.getCredit(input.creditId);
        if (!credit) throw NOT_FOUND("Zahlung");
        if (credit.reversed) throw RULE("Die Zahlung ist storniert.");
        if (new Set(input.allocations.map((a) => a.openItemId)).size !== input.allocations.length) {
          throw RULE("Jeder offene Posten darf nur einmal vorkommen.");
        }
        const total = input.allocations.reduce((s, a) => s + a.amount, 0);
        if (total > credit.amount - credit.allocated) {
          throw RULE("Der Betrag übersteigt das nicht zugeordnete Guthaben.");
        }
        for (const a of input.allocations) {
          const item = await tx.getOpenItem(a.openItemId);
          if (!item) throw NOT_FOUND("Offener Posten");
          if (item.personId !== credit.personId) {
            throw RULE("Zahlung und offener Posten gehören zu verschiedenen Personen.");
          }
          if (item.reversed) throw RULE("Die Rechnung ist storniert.");
          if (a.amount > item.amount - item.allocated) {
            throw RULE("Der Betrag übersteigt den offenen Rest des Postens.");
          }
        }
        const allocations: Allocation[] = [];
        for (const a of input.allocations) {
          const row: Allocation = {
            id: randomUUID(),
            creditId: credit.id,
            openItemId: a.openItemId,
            amount: a.amount,
            reversalOf: null,
            createdAt: iso(this.now()),
            createdBy: ctx.userId,
          };
          await tx.insertAllocation(row);
          await this.audit(tx, ctx, "allocation.created", "allocation", row.id, {
            creditId: row.creditId,
            openItemId: row.openItemId,
            amount: row.amount,
          });
          allocations.push(row);
        }
        return { allocations };
      }),
    );
  }

  reverseAllocation(
    ctx: Ctx,
    allocationId: string,
    idempotencyKey: string,
  ): Promise<Idem<{ allocation: Allocation }>> {
    return this.run(ctx, (tx) =>
      this.once(tx, idempotencyKey, `unallocate:${allocationId}`, {}, async () => ({
        allocation: await this.reverseAllocationIn(tx, ctx, allocationId),
      })),
    );
  }

  private async reverseAllocationIn(
    tx: AccountingTx,
    ctx: Ctx,
    allocationId: string,
  ): Promise<Allocation> {
    const orig = await tx.getAllocation(allocationId);
    if (!orig) throw NOT_FOUND("Zuordnung");
    if (orig.reversalOf !== null) throw RULE("Eine Aufhebung kann nicht aufgehoben werden.");
    if (await tx.getAllocationReversal(orig.id)) {
      throw new DomainError("CONFLICT", "Zuordnung ist bereits aufgehoben.");
    }
    const allocation: Allocation = {
      ...orig,
      id: randomUUID(),
      amount: -orig.amount,
      reversalOf: orig.id,
      createdAt: iso(this.now()),
      createdBy: ctx.userId,
    };
    await tx.insertAllocation(allocation);
    await this.audit(tx, ctx, "allocation.reversed", "allocation", orig.id, {
      reversalId: allocation.id,
      amount: orig.amount,
    });
    return allocation;
  }

  // ---- Offene Posten, Debitoren, Salden ------------------------------------------------

  listOpenItems(
    ctx: Ctx,
    filter: { personId?: string; onlyOpen: boolean; asOf?: string },
    page: Page,
  ) {
    const asOf = filter.asOf ?? this.today();
    return this.run(ctx, async (tx) =>
      (await tx.listOpenItems(filter, page)).map((i) => this.openItemView(i, asOf)),
    );
  }

  private openItemView(i: OpenItemState, asOf: string) {
    const remaining = i.reversed ? 0 : i.amount - i.allocated;
    const overdueDays = remaining > 0 ? Math.max(0, daysBetween(i.dueDate, asOf)) : 0;
    return {
      id: i.id,
      personId: i.personId,
      reference: i.reference,
      documentDate: i.documentDate,
      dueDate: i.dueDate,
      amount: i.amount,
      allocated: i.allocated,
      remaining,
      status: i.reversed
        ? ("reversed" as const)
        : remaining === 0
          ? ("paid" as const)
          : i.allocated > 0
            ? ("partial" as const)
            : ("open" as const),
      overdueDays,
      agingBucket: bucket(overdueDays),
    };
  }

  /** Zahlungen und Gutschriften mit noch nicht zugeordnetem Rest (Grundlage der manuellen Zuordnung). */
  openCredits(
    ctx: Ctx,
    filter: { personId?: string } = {},
    page: Page = { offset: 0, limit: 200 },
  ) {
    return this.run(ctx, async (tx) =>
      (await tx.listCredits({ ...filter, onlyUnallocated: true }, page)).map((c) => ({
        id: c.id,
        kind: c.kind,
        personId: c.personId,
        reference: c.reference,
        valueDate: c.valueDate,
        amount: c.amount,
        available: c.amount - c.allocated,
      })),
    );
  }

  /** Debitorenkonto einer Person: Saldo (positiv = Forderung, negativ = Guthaben), offene Posten, Guthaben, Zeilen. */
  personLedger(ctx: Ctx, personId: string, page: Page) {
    return this.run(ctx, async (tx) => {
      const t = (await tx.personTotals(personId)).get(personId) ?? { debit: 0, credit: 0 };
      const asOf = this.today();
      const unallocated = (
        await tx.listCredits({ personId, onlyUnallocated: true }, { offset: 0, limit: 200 })
      ).map((c) => ({
        id: c.id,
        kind: c.kind,
        reference: c.reference,
        valueDate: c.valueDate,
        amount: c.amount,
        available: c.amount - c.allocated,
      }));
      return {
        personId,
        balance: t.debit - t.credit,
        debit: t.debit,
        credit: t.credit,
        openItems: (
          await tx.listOpenItems({ personId, onlyOpen: true }, { offset: 0, limit: 200 })
        ).map((i) => this.openItemView(i, asOf)),
        unallocatedCredits: unallocated,
        lines: await tx.listPersonLines(personId, page),
      };
    });
  }

  /** Debitorenliste: Saldo je Person, grösste Forderung zuerst. */
  debtorList(ctx: Ctx, opts: { nonZero: boolean }, page: Page) {
    return this.run(ctx, async (tx) => {
      const rows = [...(await tx.personTotals()).entries()]
        .map(([personId, t]) => ({
          personId,
          balance: t.debit - t.credit,
          debit: t.debit,
          credit: t.credit,
        }))
        .filter((r) => !opts.nonZero || r.balance !== 0)
        .sort((a, b) => b.balance - a.balance || a.personId.localeCompare(b.personId));
      return rows.slice(page.offset, page.offset + page.limit);
    });
  }

  /** Saldenliste. `balanced` ist die Probe: Summe Soll = Summe Haben. */
  trialBalance(ctx: Ctx, range: { from?: string; to?: string }) {
    return this.run(ctx, async (tx) => {
      const totals = await tx.accountTotals(range);
      const rows = (await tx.listAccounts()).map((a) => {
        const t = totals.get(a.code) ?? { debit: 0, credit: 0 };
        return {
          code: a.code,
          name: a.name,
          type: a.type,
          debit: t.debit,
          credit: t.credit,
          balance: normalSide(a.type) === "debit" ? t.debit - t.credit : t.credit - t.debit,
        };
      });
      const debit = rows.reduce((s, r) => s + r.debit, 0);
      const credit = rows.reduce((s, r) => s + r.credit, 0);
      return { rows, debit, credit, balanced: debit === credit };
    });
  }

  /** Abstimmung: Saldo Sammelkonto = offene Posten - nicht zugeordnete Guthaben. Differenz muss 0 sein. */
  reconcileDebtors(ctx: Ctx) {
    return this.run(ctx, async (tx) => {
      const t = (await tx.accountTotals({})).get(DEBTOR_CONTROL_ACCOUNT) ?? { debit: 0, credit: 0 };
      const open = await drain((p) => tx.listOpenItems({ onlyOpen: true }, p));
      const credits = await drain((p) => tx.listCredits({ onlyUnallocated: true }, p));
      const openItems = open.reduce((s, i) => s + (i.amount - i.allocated), 0);
      const unallocatedCredits = credits.reduce((s, c) => s + (c.amount - c.allocated), 0);
      const ledger: Rappen = t.debit - t.credit;
      return {
        ledger,
        openItems,
        unallocatedCredits,
        difference: ledger - (openItems - unallocatedCredits),
      };
    });
  }

  // ---- Perioden ------------------------------------------------------------------------

  async listPeriods(ctx: Ctx) {
    return this.run(ctx, async (tx) => {
      const latest = new Map<string, PeriodEvent>();
      for (const e of await tx.listPeriodEvents()) latest.set(e.period, e);
      return [...latest.values()].sort((a, b) => a.period.localeCompare(b.period));
    });
  }

  closePeriod(ctx: Ctx, period: string) {
    return this.run(ctx, async (tx) => {
      if (period > periodOf(this.today()))
        throw RULE("Zukünftige Perioden können nicht abgeschlossen werden.");
      if ((await tx.lastPeriodEvent(period))?.status === "closed") {
        throw new DomainError("CONFLICT", "Periode ist bereits abgeschlossen.");
      }
      const event: PeriodEvent = {
        period,
        status: "closed",
        at: iso(this.now()),
        actor: ctx.userId,
        reason: null,
      };
      await tx.appendPeriodEvent(event);
      await this.audit(tx, ctx, "period.closed", "period", period);
      return event;
    });
  }

  /** Wiederöffnen ist möglich, aber nur mit Begründung und Protokolleintrag. */
  reopenPeriod(ctx: Ctx, period: string, reason: string) {
    return this.run(ctx, async (tx) => {
      if ((await tx.lastPeriodEvent(period))?.status !== "closed") {
        throw new DomainError("CONFLICT", "Periode ist nicht abgeschlossen.");
      }
      const event: PeriodEvent = {
        period,
        status: "open",
        at: iso(this.now()),
        actor: ctx.userId,
        reason,
      };
      await tx.appendPeriodEvent(event);
      await this.audit(tx, ctx, "period.reopened", "period", period);
      return event;
    });
  }

  // ---- Protokoll und Integrität --------------------------------------------------------

  listAudit(ctx: Ctx, page: Page) {
    return this.run(ctx, (tx) => tx.listAudit(page));
  }

  /** Prüft Belegnummern, Hash-Kette und Soll=Haben über das ganze Journal (GeBüV-Integritätsprüfung). */
  verifyIntegrity(ctx: Ctx) {
    return this.run(ctx, async (tx) => {
      let expected = 1;
      let prevHash = GENESIS_HASH;
      let error: { number: number; reason: string } | null = null;
      const entries = await drain((p) => tx.listEntries({}, p));
      for (const e of entries) {
        if (e.number !== expected) error = { number: e.number, reason: "Belegnummer lückenhaft" };
        else if (e.prevHash !== prevHash)
          error = { number: e.number, reason: "Kette unterbrochen" };
        else if (entryHash(ctx.tenantId, e) !== e.hash)
          error = { number: e.number, reason: "Inhalt verändert" };
        else {
          try {
            assertBalanced(e.lines);
          } catch {
            error = { number: e.number, reason: "Soll und Haben ungleich" };
          }
        }
        if (error) break;
        expected++;
        prevHash = e.hash;
      }
      const result = { ok: error === null, checked: entries.length, error };
      await this.audit(tx, ctx, "integrity.checked", "journal", ctx.tenantId, {
        ok: result.ok ? 1 : 0,
        checked: result.checked,
      });
      return result;
    });
  }
}
