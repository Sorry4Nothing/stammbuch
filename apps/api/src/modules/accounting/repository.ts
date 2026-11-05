import type { Account, EntryKind, JournalEntry, Rappen, Side } from "./domain.js";

export interface Page {
  offset: number;
  limit: number;
}

export interface OpenItem {
  id: string;
  personId: string;
  reference: string;
  documentDate: string;
  dueDate: string;
  amount: Rappen;
  entryId: string;
  createdAt: string;
}
export interface OpenItemState extends OpenItem {
  /** Summe aller aktiven Zuordnungen. */
  allocated: Rappen;
  /** Rechnung wurde per Gegenbuchung storniert: nichts mehr offen. */
  reversed: boolean;
}

/** Guthaben-Posten auf dem Debitorenkonto: Zahlung oder Gutschrift, noch nicht (voll) zugeordnet. */
export interface Credit {
  id: string;
  kind: "payment" | "credit_note";
  personId: string;
  reference: string;
  valueDate: string;
  amount: Rappen;
  entryId: string;
  createdAt: string;
}
export interface CreditState extends Credit {
  allocated: Rappen;
  reversed: boolean;
}

/** Zuordnung Guthaben -> offener Posten. Nur anhängend; Aufhebung ist ein Eintrag mit negativem Betrag. */
export interface Allocation {
  id: string;
  creditId: string;
  openItemId: string;
  amount: Rappen;
  reversalOf: string | null;
  createdAt: string;
  createdBy: string;
}

export interface PeriodEvent {
  period: string;
  status: "closed" | "open";
  at: string;
  actor: string;
  reason: string | null;
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  action: string;
  objectType: string;
  objectId: string;
  /** Nur IDs und Beträge, keine Freitexte oder Personendaten (SR-50). */
  detail: Record<string, string | number | null>;
}

export interface IdempotencyRecord {
  requestHash: string;
  result: unknown;
}

export interface PersonLine {
  entryId: string;
  entryNumber: number;
  bookingDate: string;
  kind: EntryKind;
  description: string;
  side: Side;
  amount: Rappen;
  /** Forderung (positiv) bzw. Guthaben (negativ) nach dieser Zeile. */
  balanceAfter: Rappen;
}

export interface Totals {
  debit: Rappen;
  credit: Rappen;
}

export interface EntryFilter {
  from?: string;
  to?: string;
  accountCode?: string;
}

/**
 * Alle Operationen eines Mandanten innerhalb einer Transaktion. Der Mandant ist an die
 * Transaktion gebunden, nie Parameter: eine ID aus dem Request öffnet nie fremde Daten (SR-11).
 * Eine SQL-Implementierung führt `transaction` in einer DB-Transaktion mit Advisory-Lock je
 * Mandant aus, damit die Belegnummern lückenlos bleiben.
 */
export interface AccountingTx {
  listAccounts(): Promise<Account[]>;
  getAccount(code: string): Promise<Account | null>;
  insertAccount(account: Account): Promise<void>;

  lastEntry(): Promise<JournalEntry | null>;
  insertEntry(entry: JournalEntry): Promise<void>;
  getEntry(id: string): Promise<JournalEntry | null>;
  /** Gegenbuchung zu einer Buchung, falls vorhanden. */
  getReversalOf(entryId: string): Promise<JournalEntry | null>;
  /** Aufsteigend nach Belegnummer. */
  listEntries(filter: EntryFilter, page: Page): Promise<JournalEntry[]>;
  accountTotals(range: { from?: string; to?: string }): Promise<Map<string, Totals>>;
  /** Summen auf dem Debitoren-Sammelkonto je Person. */
  personTotals(personId?: string): Promise<Map<string, Totals>>;
  listPersonLines(personId: string, page: Page): Promise<PersonLine[]>;

  insertOpenItem(item: OpenItem): Promise<void>;
  getOpenItem(id: string): Promise<OpenItemState | null>;
  getOpenItemByEntry(entryId: string): Promise<OpenItemState | null>;
  listOpenItems(
    filter: { personId?: string; onlyOpen?: boolean },
    page: Page,
  ): Promise<OpenItemState[]>;

