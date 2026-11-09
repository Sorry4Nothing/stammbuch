import {
  ApiError,
  NotAvailableError,
  type AccountRow,
  type BuchhaltungService,
  type CamtPayment,
  type Entry,
  type ImportResult,
  type ImportSummary,
  type InvoiceInfo,
  type OpenInvoice,
  type PersonInfo,
  type PersonLedger,
  type ReminderInfo,
} from "./types";

export interface MemorySeed {
  accounts?: AccountRow[];
  entries?: Entry[];
  invoices?: OpenInvoice[];
  reminders?: Record<string, ReminderInfo[]>;
  rest?: CamtPayment[];
  imports?: ImportSummary[];
  ledgers?: Record<string, PersonLedger>;
  people?: Record<string, PersonInfo>;
  /** Ergebnis des nächsten Imports; ohne Angabe schlägt der Import fehl. */
  importResult?: Omit<ImportResult, "fileName" | "checksum" | "importedAt" | "importedBy">;
}

/**
 * Dienst im Speicher für Tests und die Entwicklung ohne API. Mutiert eine Kopie der Startdaten.
 * Dateien (Excel-Export, PDF-Auszug) kann er nicht erzeugen und meldet sie als nicht verfügbar.
 */
export function createMemoryBuchhaltungService(seed: MemorySeed = {}): BuchhaltungService {
  const accounts = [...(seed.accounts ?? [])];
  const entries = [...(seed.entries ?? [])];
  const imports = [...(seed.imports ?? [])];
  const reminders = { ...seed.reminders };
  let rest = [...(seed.rest ?? [])];
  let invoices = [...(seed.invoices ?? [])];
  const missing = (feature: string) => () => Promise.reject(new NotAvailableError(feature));

  return {
    listAccounts: () => Promise.resolve(accounts.map((a) => ({ ...a }))),
    createAccount(input) {
      if (accounts.some((a) => a.code === input.code)) {
        return Promise.reject(new ApiError(409, "CONFLICT", "Konto existiert bereits."));
      }
      accounts.push({ ...input, active: true, debit: 0, credit: 0, balance: 0 });
      return Promise.resolve();
    },
    renameAccount(code, name) {
      const i = accounts.findIndex((a) => a.code === code);
      if (i < 0) return Promise.reject(new ApiError(404, "NOT_FOUND"));
      accounts[i] = { ...accounts[i]!, name };
      return Promise.resolve();
    },
    setAccountTaxRate(code, taxRateBp) {
      const i = accounts.findIndex((a) => a.code === code);
      if (i < 0) return Promise.reject(new ApiError(404, "NOT_FOUND"));
      const next = { ...accounts[i]! };
      if (taxRateBp === null) delete next.taxRateBp;
      else next.taxRateBp = taxRateBp;
      accounts[i] = next;
      return Promise.resolve();
    },

    listEntries(q) {
      const rows = entries.filter(
        (e) =>
          (!q.from || e.bookingDate >= q.from) &&
          (!q.to || e.bookingDate <= q.to) &&
          (!q.accountCode || e.lines.some((l) => l.accountCode === q.accountCode)),
      );
      return Promise.resolve({
        items: rows.slice(q.offset, q.offset + q.limit),
        hasMore: rows.length > q.offset + q.limit,
        total: rows.length,
      });
    },
    reverseEntry(id, input) {
      const orig = entries.find((e) => e.id === id);
      if (!orig) return Promise.reject(new ApiError(404, "NOT_FOUND"));
      if (entries.some((e) => e.reversalOf === id)) {
        return Promise.reject(new ApiError(409, "CONFLICT", "Bereits storniert."));
      }
      entries.push({
        id: `rev-${id}`,
        number: Math.max(0, ...entries.map((e) => e.number)) + 1,
        bookingDate: input.bookingDate,
        kind: "reversal",
        description: `Storno Beleg ${orig.number}: ${input.reason}`,
        lines: orig.lines.map((l) => ({ ...l, side: l.side === "debit" ? "credit" : "debit" })),
        reversalOf: id,
        createdBy: "test",
      });
      return Promise.resolve();
    },

    listOpenInvoices: () => Promise.resolve(invoices.map((i) => ({ ...i }))),
    listReminders: (id) => Promise.resolve(reminders[id] ?? []),
    issueReminder(id) {
      const list = (reminders[id] ??= []);
      list.push({ level: list.length + 1, title: `${list.length + 1}. Mahnung` });
      return Promise.resolve();
    },
    getInvoice(id): Promise<InvoiceInfo | null> {
      const i = invoices.find((x) => x.id === id);
      return Promise.resolve(
        i ? { number: i.number, debtorName: i.debtorName, openRappen: i.openRappen } : null,
      );
    },

    listRest: () => Promise.resolve({ items: rest.map((p) => ({ ...p })), hasMore: false }),
    assignRest(paymentId, openItemId) {
      const p = rest.find((x) => x.id === paymentId);
      if (!p) return Promise.reject(new ApiError(404, "PAYMENT_NOT_FOUND"));
      if (!invoices.some((i) => i.id === openItemId)) {
        return Promise.reject(new ApiError(404, "OPEN_ITEM_NOT_FOUND"));
      }
      rest = rest.filter((x) => x.id !== paymentId);
      invoices = invoices.map((i) =>
        i.id === openItemId ? { ...i, openRappen: Math.max(0, i.openRappen - p.amountRappen) } : i,
      );
      return Promise.resolve();
    },
    postponePayment(paymentId, postponed = true) {
      if (!rest.some((x) => x.id === paymentId)) {
        return Promise.reject(new ApiError(404, "PAYMENT_NOT_FOUND"));
      }
      rest = rest.map((x) => {
        if (x.id !== paymentId) return x;
        const next = { ...x };
        if (postponed) next.postponed = true;
        else delete next.postponed;
        return next;
      });
      return Promise.resolve();
    },
    listImports: () => Promise.resolve(imports.map((i) => ({ ...i }))),
    importFile(file, checksum) {
      if (!seed.importResult) return Promise.reject(new ApiError(422, "INVALID_XML"));
      const result = {
        ...seed.importResult,
        fileName: file.name,
        checksum,
        importedAt: Date.now(),
        importedBy: "Test",
      };
      imports.unshift({
        importId: result.importId,
        kind: result.kind,
        messageId: file.name,
        importedAt: result.importedAt,
        importedBy: result.importedBy,
        counts: result.counts,
      });
      return Promise.resolve(result);
    },

    personLedger(personId) {
      const l = seed.ledgers?.[personId];
      return l ? Promise.resolve(l) : Promise.reject(new ApiError(404, "NOT_FOUND"));
    },
    getPerson: (personId) => Promise.resolve(seed.people?.[personId] ?? null),

    exportXlsx: missing("Export als .xlsx"),
    downloadStatement: missing("Kontoauszug als PDF"),
  };
}
