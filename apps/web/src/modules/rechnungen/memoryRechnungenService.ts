import { buildHistory } from "./history";
import {
  addDays,
  computeTotals,
  levelStartDay,
  toRow,
  todayIso,
  type Address,
  type BillingSettings,
  type DunningLevel,
  type Invoice,
  type InvoiceLine,
  type Recipient,
  type Reminder,
} from "./model";
import type {
  CollectiveGroup,
  CollectivePreviewRow,
  DraftInput,
  RechnungenService,
} from "./service";

/**
 * In-Memory-Umsetzung für Tests und Entwicklung. Verhält sich wie der Server: Nummer und Referenz
 * entstehen erst beim Versenden, versendete Belege bleiben unverändert, Gutschriften sind Gegenbelege.
 * Wird nie mit der Produktionsoberfläche verdrahtet.
 */

export const seedSettings: BillingSettings = {
  creditor: {
    name: "Verein Beispiel",
    street: "Beispielstrasse",
    buildingNumber: "1",
    postalCode: "8000",
    town: "Musterhausen",
    country: "CH",
  },
  iban: "CH0000000000000000000",
  vatNumber: "CHE-000.000.000 MWST",
  contactLines: ["rechnung@example.ch"],
  paymentTermDays: 30,
  defaultVatMode: "exclusive",
  defaultVatRateBp: 810,
  roundTo5: false,
  dunning: {
    levels: [
      { level: 1, title: "Zahlungserinnerung", waitDays: 10, graceDays: 10, feeCents: 0 },
      { level: 2, title: "1. Mahnung", waitDays: 0, graceDays: 10, feeCents: 1000 },
      { level: 3, title: "2. Mahnung", waitDays: 0, graceDays: 10, feeCents: 2000 },
    ],
  },
  features: { collectiveInvoicing: true },
};

const addr = (name: string, street: string, no: string, zip: string, town: string): Address => ({
  name,
  street,
  buildingNumber: no,
  postalCode: zip,
  town,
  country: "CH",
});

export const seedRecipients: (Recipient & { number: string })[] = [
  {
    id: "m-1042",
    number: "M-1042",
    name: "Beispiel Treuhand AG",
    address: { ...addr("Beispiel Treuhand AG", "Probegasse", "4", "8001", "Musterhausen") },
    email: "buchhaltung@beispiel-treuhand.example.ch",
  },
  {
    id: "m-1048",
    number: "M-1048",
    name: "Demo Handels AG",
    address: addr("Demo Handels AG", "Musterweg", "40", "8010", "Musterhausen"),
    email: "buchhaltung@demo-handels.example.ch",
  },
  {
    id: "m-1055",
    number: "M-1055",
    name: "Muster GmbH",
    address: addr("Muster GmbH", "Beispielweg", "7", "8000", "Musterhausen"),
    email: "kasse@muster-gmbh.example.ch",
  },
];

interface OpenSpec {
  nr: string;
  name: string;
  issue: string;
  due: string;
  cents: number;
  /** Erreichte Mahnstufe. */
  level?: number;
}