  insertCredit(credit: Credit): Promise<void>;
  getCredit(id: string): Promise<CreditState | null>;
  getCreditByEntry(entryId: string): Promise<CreditState | null>;
  listCredits(
    filter: { personId?: string; onlyUnallocated?: boolean },
    page: Page,
  ): Promise<CreditState[]>;

  insertAllocation(allocation: Allocation): Promise<void>;
  getAllocation(id: string): Promise<Allocation | null>;
  getAllocationReversal(id: string): Promise<Allocation | null>;
  listAllocations(filter: { creditId?: string; openItemId?: string }): Promise<Allocation[]>;

  appendPeriodEvent(event: PeriodEvent): Promise<void>;
  lastPeriodEvent(period: string): Promise<PeriodEvent | null>;
  listPeriodEvents(): Promise<PeriodEvent[]>;

  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(page: Page): Promise<AuditEvent[]>;

  getIdempotency(key: string): Promise<IdempotencyRecord | null>;
  putIdempotency(key: string, record: IdempotencyRecord): Promise<void>;
}

export interface AccountingStore {
  transaction<T>(tenantId: string, fn: (tx: AccountingTx) => Promise<T>): Promise<T>;
}

interface TenantData {
  accounts: Map<string, Account>;
  entries: JournalEntry[];
  openItems: OpenItem[];
  credits: Credit[];
  allocations: Allocation[];
  periodEvents: PeriodEvent[];
  audit: AuditEvent[];
  idempotency: Map<string, IdempotencyRecord>;
}

const emptyTenant = (): TenantData => ({
  accounts: new Map(),
  entries: [],
  openItems: [],
  credits: [],
  allocations: [],
  periodEvents: [],
  audit: [],
  idempotency: new Map(),
});

const slice = <T>(rows: T[], p: Page): T[] => rows.slice(p.offset, p.offset + p.limit);
const clone = <T>(v: T): T => structuredClone(v);
const signed = (side: Side, amount: Rappen): Rappen => (side === "debit" ? amount : -amount);

function bump(m: Map<string, Totals>, key: string, side: Side, amount: Rappen) {
  const t = m.get(key) ?? { debit: 0, credit: 0 };
  t[side] += amount;
  m.set(key, t);
}

