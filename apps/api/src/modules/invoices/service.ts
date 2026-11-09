import { randomUUID } from "node:crypto";
import {
  BillingError,
  DEFAULT_REVENUE_ACCOUNT,
  type Invoice,
  type InvoiceLine,
  MEMBERSHIP_REVENUE_ACCOUNT,
  type Payment,
  computeTotals,
  deriveStatus,
  openCents,
  paidCents,
  unreturnedPayments,
} from "./domain.js";
import {
  DEFAULT_DUNNING,
  type DunningLevel,
  type Reminder,
  buildReminder,
  nextDueLevel,
  validateDunningConfig,
} from "./dunning.js";
import { isQrIban, isSwissOrLiIban, normalizeIban } from "./iban.js";
import { type Cents, addDays } from "./money.js";
import { renderInvoicePdf, renderReminderPdf } from "./pdf/documents.js";
import { QrBillError, buildQrPayload } from "./qrbill.js";
import { makeQrr, makeScor } from "./reference.js";
import type {
  AccountingPort,
  BillingSettings,
  InvoiceQuery,
  InvoiceRepository,
  ReminderRepository,
  SettingsRepository,
} from "./repository.js";
import type { CollectiveInput, InvoiceInput, LineInput, SettingsInput } from "./schemas.js";

export interface Repositories {
  invoices: InvoiceRepository;
  reminders: ReminderRepository;
  settings: SettingsRepository;
}

/** Repositories einer Transaktion, optional mit der Buchhaltung auf derselben Transaktion. */
export interface TransactionRepositories extends Repositories {
  accounting?: AccountingPort;
}

export interface ServiceDeps extends Repositories {
  /**
   * Führt `fn` mit Repositories aus, die alle in einer Datenbanktransaktion laufen (Postgres).
   * Bei einem Fehler wird alles zurückgerollt, auch eine vergebene Rechnungsnummer: so bleiben
   * die Nummern lückenlos. Ohne Angabe (In-Memory) laufen die Schritte einzeln. `userId` ist der Handelnde
   * (für die Buchhaltung, die Buchungen und Protokoll ihm zuordnet); Umsetzungen mit Buchhaltung verlangen ihn.
   */
  transaction?: <T>(
    tenantId: string,
    fn: (repos: TransactionRepositories) => Promise<T>,
    userId?: string,
  ) => Promise<T>;
  /** Anbindung der Buchhaltung (Issue #8). Ohne Angabe wird nichts gebucht. */
  accounting?: AccountingPort;
  now?: () => Date;
  newId?: () => string;
}

/** Beleg samt abgeleiteten Beträgen, wie ihn die API ausgibt. */
export interface InvoiceView {
  invoice: Invoice;
  paidCents: Cents;
  creditedCents: Cents;
  openCents: Cents;
}

export interface DunningCandidate {
  invoiceId: string;
  number: string | null;
  dueDate: string;
  openCents: Cents;
  nextLevel: DunningLevel;
}

/** Offener Posten für die Startseite: versendete Rechnung mit Restbetrag und Schuldner. */
export interface OpenItemRow {
  invoiceId: string;
  number: string | null;
  debtor: string;
  openCents: Cents;
  currency: Invoice["currency"];
  dueDate: string;
}

export interface OpenItemsSummary {
  /** Die ersten Posten nach Fälligkeit (älteste zuerst). */
  items: OpenItemRow[];
  /** Alle offenen Posten. */
  total: number;
  /** Davon überfällig (Fälligkeit vor heute). */
  overdue: number;
}

const SEQ_MAX = 999_999;