/** Offene Rechnungen wie im Board 4.1 (Stichtag 02.11.2026). */
export const seedOpen: OpenSpec[] = [
  {
    nr: "R-2026-0344",
    name: "Probe und Partner AG",
    issue: "2026-08-01",
    due: "2026-08-31",
    cents: 55000,
    level: 3,
  },
  {
    nr: "R-2026-0352",
    name: "Vorlage Bau AG",
    issue: "2026-08-15",
    due: "2026-09-14",
    cents: 142000,
    level: 2,
  },
  {
    nr: "R-2026-0366",
    name: "Demo Handels AG",
    issue: "2026-09-05",
    due: "2026-10-05",
    cents: 38000,
    level: 1,
  },
  {
    nr: "R-2026-0372",
    name: "Muster Reisen AG",
    issue: "2026-09-12",
    due: "2026-10-12",
    cents: 64000,
    level: 1,
  },
  {
    nr: "R-2026-0379",
    name: "Lukas Probe",
    issue: "2026-09-15",
    due: "2026-10-15",
    cents: 12000,
    level: 1,
  },
  { nr: "R-2026-0395", name: "Jonas Demo", issue: "2026-09-22", due: "2026-10-22", cents: 6000 },
  {
    nr: "R-2026-0401",
    name: "Beispiel Bäckerei GmbH",
    issue: "2026-09-25",
    due: "2026-10-25",
    cents: 163045,
  },
  {
    nr: "R-2026-0409",
    name: "Beispiel Gastro GmbH",
    issue: "2026-09-28",
    due: "2026-10-28",
    cents: 50000,
  },
  {
    nr: "R-2026-0412",
    name: "Anna Beispiel",
    issue: "2026-10-01",
    due: "2026-10-31",
    cents: 12000,
  },
  {
    nr: "R-2026-0421",
    name: "Test Elektro GmbH",
    issue: "2026-10-20",
    due: "2026-11-19",
    cents: 125000,
  },
  { nr: "R-2026-0424", name: "Muster GmbH", issue: "2026-10-21", due: "2026-11-20", cents: 64860 },
];

export function makeInvoice(p: Partial<Invoice> & { id: string }): Invoice {
  const lines: InvoiceLine[] = p.lines ?? [
    { description: "Firmenbeitrag 2026", quantityMilli: 1000, unitCents: 10000, vatRateBp: 0 },
  ];
  const totals = p.totals ?? computeTotals(lines, "none", false);
  return {
    kind: "invoice",
    status: "sent",
    number: null,
    customerId: null,
    debtor: addr("Beispiel Treuhand AG", "Probegasse", "4", "8001", "Musterhausen"),
    currency: "CHF",
    issueDate: "2026-10-01",
    dueDate: "2026-10-31",
    vatMode: "none",
    roundTo5: false,
    subject: "",
    notes: "",
    reference: null,
    creditNoteOf: null,
    payments: [],
    sentAt: null,
    createdAt: "2026-10-01T08:00:00.000Z",
    version: 1,
    paidCents: 0,
    creditedCents: 0,
    openCents: totals.totalCents,
    ...p,
    lines,
    totals,
  };
}

const ref = (n: number) => `00000000000000000${String(n).padStart(10, "0")}`;