function tenantTx(d: TenantData): AccountingTx {
  const reversed = (entryId: string) => d.entries.some((e) => e.reversalOf === entryId);
  const allocated = (key: "creditId" | "openItemId", id: string) =>
    d.allocations.filter((a) => a[key] === id).reduce((s, a) => s + a.amount, 0);
  const itemState = (i: OpenItem): OpenItemState => ({
    ...i,
    allocated: allocated("openItemId", i.id),
    reversed: reversed(i.entryId),
  });
  const creditState = (c: Credit): CreditState => ({
    ...c,
    allocated: allocated("creditId", c.id),
    reversed: reversed(c.entryId),
  });
  const orNull = <T, R>(v: T | undefined, f: (x: T) => R): R | null => (v ? clone(f(v)) : null);

  return {
    listAccounts: async () =>
      clone([...d.accounts.values()].sort((a, b) => a.code.localeCompare(b.code))),
    getAccount: async (code) => clone(d.accounts.get(code) ?? null),
    insertAccount: async (a) => void d.accounts.set(a.code, clone(a)),

    lastEntry: async () => clone(d.entries.at(-1) ?? null),
    insertEntry: async (e) => void d.entries.push(clone(e)),
    getEntry: async (id) => clone(d.entries.find((e) => e.id === id) ?? null),
    getReversalOf: async (id) => clone(d.entries.find((e) => e.reversalOf === id) ?? null),
    listEntries: async (f, page) =>
      clone(
        slice(
          d.entries.filter(
            (e) =>
              (!f.from || e.bookingDate >= f.from) &&
              (!f.to || e.bookingDate <= f.to) &&
              (!f.accountCode || e.lines.some((l) => l.accountCode === f.accountCode)),
          ),
          page,
        ),
      ),
    accountTotals: async ({ from, to }) => {
      const m = new Map<string, Totals>();
      for (const e of d.entries) {
        if ((from && e.bookingDate < from) || (to && e.bookingDate > to)) continue;
        for (const l of e.lines) bump(m, l.accountCode, l.side, l.amount);
      }
      return m;
    },
    personTotals: async (personId) => {
      const m = new Map<string, Totals>();
      for (const e of d.entries) {
        for (const l of e.lines) {
          if (l.personId && (!personId || l.personId === personId)) {
            bump(m, l.personId, l.side, l.amount);
          }
        }
      }
      return m;
    },
    listPersonLines: async (personId, page) => {
      let balance = 0;
      const rows: PersonLine[] = [];
      for (const e of d.entries) {
        for (const l of e.lines) {
          if (l.personId !== personId) continue;
          balance += signed(l.side, l.amount);
          rows.push({
            entryId: e.id,
            entryNumber: e.number,
            bookingDate: e.bookingDate,
            kind: e.kind,
            description: e.description,
            side: l.side,
            amount: l.amount,
            balanceAfter: balance,
          });
        }
      }
      return slice(rows, page);
    },

    insertOpenItem: async (i) => void d.openItems.push(clone(i)),
    getOpenItem: async (id) =>
      orNull(
        d.openItems.find((i) => i.id === id),
        itemState,
      ),
    getOpenItemByEntry: async (id) =>
      orNull(
        d.openItems.find((i) => i.entryId === id),
        itemState,
      ),
    listOpenItems: async (f, page) =>
      slice(
        d.openItems
          .filter((i) => !f.personId || i.personId === f.personId)
          .map(itemState)
          .filter((s) => !f.onlyOpen || (!s.reversed && s.amount - s.allocated > 0))
          .sort(
            (a, b) => a.dueDate.localeCompare(b.dueDate) || a.createdAt.localeCompare(b.createdAt),
          ),
        page,
      ),

    insertCredit: async (c) => void d.credits.push(clone(c)),
    getCredit: async (id) =>
      orNull(
        d.credits.find((c) => c.id === id),
        creditState,
      ),
    getCreditByEntry: async (id) =>
      orNull(
        d.credits.find((c) => c.entryId === id),
        creditState,
      ),
    listCredits: async (f, page) =>
      slice(
        d.credits
          .filter((c) => !f.personId || c.personId === f.personId)
          .map(creditState)
          .filter((s) => !f.onlyUnallocated || (!s.reversed && s.amount - s.allocated > 0)),
        page,
      ),

    insertAllocation: async (a) => void d.allocations.push(clone(a)),
    getAllocation: async (id) => clone(d.allocations.find((a) => a.id === id) ?? null),
    getAllocationReversal: async (id) =>
      clone(d.allocations.find((a) => a.reversalOf === id) ?? null),
    listAllocations: async (f) =>
      clone(
        d.allocations.filter(
          (a) =>
            (!f.creditId || a.creditId === f.creditId) &&
            (!f.openItemId || a.openItemId === f.openItemId),
        ),
      ),

    appendPeriodEvent: async (e) => void d.periodEvents.push(clone(e)),
    lastPeriodEvent: async (p) => clone(d.periodEvents.findLast((e) => e.period === p) ?? null),
    listPeriodEvents: async () => clone(d.periodEvents),

    appendAudit: async (e) => void d.audit.push(clone(e)),
    listAudit: async (page) => clone(slice(d.audit, page)),

    getIdempotency: async (k) => clone(d.idempotency.get(k) ?? null),
    putIdempotency: async (k, r) => void d.idempotency.set(k, clone(r)),
  };
}

/**
 * In-Memory-Implementierung für Tests und Entwicklung. Schreibvorgänge je Mandant laufen
 * nacheinander (Warteschlange). Es gibt kein Rollback: der Service prüft vor dem Schreiben.
 */
export function createMemoryStore(): AccountingStore {
  const tenants = new Map<string, TenantData>();
  const queues = new Map<string, Promise<unknown>>();
  return {
    transaction(tenantId, fn) {
      let data = tenants.get(tenantId);
      if (!data) tenants.set(tenantId, (data = emptyTenant()));
      const tx = tenantTx(data);
      const run = (queues.get(tenantId) ?? Promise.resolve()).then(() => fn(tx));
      queues.set(
        tenantId,
        run.catch(() => undefined),
      );
      return run;
    },
  };
}