export class InvoiceService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly deps: ServiceDeps,
    /** Innerhalb einer Transaktion: nicht noch einmal eine öffnen. */
    private readonly inTransaction = false,
  ) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  /** Schreibende Abläufe über mehrere Repository-Aufrufe laufen als eine Einheit (alles oder nichts). */
  private atomic<T>(
    tenantId: string,
    fn: (s: InvoiceService) => Promise<T>,
    userId?: string,
  ): Promise<T> {
    const tx = this.deps.transaction;
    if (!tx || this.inTransaction) return fn(this);
    return tx(
      tenantId,
      (repos) => fn(new InvoiceService({ ...this.deps, ...repos }, true)),
      userId,
    );
  }

  /** Heutiges Datum in der Schweiz (Fälligkeiten und Fristen zählen nach Ortszeit). */
  today(): string {
    return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(this.now());
  }

  // --- Einstellungen -------------------------------------------------------------------------

  async getSettings(tenantId: string): Promise<BillingSettings | null> {
    return this.deps.settings.get(tenantId);
  }

  /** `userId` ist nur nötig, wenn ein Standard-Erlöskonto gesetzt wird: es wird gegen den Kontenplan geprüft. */
  saveSettings(tenantId: string, input: SettingsInput, userId?: string): Promise<BillingSettings> {
    return this.atomic(
      tenantId,
      (s) => s.saveSettingsNow(tenantId, input),
      input.defaultRevenueAccount ? userId : undefined,
    );
  }

  private async saveSettingsNow(tenantId: string, input: SettingsInput): Promise<BillingSettings> {
    if (!isSwissOrLiIban(input.iban))
      throw new BillingError(422, "IBAN ist keine gültige CH/LI-IBAN.");
    const existing = await this.deps.settings.get(tenantId);
    const dunning = input.dunning ?? existing?.dunning ?? DEFAULT_DUNNING;
    validateDunningConfig(dunning);
    if (input.defaultRevenueAccount) {
      await this.deps.accounting?.assertRevenueAccounts([input.defaultRevenueAccount]);
    }
    const settings: BillingSettings = {
      tenantId,
      creditor: input.creditor,
      iban: normalizeIban(input.iban),
      vatNumber: input.vatNumber,
      contactLines: input.contactLines,
      numberPrefix: input.numberPrefix,
      creditNotePrefix: input.creditNotePrefix,
      referencePrefix: input.referencePrefix,
      paymentTermDays: input.paymentTermDays,
      defaultVatMode: input.defaultVatMode,
      defaultVatRateBp: input.defaultVatRateBp,
      roundTo5: input.roundTo5,
      defaultRevenueAccount: input.defaultRevenueAccount,
      dunning,
      features: existing?.features ?? { collectiveInvoicing: false },
    };
    // Probelauf: Empfängeradresse und IBAN müssen einen gültigen QR-Payload ergeben.
    try {
      buildQrPayload({
        iban: settings.iban,
        creditor: settings.creditor,
        amountCents: null,
        currency: "CHF",
        referenceType: isQrIban(settings.iban) ? "QRR" : "NON",
        reference: isQrIban(settings.iban) ? makeQrr("1") : undefined,
      });
    } catch (e) {
      if (e instanceof QrBillError) throw new BillingError(422, e.message);
      throw e;
    }
    await this.deps.settings.save(settings);
    return settings;
  }

  async setFeatures(
    tenantId: string,
    features: BillingSettings["features"],
  ): Promise<BillingSettings> {
    const s = await this.requireSettings(tenantId);
    s.features = features;
    await this.deps.settings.save(s);
    return s;
  }

  private async requireSettings(tenantId: string): Promise<BillingSettings> {
    const s = await this.deps.settings.get(tenantId);
    if (!s) throw new BillingError(422, "Rechnungseinstellungen sind noch nicht erfasst.");
    return s;
  }

  // --- Entwürfe --------------------------------------------------------------------------------

  private buildLines(input: LineInput[], vatMode: "none" | "exclusive", settings: BillingSettings) {
    return input.map<InvoiceLine>((l) => ({
      description: l.description,
      quantityMilli: l.quantityMilli,
      unitCents: l.unitCents,
      vatRateBp:
        vatMode === "none" ? (l.vatRateBp ?? 0) : (l.vatRateBp ?? settings.defaultVatRateBp),
      ...(l.accountCode ? { accountCode: l.accountCode } : {}),
    }));
  }

  /** Konten der Positionen gegen den Kontenplan prüfen (früh, schon beim Entwurf; gebucht wird erst beim Versenden). */
  private async assertLineAccounts(lines: readonly { accountCode?: string | null }[]) {
    const codes = [...new Set(lines.flatMap((l) => (l.accountCode ? [l.accountCode] : [])))];
    if (codes.length > 0) await this.deps.accounting?.assertRevenueAccounts(codes);
  }

  private draftFrom(
    tenantId: string,
    input: InvoiceInput,
    settings: BillingSettings,
    base: Pick<Invoice, "id" | "createdAt" | "version"> & Partial<Invoice>,
  ): Invoice {
    const issueDate = input.issueDate ?? this.today();
    const dueDate = input.dueDate ?? addDays(issueDate, settings.paymentTermDays);
    if (dueDate < issueDate)
      throw new BillingError(422, "Fälligkeit liegt vor dem Rechnungsdatum.");
    const vatMode = input.vatMode ?? settings.defaultVatMode;
    const roundTo5 = input.roundTo5 ?? settings.roundTo5;
    const lines = this.buildLines(input.lines, vatMode, settings);
    return {
      kind: "invoice",
      status: "draft",
      number: null,
      seq: null,
      reference: null,
      creditNoteOf: null,
      collectiveRunId: null,
      payerKey: null,
      payments: [],
      sentAt: null,
      ...base,
      tenantId,
      customerId: input.customerId ?? null,
      debtor: input.debtor,
      currency: input.currency,
      issueDate,
      dueDate,
      vatMode,
      roundTo5,
      subject: input.subject,
      notes: input.notes,
      lines,
      totals: computeTotals(lines, vatMode, roundTo5),
      updatedAt: this.now().toISOString(),
    };
  }

  /** `userId` ist nur nötig, wenn Positionen ein Erlöskonto tragen: es wird gegen den Kontenplan geprüft. */
  createDraft(tenantId: string, input: InvoiceInput, userId?: string): Promise<InvoiceView> {
    return this.atomic(
      tenantId,
      (s) => s.createDraftNow(tenantId, input),
      input.lines.some((l) => l.accountCode) ? userId : undefined,
    );
  }

  private async createDraftNow(tenantId: string, input: InvoiceInput): Promise<InvoiceView> {
    const settings = await this.requireSettings(tenantId);
    const at = this.now().toISOString();
    const inv = this.draftFrom(tenantId, input, settings, {
      id: this.newId(),
      createdAt: at,
      version: 1,
    });
    await this.assertLineAccounts(inv.lines);
    await this.deps.invoices.insert(inv);
    return this.view(inv);
  }

  updateDraft(
    tenantId: string,
    id: string,
    input: InvoiceInput,
    version: number,
    userId?: string,
  ): Promise<InvoiceView> {
    return this.atomic(
      tenantId,
      (s) => s.updateDraftNow(tenantId, id, input, version),
      input.lines.some((l) => l.accountCode) ? userId : undefined,
    );
  }

  private async updateDraftNow(
    tenantId: string,
    id: string,
    input: InvoiceInput,
    version: number,
  ): Promise<InvoiceView> {
    const cur = await this.mustGet(tenantId, id);
    if (cur.status !== "draft")
      throw new BillingError(409, "Nur Entwürfe sind änderbar. Korrektur per Gutschrift.");
    const settings = await this.requireSettings(tenantId);
    const next = this.draftFrom(tenantId, input, settings, {
      id: cur.id,
      createdAt: cur.createdAt,
      version: cur.version + 1,
      kind: cur.kind,
      creditNoteOf: cur.creditNoteOf,
      collectiveRunId: cur.collectiveRunId,
      payerKey: cur.payerKey,
    });
    await this.assertLineAccounts(next.lines);
    await this.deps.invoices.update(next, version);
    return this.view(next);
  }

  async deleteDraft(tenantId: string, id: string): Promise<void> {
    const cur = await this.mustGet(tenantId, id);
    if (cur.status !== "draft") throw new BillingError(409, "Gebuchte Belege werden nie gelöscht.");
    if (!(await this.deps.invoices.deleteDraft(tenantId, id)))
      throw new BillingError(409, "Löschen nicht möglich.");
  }

  // --- Lesen -----------------------------------------------------------------------------------

  private async mustGet(tenantId: string, id: string): Promise<Invoice> {
    const inv = await this.deps.invoices.get(tenantId, id);
    if (!inv) throw new BillingError(404, "Beleg nicht gefunden.");
    return inv;
  }

  private async creditedOf(inv: Invoice): Promise<Cents> {
    if (inv.kind !== "invoice") return 0;
    const notes = await this.deps.invoices.creditNotesOf(inv.tenantId, inv.id);
    return -notes.reduce((s, n) => s + n.totals.totalCents, 0);
  }

  private async view(inv: Invoice): Promise<InvoiceView> {
    const credited = await this.creditedOf(inv);
    return {
      invoice: inv,
      paidCents: paidCents(inv),
      creditedCents: credited,
      openCents: inv.kind === "invoice" && inv.status !== "draft" ? openCents(inv, credited) : 0,
    };
  }

  async get(tenantId: string, id: string): Promise<InvoiceView> {
    return this.view(await this.mustGet(tenantId, id));
  }

  async list(tenantId: string, q: InvoiceQuery) {
    const { items, total } = await this.deps.invoices.list(tenantId, q);
    return { items: await Promise.all(items.map((i) => this.view(i))), total };
  }

  // --- Buchen ----------------------------------------------------------------------------------

  /** Entwurf versenden = buchen: Nummer und Referenz werden vergeben, der Beleg ist danach unveränderlich. */
  send(tenantId: string, id: string, userId?: string): Promise<InvoiceView> {
    return this.atomic(tenantId, (s) => s.sendNow(tenantId, id), userId);
  }

  private async sendNow(tenantId: string, id: string): Promise<InvoiceView> {
    const inv = await this.mustGet(tenantId, id);
    if (inv.status !== "draft") throw new BillingError(409, "Beleg ist bereits versendet.");
    const settings = await this.requireSettings(tenantId);
    return this.view(await this.book(inv, settings));
  }

  /** `original`: bei einer Gutschrift die korrigierte Rechnung (für die Zuordnung in der Buchhaltung). */
  private async book(
    inv: Invoice,
    settings: BillingSettings,
    original?: Invoice,
  ): Promise<Invoice> {
    const year = Number(inv.issueDate.slice(0, 4));
    const seq = await this.deps.invoices.nextSeq(inv.tenantId, inv.kind, year);
    if (seq > SEQ_MAX) throw new BillingError(409, "Nummernkreis erschöpft.");
    const credit = inv.kind === "credit_note";
    const prefix = credit ? settings.creditNotePrefix : settings.numberPrefix;
    const base = `${settings.referencePrefix}${year}${String(seq).padStart(6, "0")}`;
    const reference = credit
      ? null
      : isQrIban(settings.iban)
        ? { type: "QRR" as const, value: makeQrr(base) }
        : { type: "SCOR" as const, value: makeScor(base) };
    // Das Erlöskonto jeder Position wird jetzt festgeschrieben: spätere Änderungen am Standardkonto lassen diesen Beleg
    // und seine Gutschriften unberührt.
    const defaultAccount = inv.collectiveRunId
      ? MEMBERSHIP_REVENUE_ACCOUNT
      : (settings.defaultRevenueAccount ?? DEFAULT_REVENUE_ACCOUNT);
    const booked: Invoice = {
      ...inv,
      lines: inv.lines.map((l) => (l.accountCode ? l : { ...l, accountCode: defaultAccount })),
      number: `${prefix}-${year}-${String(seq).padStart(4, "0")}`,
      seq,
      reference,
      status: "sent",
      sentAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      version: inv.version + 1,
    };
    // Erst buchen, dann speichern: lehnt die Buchhaltung ab (z. B. gesperrte Periode), bleibt der Beleg ein Entwurf,
    // auch ohne Transaktion (In-Memory). In PostgreSQL läuft beides in einer Transaktion.
    await this.deps.accounting?.invoiceBooked(booked, original);
    await this.deps.invoices.update(booked, inv.version);
    return booked;
  }

  /**
   * Zahlung oder Rückbuchung erfassen; Zahlungen werden nie gelöscht. Eine Rückbuchung (negativer Betrag) hebt genau
   * eine frühere, noch nicht zurückgebuchte Zahlung gleichen Betrags auf (Rücklastschrift, Bankstorno): die Rechnung
   * wird wieder offen, die Buchhaltung bucht die Zahlung spiegelbildlich und öffnet den Posten wieder. Teilbeträge
   * werden nicht zurückgebucht.
   */
  recordPayment(
    tenantId: string,
    id: string,
    input: { amountCents: Cents; paidOn: string },
    userId: string,
  ): Promise<InvoiceView> {
    return this.atomic(tenantId, (s) => s.recordPaymentNow(tenantId, id, input, userId), userId);
  }

  private async recordPaymentNow(
    tenantId: string,
    id: string,
    input: { amountCents: Cents; paidOn: string },
    userId: string,
  ): Promise<InvoiceView> {
    const inv = await this.mustGet(tenantId, id);
    if (inv.kind !== "invoice" || inv.status === "draft")
      throw new BillingError(409, "Zahlungen gibt es nur für versendete Rechnungen.");
    const credited = await this.creditedOf(inv);
    const newPaid = paidCents(inv) + input.amountCents;
    if (newPaid < 0) throw new BillingError(422, "Rückbuchung übersteigt die erfassten Zahlungen.");
    let returned: Payment | undefined;
    if (input.amountCents < 0) {
      returned = unreturnedPayments(inv.payments).findLast(
        (p) => p.amountCents === -input.amountCents,
      );
      if (!returned)
        throw new BillingError(
          422,
          "Eine Rückbuchung muss dem Betrag einer erfassten, noch nicht zurückgebuchten Zahlung entsprechen.",
        );
      if (input.paidOn < returned.paidOn)
        throw new BillingError(422, "Das Rückbuchungsdatum liegt vor dem Zahlungsdatum.");
    }
    const payment = {
      id: this.newId(),
      amountCents: input.amountCents,
      paidOn: input.paidOn,
      recordedAt: this.now().toISOString(),
      recordedBy: userId,
    };
    const next: Invoice = {
      ...inv,
      payments: [...inv.payments, payment],
      updatedAt: this.now().toISOString(),
      version: inv.version + 1,
    };
    next.status = deriveStatus(next, credited);
    // Erst buchen, dann speichern (wie beim Versenden): lehnt die Buchhaltung ab, bleibt auch ohne Transaktion
    // (In-Memory) die Zahlung unerfasst.
    await this.deps.accounting?.paymentRecorded(next, payment, returned);
    await this.deps.invoices.update(next, inv.version);
    return this.view(next);
  }

  /** Storno = Gutschrift über den ganzen Rechnungsbetrag. Nur ohne Zahlungen und frühere Gutschriften. */
  cancel(tenantId: string, id: string, userId?: string): Promise<InvoiceView> {
    return this.atomic(tenantId, (s) => s.cancelNow(tenantId, id), userId);
  }

  private async cancelNow(tenantId: string, id: string): Promise<InvoiceView> {
    const inv = await this.mustGet(tenantId, id);
    if (inv.kind !== "invoice" || inv.status !== "sent")
      throw new BillingError(409, "Nur offene, versendete Rechnungen sind stornierbar.");
    if (paidCents(inv) !== 0 || (await this.creditedOf(inv)) !== 0)
      throw new BillingError(
        409,
        "Rechnung hat Zahlungen oder Gutschriften: Teilgutschrift erfassen.",
      );
    await this.issueCredit(
      inv,
      inv.lines.map((l) => ({ ...l, unitCents: Math.abs(l.unitCents) })),
      "Storno",
    );
    return this.get(tenantId, id);
  }

  /** Teil- oder Vollgutschrift per Gegenbuchung. Die Rechnung selbst bleibt unverändert. */
  credit(
    tenantId: string,
    id: string,
    lines: LineInput[],
    subject?: string,
    userId?: string,
  ): Promise<InvoiceView> {
    return this.atomic(tenantId, (s) => s.creditNow(tenantId, id, lines, subject), userId);
  }

  private async creditNow(
    tenantId: string,
    id: string,
    lines: LineInput[],
    subject?: string,
  ): Promise<InvoiceView> {
    const inv = await this.mustGet(tenantId, id);
    if (inv.kind !== "invoice" || inv.status === "draft")
      throw new BillingError(409, "Gutschriften gibt es nur zu versendeten Rechnungen.");
    const settings = await this.requireSettings(tenantId);
    await this.issueCredit(inv, this.buildLines(lines, inv.vatMode, settings), subject);
    return this.get(tenantId, id);
  }

  private async issueCredit(
    inv: Invoice,
    positive: InvoiceLine[],
    subject?: string,
  ): Promise<void> {
    const settings = await this.requireSettings(inv.tenantId);
    // Gutschriften buchen spiegelbildlich auf das Erlöskonto der Rechnung. Eine Position ohne eigenes Konto übernimmt
    // es, wenn die Rechnung nur eines hat; bei mehreren Konten muss die Position es nennen.
    const originalAccounts = new Set(
      inv.lines.map(
        (l) =>
          l.accountCode ??
          (inv.collectiveRunId ? MEMBERSHIP_REVENUE_ACCOUNT : DEFAULT_REVENUE_ACCOUNT),
      ),
    );
    const [onlyAccount] = originalAccounts.size === 1 ? originalAccounts : [];
    const lines = positive.map((l) => {
      const accountCode = l.accountCode ?? onlyAccount;
      if (!accountCode)
        throw new BillingError(
          422,
          "Die Rechnung hat mehrere Erlöskonten: jede Gutschriftsposition braucht ein Konto.",
        );
      return { ...l, accountCode, unitCents: -l.unitCents };
    });
    const totals = computeTotals(lines, inv.vatMode, inv.roundTo5, true);
    const credited = await this.creditedOf(inv);
    if (credited - totals.totalCents > inv.totals.totalCents)
      throw new BillingError(422, "Gutschriften übersteigen den Rechnungsbetrag.");
    const at = this.now().toISOString();
    const draft: Invoice = {
      ...inv,
      id: this.newId(),
      kind: "credit_note",
      status: "draft",
      number: null,
      seq: null,
      reference: null,
      creditNoteOf: inv.id,
      collectiveRunId: null,
      payerKey: null,
      payments: [],
      sentAt: null,
      issueDate: this.today(),
      dueDate: this.today(),
      subject: subject ?? `Gutschrift zu ${inv.number ?? ""}`.trim(),
      notes: "",
      lines,
      totals,
      createdAt: at,
      updatedAt: at,
      version: 1,
    };
    await this.deps.invoices.insert(draft);
    await this.book(draft, settings, inv);
    // Status der Rechnung aus dem neuen Buchungsstand ableiten (Gegenbuchung, kein Überschreiben).
    const fresh = await this.mustGet(inv.tenantId, inv.id);
    const next: Invoice = {
      ...fresh,
      status: deriveStatus(fresh, await this.creditedOf(fresh)),
      updatedAt: at,
      version: fresh.version + 1,
    };
    await this.deps.invoices.update(next, fresh.version);
  }

  // --- PDF -------------------------------------------------------------------------------------

  async invoicePdf(tenantId: string, id: string): Promise<{ pdf: Uint8Array; filename: string }> {
    const inv = await this.mustGet(tenantId, id);
    const settings = await this.requireSettings(tenantId);
    const orig = inv.creditNoteOf ? await this.deps.invoices.get(tenantId, inv.creditNoteOf) : null;
    const pdf = await renderInvoicePdf({
      invoice: inv,
      settings,
      creditNoteOfNumber: orig?.number ?? null,
    });
    return { pdf, filename: `${inv.number ?? `entwurf-${inv.id.slice(0, 8)}`}.pdf` };
  }

  // --- Mahnwesen -------------------------------------------------------------------------------

  async listReminders(tenantId: string, id: string): Promise<Reminder[]> {
    await this.mustGet(tenantId, id);
    return this.deps.reminders.listByInvoice(tenantId, id);
  }

  /** Alle versendeten Rechnungen, für die zum Stichtag eine Mahnstufe fällig ist. */
  async dueForDunning(tenantId: string, asOf = this.today()): Promise<DunningCandidate[]> {
    const settings = await this.requireSettings(tenantId);
    const out: DunningCandidate[] = [];
    for (let offset = 0; ; offset += 200) {
      const { items, total } = await this.deps.invoices.list(tenantId, {
        status: "sent",
        kind: "invoice",
        limit: 200,
        offset,
      });
      for (const inv of items) {
        const open = openCents(inv, await this.creditedOf(inv));
        const existing = await this.deps.reminders.listByInvoice(tenantId, inv.id);
        const next = nextDueLevel(inv, open, existing, settings.dunning, asOf);
        if (next)
          out.push({
            invoiceId: inv.id,
            number: inv.number,
            dueDate: inv.dueDate,
            openCents: open,
            nextLevel: next,
          });
      }
      if (offset + 200 >= total) return out;
    }
  }

  /**
   * Offene Posten für die Startseite und den Navigationszähler: versendete Rechnungen (keine Entwürfe, keine
   * Gutschriften) mit Restbetrag über null, älteste Fälligkeit zuerst.
   * shortcut: liest alle versendeten Rechnungen seitenweise und rechnet im Speicher, wie `dueForDunning`;
   * bei vielen tausend offenen Rechnungen als SQL-Aggregat umsetzen.
   */
  async openItems(tenantId: string, limit: number): Promise<OpenItemsSummary> {
    const today = this.today();
    const all: OpenItemRow[] = [];
    for (let offset = 0; ; offset += 200) {
      const { items, total } = await this.deps.invoices.list(tenantId, {
        status: "sent",
        kind: "invoice",
        limit: 200,
        offset,
      });
      for (const inv of items) {
        const open = openCents(inv, await this.creditedOf(inv));
        if (open > 0) {
          all.push({
            invoiceId: inv.id,
            number: inv.number,
            debtor: inv.debtor.name,
            openCents: open,
            currency: inv.currency,
            dueDate: inv.dueDate,
          });
        }
      }
      if (offset + 200 >= total) break;
    }
    all.sort(
      (a, b) =>
        a.dueDate.localeCompare(b.dueDate) || (a.number ?? "").localeCompare(b.number ?? ""),
    );
    return {
      items: all.slice(0, limit),
      total: all.length,
      overdue: all.filter((i) => i.dueDate < today).length,
    };
  }

  issueReminder(tenantId: string, id: string, asOf = this.today()): Promise<Reminder> {
    return this.atomic(tenantId, (s) => s.issueReminderNow(tenantId, id, asOf));
  }

  private async issueReminderNow(tenantId: string, id: string, asOf: string): Promise<Reminder> {
    const inv = await this.mustGet(tenantId, id);
    const settings = await this.requireSettings(tenantId);
    const existing = await this.deps.reminders.listByInvoice(tenantId, id);
    const open = openCents(inv, await this.creditedOf(inv));
    const level = nextDueLevel(inv, open, existing, settings.dunning, asOf);
    if (!level) throw new BillingError(409, "Für diese Rechnung ist keine Mahnstufe fällig.");
    const reminder = buildReminder(
      inv,
      open,
      existing,
      level,
      asOf,
      this.newId(),
      this.now().toISOString(),
    );
    await this.deps.reminders.insert(reminder);
    return reminder;
  }

  async reminderPdf(
    tenantId: string,
    id: string,
    level: number,
  ): Promise<{ pdf: Uint8Array; filename: string }> {
    const inv = await this.mustGet(tenantId, id);
    const settings = await this.requireSettings(tenantId);
    const all = await this.deps.reminders.listByInvoice(tenantId, id);
    const reminder = all.find((r) => r.level === level);
    if (!reminder) throw new BillingError(404, "Mahnung nicht gefunden.");
    const pdf = await renderReminderPdf({
      invoice: inv,
      reminder,
      previous: all.filter((r) => r.level < level),
      settings,
    });
    return { pdf, filename: `mahnung-${level}-${inv.number ?? inv.id.slice(0, 8)}.pdf` };
  }

  // --- Sammelrechnung (optionales Modul) -------------------------------------------------------

  /**
   * Mitgliederbeiträge: pro Zahler eine Rechnung mit einer Position je Mitglied. Nur wenn das Modul
   * für den Mandanten freigeschaltet ist. Wiederholung mit derselben `runId` ist folgenlos.
   */
  runCollective(tenantId: string, input: CollectiveInput) {
    return this.atomic(tenantId, (s) => s.runCollectiveNow(tenantId, input));
  }

  private async runCollectiveNow(tenantId: string, input: CollectiveInput) {
    const settings = await this.requireSettings(tenantId);
    if (!settings.features.collectiveInvoicing)
      throw new BillingError(
        403,
        "Das Modul Sammelrechnung ist für diesen Kunden nicht freigeschaltet.",
      );
    const groups = new Map<string, CollectiveInput["items"]>();
    for (const item of input.items)
      groups.set(item.payerKey, [...(groups.get(item.payerKey) ?? []), item]);

    // Erst alles aufbauen und prüfen, dann speichern: ein Fehler lässt keinen halben Lauf zurück.
    const drafts: Invoice[] = [];
    const skipped: string[] = [];
    const at = this.now().toISOString();
    for (const [payerKey, items] of groups) {
      if (await this.deps.invoices.findByRunAndPayer(tenantId, input.runId, payerKey)) {
        skipped.push(payerKey);
        continue;
      }
      const first = items[0];
      if (!first) continue;
      const draft = this.draftFrom(
        tenantId,
        {
          customerId: payerKey,
          debtor: first.payer,
          currency: "CHF",
          vatMode: input.vatMode,
          subject: input.period,
          notes: "",
          ...(input.issueDate ? { issueDate: input.issueDate } : {}),
          ...(input.dueDate ? { dueDate: input.dueDate } : {}),
          lines: items.map((i) => ({
            description: i.description,
            quantityMilli: 1000,
            unitCents: i.amountCents,
          })),
        },
        settings,
        {
          id: this.newId(),
          createdAt: at,
          version: 1,
          collectiveRunId: input.runId,
          payerKey,
        },
      );
      drafts.push(draft);
    }
    for (const d of drafts) await this.deps.invoices.insert(d);
    return { created: drafts.map((d) => d.id), skippedPayers: skipped };
  }
}
