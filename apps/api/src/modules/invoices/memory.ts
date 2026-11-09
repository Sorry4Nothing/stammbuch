import { BillingError, type Invoice, frozenView } from "./domain.js";
import type { Reminder } from "./dunning.js";
import type {
  BillingSettings,
  InvoiceQuery,
  InvoiceRepository,
  ReminderRepository,
  SettingsRepository,
} from "./repository.js";

const key = (tenantId: string, id: string) => `${tenantId}/${id}`;

/** In-Memory-Umsetzung für Tests und lokale Entwicklung. Speichert Kopien, nie Referenzen. */
export class MemoryInvoiceRepository implements InvoiceRepository {
  private readonly rows = new Map<string, Invoice>();
  private readonly seqs = new Map<string, number>();

  async insert(invoice: Invoice) {
    const k = key(invoice.tenantId, invoice.id);
    if (this.rows.has(k)) throw new BillingError(409, "Beleg existiert bereits.");
    this.rows.set(k, structuredClone(invoice));
  }

  async update(invoice: Invoice, expectedVersion: number) {
    const k = key(invoice.tenantId, invoice.id);
    const cur = this.rows.get(k);
    if (!cur) throw new BillingError(404, "Beleg nicht gefunden.");
    if (cur.version !== expectedVersion)
      throw new BillingError(409, "Beleg wurde zwischenzeitlich geändert.");
    // Verteidigung in der Tiefe: ein gebuchter Beleg ändert sich ausser Zahlungen/Status nie.
    if (
      cur.status !== "draft" &&
      JSON.stringify(frozenView(cur)) !== JSON.stringify(frozenView(invoice))
    )
      throw new BillingError(409, "Gebuchte Belege sind unveränderlich.");
    this.rows.set(k, structuredClone(invoice));
  }

  async deleteDraft(tenantId: string, id: string) {
    const cur = this.rows.get(key(tenantId, id));
    if (!cur || cur.status !== "draft" || cur.number !== null) return false;
    return this.rows.delete(key(tenantId, id));
  }

  async get(tenantId: string, id: string) {
    const r = this.rows.get(key(tenantId, id));
    return r ? structuredClone(r) : null;
  }

  async list(tenantId: string, q: InvoiceQuery) {
    const all = [...this.rows.values()]
      .filter((i) => i.tenantId === tenantId)
      .filter((i) => (q.status ? i.status === q.status : true))
      .filter((i) => (q.kind ? i.kind === q.kind : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return {
      items: all.slice(q.offset, q.offset + q.limit).map((i) => structuredClone(i)),
      total: all.length,
    };
  }

  async creditNotesOf(tenantId: string, invoiceId: string) {
    return [...this.rows.values()]
      .filter(
        (i) => i.tenantId === tenantId && i.creditNoteOf === invoiceId && i.status !== "draft",
      )
      .map((i) => structuredClone(i));
  }

  async nextSeq(tenantId: string, kind: Invoice["kind"], year: number) {
    const k = `${tenantId}/${kind}/${year}`;
    const n = (this.seqs.get(k) ?? 0) + 1;
    this.seqs.set(k, n);
    return n;
  }

  async lastSeq(tenantId: string, kind: Invoice["kind"], year: number) {
    return this.seqs.get(`${tenantId}/${kind}/${year}`) ?? 0;
  }

  async findByRunAndPayer(tenantId: string, runId: string, payerKey: string) {
    const r = [...this.rows.values()].find(
      (i) => i.tenantId === tenantId && i.collectiveRunId === runId && i.payerKey === payerKey,
    );
    return r ? structuredClone(r) : null;
  }
}

export class MemoryReminderRepository implements ReminderRepository {
  private readonly rows: Reminder[] = [];

  async insert(r: Reminder) {
    if (
      this.rows.some(
        (x) => x.tenantId === r.tenantId && x.invoiceId === r.invoiceId && x.level === r.level,
      )
    )
      throw new BillingError(409, "Diese Mahnstufe wurde bereits erstellt.");
    this.rows.push(structuredClone(r));
  }

  async listByInvoice(tenantId: string, invoiceId: string) {
    return this.rows
      .filter((x) => x.tenantId === tenantId && x.invoiceId === invoiceId)
      .sort((a, b) => a.level - b.level)
      .map((x) => structuredClone(x));
  }
}

export class MemorySettingsRepository implements SettingsRepository {
  private readonly rows = new Map<string, BillingSettings>();
  async get(tenantId: string) {
    const s = this.rows.get(tenantId);
    return s ? structuredClone(s) : null;
  }
  async save(s: BillingSettings) {
    this.rows.set(s.tenantId, structuredClone(s));
  }
}