function seedInvoices(): { invoices: Invoice[]; reminders: Reminder[] } {
  const invoices: Invoice[] = [];
  const reminders: Reminder[] = [];
  const settings = seedSettings.dunning.levels;
  seedOpen.forEach((o, i) => {
    const inv = makeInvoice({
      id: `inv-${o.nr}`,
      number: o.nr,
      debtor: addr(o.name, "Musterweg", String(i + 1), "8000", "Musterhausen"),
      customerId: o.name === "Demo Handels AG" ? "m-1048" : null,
      memberNumber: o.name === "Demo Handels AG" ? "M-1048" : null,
      subject: "Firmenbeitrag 2026",
      issueDate: o.issue,
      dueDate: o.due,
      sentAt: `${o.issue}T08:52:00.000Z`,
      createdAt: `${o.issue}T08:40:00.000Z`,
      reference: { type: "QRR", value: ref(Number(o.nr.slice(-4)) * 10 + 2) },
      lines: [
        { description: "Firmenbeitrag", quantityMilli: 1000, unitCents: o.cents, vatRateBp: 0 },
      ],
    });
    invoices.push(inv);
    for (let l = 1; l <= (o.level ?? 0); l++) {
      const d = settings[l - 1]!;
      const issuedOn = addDays(o.due, levelStartDay(settings, l));
      reminders.push({
        id: `rem-${o.nr}-${l}`,
        invoiceId: inv.id,
        level: l,
        title: d.title,
        issuedOn,
        dueOn: addDays(issuedOn, d.graceDays),
        feeCents: d.feeCents,
        openCents: o.cents,
        totalCents: o.cents,
        createdAt: `${issuedOn}T07:00:00.000Z`,
      });
    }
  });
  invoices.push(
    makeInvoice({
      id: "inv-paid",
      number: "R-2026-0300",
      status: "paid",
      paidCents: 10000,
      openCents: 0,
      sentAt: "2026-06-01T08:00:00.000Z",
      payments: [
        {
          id: "pay-1",
          amountCents: 10000,
          paidOn: "2026-06-10",
          recordedAt: "2026-06-10T09:00:00.000Z",
        },
      ],
    }),
    makeInvoice({
      id: "inv-cancelled",
      number: "R-2026-0310",
      status: "cancelled",
      creditedCents: 10000,
      openCents: 0,
      sentAt: "2026-06-02T08:00:00.000Z",
    }),
    makeInvoice({
      id: "inv-draft",
      status: "draft",
      customerId: "m-1042",
      memberNumber: "M-1042",
      subject: "Inserat und Verpflegung Herbstanlass 2026",
      notes:
        "Vielen Dank für Ihre Unterstützung. Bitte überweisen Sie den Betrag bis zum Fälligkeitsdatum mit dem beiliegenden Zahlteil.",
      issueDate: "2026-11-02",
      dueDate: "2026-12-02",
      vatMode: "exclusive",
      createdAt: "2026-11-02T13:05:00.000Z",
      lines: [
        {
          description: "Inserat im Vereinsheft 2027, 1/2 Seite",
          quantityMilli: 1000,
          unitCents: 25000,
          vatRateBp: 810,
        },
        {
          description: "Verpflegung Herbstanlass, 8 Personen",
          quantityMilli: 8000,
          unitCents: 2500,
          vatRateBp: 260,
        },
      ],
      totals: computeTotals(
        [
          { description: "a", quantityMilli: 1000, unitCents: 25000, vatRateBp: 810 },
          { description: "b", quantityMilli: 8000, unitCents: 2500, vatRateBp: 260 },
        ],
        "exclusive",
        false,
      ),
      openCents: 0,
    }),
  );
  return { invoices, reminders };
}

const GROUPS: CollectiveGroup[] = [
  { id: "g-vorstand", name: "Vorstand", persons: 7, feeCents: null },
  { id: "g-aktiv", name: "Aktivmitglieder", persons: 412, feeCents: 12000 },
  { id: "g-passiv", name: "Passivmitglieder", persons: 538, feeCents: 6000 },
  { id: "g-revision", name: "Revision", persons: 3, feeCents: null },
  { id: "g-helfer", name: "Helferteam", persons: 64, feeCents: null },
  { id: "g-jugend", name: "Jugend", persons: 96, feeCents: 4000 },
  { id: "g-ehren", name: "Ehrenmitglieder", persons: 14, feeCents: null },
  { id: "g-goenner", name: "Gönner", persons: 71, feeCents: 10000 },
  { id: "g-neu", name: "Neumitglieder 2026", persons: 41, feeCents: 12000 },
  { id: "g-redaktion", name: "Redaktion", persons: 9, feeCents: null },
  { id: "g-event", name: "Veranstaltungsteam", persons: 22, feeCents: null },
  { id: "g-ohne", name: "Ohne Gruppe", persons: 7, feeCents: null },
];

const FIRST_ROWS: [string, string][] = [
  ["Daniel Test", "g-aktiv"],
  ["Eva Probe", "g-jugend"],
  ["Fabian Muster", "g-neu"],
  ["Gabi Beispiel", "g-goenner"],
  ["Hans Demo", "g-goenner"],
  ["Irene Vorlage", "g-aktiv"],
  ["Jonas Test", "g-passiv"],
  ["Karin Probe", "g-neu"],
  ["Lukas Muster", "g-passiv"],
  ["Maria Beispiel", "g-neu"],
  ["Nico Demo", "g-aktiv"],
  ["Olivia Vorlage", "g-jugend"],
];

export interface MemoryOptions {
  now?: () => number;
  invoices?: Invoice[];
  reminders?: Reminder[];
}

export function createMemoryRechnungenService(options: MemoryOptions = {}): RechnungenService & {
  /** Für Tests: aktueller Stand. */
  state: {
    invoices: Invoice[];
    reminders: Reminder[];
    sent: string[];
    exported: (readonly string[] | "all")[];
    settings: BillingSettings;
    groups: CollectiveGroup[];
  };
} {
  const now = options.now ?? (() => Date.parse("2026-11-02T13:00:00Z"));
  const seeded = seedInvoices();
  const state = {
    invoices: options.invoices ?? seeded.invoices,
    reminders: options.reminders ?? seeded.reminders,
    sent: [] as string[],
    exported: [] as (readonly string[] | "all")[],
    settings: structuredClone(seedSettings),
    groups: GROUPS.map((g) => ({ ...g })),
  };
  let counter = 431;
  let id = 0;
  const today = () => todayIso(now());
  const find = (invoiceId: string) => {
    const inv = state.invoices.find((i) => i.id === invoiceId);
    if (!inv) throw new Error("Beleg nicht gefunden.");
    return inv;
  };
  const emailOf = (inv: Invoice) =>
    seedRecipients.find((r) => r.id === inv.customerId)?.email ?? null;
  const remindersOf = (invoiceId: string) =>
    state.reminders.filter((r) => r.invoiceId === invoiceId);
  const replace = (next: Invoice) => {
    state.invoices = state.invoices.map((i) => (i.id === next.id ? next : i));
    return next;
  };
  const dueLevel = (inv: Invoice): DunningLevel | undefined => {
    if (inv.status !== "sent" || inv.openCents <= 0 || inv.dueDate >= today()) return undefined;
    const last = remindersOf(inv.id).reduce((m, r) => Math.max(m, r.level), 0);
    const next = state.settings.dunning.levels[last];
    if (!next) return undefined;
    const from =
      last === 0
        ? inv.dueDate
        : (remindersOf(inv.id).find((r) => r.level === last)?.dueOn ?? inv.dueDate);
    const days = Math.round((Date.parse(today()) - Date.parse(from)) / 864e5);
    return days >= next.waitDays && today() > from ? next : undefined;
  };

  const svc: RechnungenService & { state: typeof state } = {
    state,
    today,

    async listInvoices() {
      return state.invoices
        .filter((i) => i.kind === "invoice")
        .map((i) => toRow(i, remindersOf(i.id), today()));
    },

    async getInvoice(invoiceId) {
      const invoice = find(invoiceId);
      const reminders = remindersOf(invoiceId);
      const level = reminders.reduce((m, r) => Math.max(m, r.level), 0);
      const due = dueLevel(invoice);
      return {
        invoice,
        reminders,
        email: emailOf(invoice),
        level,
        levelTitle: reminders.find((r) => r.level === level)?.title ?? null,
        dueLevel: due,
        history: buildHistory({
          invoice,
          reminders,
          creditNotes: state.invoices.filter((c) => c.creditNoteOf === invoiceId),
          dueLevel: due,
          today: today(),
        }),
      };
    },

    async getSettings() {
      return state.settings;
    },

    async searchRecipients(query) {
      const q = query.trim().toLowerCase();
      return seedRecipients.filter((r) => r.name.toLowerCase().includes(q));
    },

    async saveDraft(input: DraftInput, existing) {
      const base = existing ? find(existing.id) : undefined;
      const lines = input.lines;
      const next = makeInvoice({
        ...(base ?? {}),
        id: base?.id ?? `inv-new-${++id}`,
        status: "draft",
        customerId: input.recipient.id,
        debtor: input.recipient.address,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        subject: input.subject,
        notes: input.notes,
        vatMode: "exclusive",
        lines,
        totals: computeTotals(lines, "exclusive", false),
        openCents: 0,
        createdAt: base?.createdAt ?? new Date(now()).toISOString(),
        version: (base?.version ?? 0) + 1,
      });
      if (base) return replace(next);
      state.invoices = [...state.invoices, next];
      return next;
    },

    async sendInvoice(invoiceId, opts) {
      const inv = find(invoiceId);
      if (inv.status !== "draft") throw new Error("Beleg ist bereits versendet.");
      const number = `R-2026-${String(counter++).padStart(4, "0")}`;
      const next = replace({
        ...inv,
        status: "sent",
        number,
        reference: { type: "QRR", value: ref(Number(number.slice(-4)) * 10 + 7) },
        sentAt: new Date(now()).toISOString(),
        openCents: inv.totals.totalCents,
        version: inv.version + 1,
      });
      state.sent.push(`${opts.mode}:${opts.to}`);
      return { invoice: next, delivered: opts.mode === "email" };
    },

    async resendInvoice(invoiceId, opts) {
      if (find(invoiceId).status === "draft")
        throw new Error("Entwürfe werden erst nach dem Buchen versendet.");
      state.sent.push(`resend:${opts.to}`);
    },

    // Nur Rechnungen mit Nummer sind gebucht; die Buchung entspricht der Debitorenbuchung beim Versand.
    async bookings(invoiceId) {
      const inv = find(invoiceId);
      if (inv.status === "draft") return [];
      const total = inv.totals.totalCents;
      return [
        {
          id: `bk-${inv.id}`,
          number: Number(inv.number?.slice(-4) ?? 0),
          bookingDate: inv.issueDate,
          kind: "invoice" as const,
          description: `Rechnung ${inv.number ?? ""}`.trim(),
          lines: [
            {
              accountCode: "1100",
              accountName: "Debitoren",
              side: "debit" as const,
              amountCents: total,
            },
            {
              accountCode: "3400",
              accountName: "Erlös aus Dienstleistungen",
              side: "credit" as const,
              amountCents: total,
            },
          ],
        },
      ];
    },

    async exportInvoices(ids) {
      state.exported.push(ids ?? "all");
    },

    async saveDunningLevels(levels) {
      state.settings = { ...state.settings, dunning: { levels } };
      return levels;
    },

    async setGroupFee(groupId, feeCents) {
      state.groups = state.groups.map((g) => (g.id === groupId ? { ...g, feeCents } : g));
    },

    async cancelInvoice(invoiceId, input) {
      const inv = find(invoiceId);
      const invoice = replace({
        ...inv,
        status: "cancelled",
        creditedCents: inv.totals.totalCents,
        openCents: 0,
      });
      const email = emailOf(inv);
      if (input.notify && email) state.sent.push(`cancel:${email}`);
      return {
        invoice,
        notification: input.notify ? (email ? "sent" : "no-address") : "none",
      };
    },

    async emailReminder(invoiceId, level, opts) {
      find(invoiceId);
      if (!remindersOf(invoiceId).some((r) => r.level === level))
        throw new Error("Mahnung nicht gefunden.");
      state.sent.push(`reminder-${level}:${opts.to}`);
    },

    async resendInvoices(ids) {
      return [...new Set(ids)].map((invoiceId) => {
        const inv = state.invoices.find((i) => i.id === invoiceId);
        if (!inv) return { id: invoiceId, number: null, outcome: "failed", reason: "not-found" };
        const base = { id: invoiceId, number: inv.number };
        if (inv.kind !== "invoice" || inv.status === "draft" || inv.status === "cancelled")
          return { ...base, outcome: "skipped", reason: "not-sendable" };
        const email = emailOf(inv);
        if (!email) return { ...base, outcome: "skipped", reason: "no-address" };
        state.sent.push(`bulk:${email}`);
        return { ...base, outcome: "sent" };
      });
    },

    async creditInvoice(invoiceId, input) {
      const inv = find(invoiceId);
      const cents = input.scope === "full" ? inv.openCents : input.amountCents;
      if (cents > inv.openCents) throw new Error("Gutschriften übersteigen den Rechnungsbetrag.");
      const credited = inv.creditedCents + cents;
      const open = inv.openCents - cents;
      return replace({
        ...inv,
        creditedCents: credited,
        openCents: open,
        status: open <= 0 && inv.paidCents === 0 ? "cancelled" : inv.status,
      });
    },

    async dunningOverview() {
      const rows = (await svc.listInvoices()).filter((r) => r.overdueDays !== null);
      return {
        today: today(),
        rows,
        due: Object.fromEntries(
          rows.flatMap((r) => {
            const d = dueLevel(r.invoice);
            return d ? [[r.invoice.id, d]] : [];
          }),
        ),
        levels: state.settings.dunning.levels,
      };
    },

    async issueReminder(invoiceId) {
      const inv = find(invoiceId);
      const level = dueLevel(inv);
      if (!level) throw new Error("Für diese Rechnung ist keine Mahnstufe fällig.");
      const fees = remindersOf(invoiceId).reduce((s, r) => s + r.feeCents, 0);
      const reminder: Reminder = {
        id: `rem-new-${++id}`,
        invoiceId,
        level: level.level,
        title: level.title,
        issuedOn: today(),
        dueOn: addDays(today(), level.graceDays),
        feeCents: level.feeCents,
        openCents: inv.openCents,
        totalCents: inv.openCents + fees + level.feeCents,
        createdAt: new Date(now()).toISOString(),
      };
      state.reminders = [...state.reminders, reminder];
      return reminder;
    },

    async downloadPdf() {},

    async collectiveSetup() {
      return {
        groups: state.groups,
        totalPersons: 1284,
        defaults: {
          year: 2027,
          issueDate: "2026-12-01",
          termDays: 30,
          text: "Mitgliederbeitrag 2027",
        },
      };
    },

    async collectivePreview(config) {
      const chosen = state.groups.filter(
        (g) => config.groupIds.includes(g.id) && (!config.skipNoFee || g.feeCents !== null),
      );
      const count = chosen.reduce((s, g) => s + g.persons, 0);
      const noMail = new Set([8, 20, 33, 47, 52, 64, 71]);
      const rows: CollectivePreviewRow[] = [];
      const left = new Map(chosen.map((g) => [g.id, g.persons]));
      const push = (name: string, g: CollectiveGroup) => {
        const i = rows.length;
        const print = config.delivery === "print" || (noMail.has(i) && config.delivery !== "email");
        rows.push({
          number: `R-2026-${String(431 + i + 1).padStart(4, "0")}`,
          recipient: name,
          groupName: g.name,
          feeCents: g.feeCents ?? 0,
          delivery: print ? "print" : "email",
          check: noMail.has(i) ? "no-email" : "ready",
        });
        left.set(g.id, (left.get(g.id) ?? 0) - 1);
      };
      for (const [name, gid] of FIRST_ROWS) {
        const g = chosen.find((c) => c.id === gid);
        if (g && (left.get(g.id) ?? 0) > 0) push(name, g);
      }
      for (const g of chosen)
        while ((left.get(g.id) ?? 0) > 0) push(`Person ${rows.length + 1}`, g);
      const printCount = rows.filter((r) => r.delivery === "print").length;
      return {
        count,
        groupCount: chosen.length,
        totalCents: chosen.reduce((s, g) => s + g.persons * (g.feeCents ?? 0), 0),
        dueDate: addDays(config.issueDate, config.termDays),
        viaEmail: count - printCount,
        printCount,
        noAddress: 0,
        rows,
      };
    },

    async runCollective(config, options) {
      const preview = await svc.collectivePreview(config);
      options.onProgress?.(preview.count);
      return { created: preview.count, notMailed: 0 };
    },
  };
  return svc;
}
