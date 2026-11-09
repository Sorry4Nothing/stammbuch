import type {
  Bucket,
  DebtorRow,
  MonthlyReport,
  OpenItemRow,
  PeriodCheck,
  PeriodInfo,
  PeriodReview,
  ReportsService,
  StatementsReport,
  TrialBalanceReport,
  VatReport,
} from "./types";

/**
 * Dienst im Speicher für Tests und die Entwicklung ohne Backend. Die Werte entsprechen den
 * Beispielen der Boards 6.1 bis 6.8. Er ist nirgends verdrahtet; die Oberfläche nutzt ohne
 * `ReportsProvider` immer die API.
 */

const cents = (chf: number) => Math.round(chf * 100);

/** Offene Posten: die zwölf Zeilen von Board 6.1, danach 62 weitere nicht fällige (zusammen 74). */
function openItems(): OpenItemRow[] {
  const listed: [string, string, string, string, string, number, Bucket, number][] = [
    [
      "R-2026-0344",
      "Probe und Partner AG",
      "M-1031",
      "2026-08-01",
      "2026-08-31",
      63,
      "d61_90",
      550,
    ],
    ["R-2026-0352", "Vorlage Bau AG", "M-1038", "2026-08-15", "2026-09-14", 49, "d31_60", 1420],
    ["R-2026-0366", "Demo Handels AG", "M-1048", "2026-09-05", "2026-10-05", 28, "d1_30", 380],
    ["R-2026-0372", "Muster Reisen AG", "M-1052", "2026-09-12", "2026-10-12", 21, "d1_30", 640],
    ["R-2026-0379", "Lukas Probe", "M-1077", "2026-09-15", "2026-10-15", 18, "d1_30", 120],
    ["R-2026-0395", "Jonas Demo", "M-1098", "2026-09-22", "2026-10-22", 11, "d1_30", 60],
    [
      "R-2026-0401",
      "Beispiel Bäckerei GmbH",
      "M-1063",
      "2026-09-25",
      "2026-10-25",
      8,
      "d1_30",
      1630.45,
    ],
    ["R-2026-0409", "Beispiel Gastro GmbH", "M-1044", "2026-09-28", "2026-10-28", 5, "d1_30", 500],
    ["R-2026-0412", "Anna Beispiel", "M-1001", "2026-10-01", "2026-10-31", 2, "d1_30", 120],
    ["R-2026-0421", "Test Elektro GmbH", "M-1061", "2026-10-20", "2026-11-19", 0, "notDue", 1250],
    ["R-2026-0424", "Muster GmbH", "M-1055", "2026-10-21", "2026-11-20", 0, "notDue", 648.6],
    ["R-2026-0428", "Demo Gärtnerei GmbH", "M-1071", "2026-10-28", "2026-11-27", 0, "notDue", 840],
  ];
  const rows = listed.map(
    ([reference, debtorName, debtorNumber, issueDate, dueDate, daysOverdue, bucket, chf], i) => ({
      id: `op-${i}`,
      reference,
      debtorName,
      debtorNumber,
      issueDate,
      dueDate,
      daysOverdue,
      bucket,
      openCents: cents(chf),
    }),
  );
  for (let i = 0; i < 62; i++) {
    rows.push({
      id: `op-x${i}`,
      reference: `R-2026-${String(440 + i).padStart(4, "0")}`,
      debtorName: `Weitere Debitorin ${i + 1}`,
      debtorNumber: `M-${String(2000 + i)}`,
      issueDate: "2026-10-29",
      dueDate: "2026-11-28",
      daysOverdue: 0,
      bucket: "notDue",
      openCents: i === 61 ? cents(172.4) : cents(169),
    });
  }
  return rows;
}

/** Debitoren: die zwölf Zeilen von Board 6.2, danach 49 weitere (zusammen 61 mit 74 Posten). */
function debtors(): DebtorRow[] {
  const listed: [string, string, "company" | "person", string, number, number, number][] = [
    ["M-1031", "Probe und Partner AG", "company", "2026-08-31", 63, 550, 3],
    ["M-1038", "Vorlage Bau AG", "company", "2026-09-14", 49, 1420, 2],
    ["M-1048", "Demo Handels AG", "company", "2026-10-05", 28, 380, 1],
    ["M-1052", "Muster Reisen AG", "company", "2026-10-12", 21, 640, 1],
    ["M-1077", "Lukas Probe", "person", "2026-10-15", 18, 120, 1],
    ["M-1098", "Jonas Demo", "person", "2026-10-22", 11, 60, 0],
    ["M-1063", "Beispiel Bäckerei GmbH", "company", "2026-10-25", 8, 1630.45, 0],
    ["M-1044", "Beispiel Gastro GmbH", "company", "2026-10-28", 5, 500, 0],
    ["M-1001", "Anna Beispiel", "person", "2026-10-31", 2, 120, 0],
    ["M-1061", "Test Elektro GmbH", "company", "2026-11-19", 0, 1250, 0],
    ["M-1055", "Muster GmbH", "company", "2026-11-20", 0, 648.6, 0],
    ["M-1071", "Demo Gärtnerei GmbH", "company", "2026-11-27", 0, 840, 0],
  ];
  const rows: DebtorRow[] = listed.map(
    ([number, name, type, oldestDueDate, overdueDays, chf, dunningLevel], i) => ({
      id: `d-${i}`,
      number,
      name,
      type,
      items: 1,
      oldestDueDate,
      overdueDays,
      balanceCents: cents(chf),
      dunningLevel,
    }),
  );
  for (let i = 0; i < 49; i++) {
    rows.push({
      id: `d-x${i}`,
      number: `M-${String(2000 + i)}`,
      name: `Weitere Debitorin ${i + 1}`,
      type: "company",
      items: i < 13 ? 2 : 1,
      oldestDueDate: "2026-11-28",
      overdueDays: 0,
      balanceCents: i === 48 ? cents(209.4) : cents(214),
      dunningLevel: 0,
    });
  }
  return rows;
}

const trialBalance = (from: string, to: string): TrialBalanceReport => ({
  from,
  to,
  rows: (
    [
      ["1020", "Bank Zahlungsverkehr", "asset", 92003.2, 0],
      ["1100", "Debitoren Mitglieder", "asset", 92900, 83535],
      ["1101", "Debitoren Firmen", "asset", 18893.65, 9618.2],
      ["2200", "Geschuldete MwSt 8.1 %", "liability", 0, 1008.45],
      ["2201", "Geschuldete MwSt 2.6 %", "liability", 0, 135.2],
      ["2202", "Geschuldete MwSt 3.8 %", "liability", 0, 0],
      ["3000", "Beiträge Aktivmitglieder", "revenue", 0, 49440],
      ["3010", "Beiträge Passivmitglieder", "revenue", 0, 32280],
      ["3020", "Beiträge Jugend", "revenue", 0, 3840],
      ["3030", "Gönnerbeiträge", "revenue", 0, 7100],
      ["3100", "Inserate Vereinsheft", "revenue", 0, 12450],
      ["3110", "Verpflegungspauschalen", "revenue", 0, 5200],
      ["3400", "Mahngebühren", "revenue", 0, 340],
      ["3900", "Erlösminderungen (Gutschriften)", "revenue", 1150, 0],
    ] as const
  ).map(([number, name, type, debit, credit]) => ({
    number,
    name,
    type,
    debitCents: cents(debit),
    creditCents: cents(credit),
    balanceCents: cents(debit) - cents(credit),
  })),
});

const statements = (from: string, to: string): StatementsReport => ({
  from,
  to,
  income: {
    revenue: [
      ["3000", "Beiträge Aktivmitglieder", 49440],
      ["3010", "Beiträge Passivmitglieder", 32280],
      ["3020", "Beiträge Jugend", 3840],
      ["3030", "Gönnerbeiträge", 7100],
      ["3100", "Inserate Vereinsheft", 12450],
      ["3110", "Verpflegungspauschalen", 5200],
      ["3400", "Mahngebühren", 340],
      ["3900", "Erlösminderungen (Gutschriften)", -1150],
    ].map(([number, name, chf]) => ({
      number: String(number),
      name: String(name),
      amountCents: cents(Number(chf)),
    })),
    expenses: [],
    revenueCents: cents(109500),
    expenseCents: 0,
    resultCents: cents(109500),
  },
  balance: {
    assets: [
      { number: "1020", name: "Bank Zahlungsverkehr", amountCents: cents(92003.2) },
      { number: "1100", name: "Debitoren Mitglieder", amountCents: cents(9365) },
      { number: "1101", name: "Debitoren Firmen", amountCents: cents(9275.45) },
    ],
    liabilities: [
      { number: "2200", name: "Geschuldete MwSt 8.1 %", amountCents: cents(1008.45) },
      { number: "2201", name: "Geschuldete MwSt 2.6 %", amountCents: cents(135.2) },
      { number: "2202", name: "Geschuldete MwSt 3.8 %", amountCents: 0 },
    ],
    assetsCents: cents(110643.65),
    liabilitiesCents: cents(110643.65),
    resultCents: cents(109500),
  },
});

const vat = (from: string, to: string): VatReport => ({
  from,
  to,
  method: "effective",
  turnover: {
    totalCents: cents(109500),
    adjustments: [
      { kind: "contributions", cents: cents(-92660) },
      { kind: "dunningFees", cents: cents(-340) },
      { kind: "creditNotes", cents: cents(1150) },
    ],
    taxableCents: cents(17650),
  },
  rates: [
    { rateBp: 810, turnoverCents: cents(12450), taxCents: cents(1008.45), account: "2200" },
    { rateBp: 260, turnoverCents: cents(5200), taxCents: cents(135.2), account: "2201" },
    { rateBp: 380, turnoverCents: 0, taxCents: 0, account: "2202" },
  ],
  payableCents: cents(1143.65),
  preview: true,
});

/** Ertrag je Monat des Zeitraums: verteilt den Ertrag der Erfolgsrechnung (Board 6.4) über die Monate; Aufwand wie dort 0. */
function monthly(from: string, to: string): MonthlyReport {
  const months: string[] = [];
  let y = +from.slice(0, 4);
  let m = +from.slice(5, 7);
  while (y * 12 + m <= +to.slice(0, 4) * 12 + +to.slice(5, 7)) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) [y, m] = [y + 1, 1];
  }
  const weight = (i: number) => 8 + ((i * 5) % 7);
  const weights = months.reduce((s, _, i) => s + weight(i), 0);
  let rest = cents(109500);
  return {
    from,
    to,
    rows: months.map((month, i) => {
      const revenue =
        i === months.length - 1 ? rest : Math.round((cents(109500) * weight(i)) / weights);
      rest -= revenue;
      return {
        month,
        revenueCents: revenue,
        expenseCents: 0,
        resultCents: revenue,
        invoicedCents: Math.round(revenue * 0.9),
        settledCents: Math.round(revenue * 0.8),
      };
    }),
  };
}

const MONTHS = [
  ["Januar", 31, 330, "2026-02-03T09:10:00"],
  ["Februar", 28, 298, "2026-03-04T09:13:00"],
  ["März", 31, 301, "2026-04-05T09:16:00"],
  ["April", 30, 312, "2026-05-06T09:19:00"],
  ["Mai", 31, 296, "2026-06-07T09:22:00"],
  ["Juni", 30, 305, "2026-07-03T09:25:00"],
  ["Juli", 31, 318, "2026-08-04T09:28:00"],
  ["August", 31, 294, "2026-09-05T09:31:00"],
  ["September", 30, 340, "2026-10-06T09:34:00"],
  ["Oktober", 31, 330, undefined],
  ["November", 30, 2, undefined],
  ["Dezember", 31, 0, undefined],
] as const;

function periods(): PeriodInfo[] {
  return MONTHS.map(([name, days, bookings, closedAt], i) => {
    const mm = String(i + 1).padStart(2, "0");
    return {
      id: `p-${mm}`,
      label: `${name} 2026`,
      from: `2026-${mm}-01`,
      to: `2026-${mm}-${days}`,
      state: closedAt ? "closed" : "open",
      ...(closedAt ? { closedAt, closedBy: "Sabine Muster" } : {}),
      bookings,
      warnings: 0,
    };
  });
}

const checks: PeriodCheck[] = [
  {
    id: "invoicesBooked",
    title: "Alle versendeten Rechnungen sind gebucht",
    result: "58 Rechnungen im Oktober",
    status: "ok",
  },
  {
    id: "trialBalance",
    title: "Saldenliste ist ausgeglichen",
    result: "Soll = Haben = CHF 204'946.85",
    status: "ok",
  },
  {
    id: "openItems",
    title: "Offene Posten stimmen mit den Debitorenkonten überein",
    result: "CHF 18'640.45 in beiden Listen",
    status: "ok",
  },
  {
    id: "paymentImports",
    title: "Zahlungsimporte sind vollständig zugeordnet",
    result: "3 Restposten über CHF 1'466.00 offen",
    status: "warning",
    warningName: "Restposten",
    action: { kind: "leftovers", label: "Restposten ansehen" },
  },
  {
    id: "drafts",
    title: "Rechnungsentwürfe mit Datum in der Periode",
    result: "2 Entwürfe sind nicht versendet und nicht gebucht",
    status: "warning",
    warningName: "Entwürfe",
    action: { kind: "drafts", label: "Entwürfe ansehen" },
  },
  {
    id: "vat",
    title: "MwSt-Abrechnung geprüft",
    result: "Bestätigt, geschuldete Steuer CHF 1'143.65",
    status: "ok",
    action: { kind: "vat", label: "Abrechnung ansehen" },
    confirm: { confirmed: true },
  },
  {
    id: "predecessors",
    title: "Vorherige Perioden sind abgeschlossen",
    result: "Januar bis September 2026",
    status: "ok",
  },
];

export interface MemoryOptions {
  /** Ersetzt die Prüfpunkte der Periode (Tests für Fehler und Warnungen). */
  checks?: PeriodCheck[];
  /** Lässt Perioden-Details weg, wie sie die API heute nicht liefert. */
  bare?: boolean;
  /** Zeitpunkt des Abschlusses. */
  closedAt?: string;
}

export function createMemoryReportsService(options: MemoryOptions = {}): ReportsService & {
  /** Aufrufe in Reihenfolge, für Tests. */
  calls: string[];
} {
  const list = periods();
  const calls: string[] = [];
  let vatConfirmed = true;
  /** Prüfpunkte der Periode; nimmt die Person die Bestätigung der MwSt-Abrechnung zurück, wird daraus eine Warnung. */
  const currentChecks = (): PeriodCheck[] =>
    options.checks ??
    checks.map((c) =>
      c.id !== "vat" || vatConfirmed
        ? c
        : {
            ...c,
            status: "warning",
            warningName: "MwSt-Abrechnung",
            result: "Noch nicht bestätigt, geschuldete Steuer CHF 1'143.65",
            confirm: { confirmed: false },
          },
    );
  const review = (id: string): PeriodReview => {
    const period = list.find((p) => p.id === id)!;
    return {
      period,
      checks: period.state === "closed" ? [] : currentChecks(),
      ...(options.bare
        ? {}
        : {
            leftovers: [
              {
                id: "l1",
                valueDate: "2026-10-28",
                payer: "Beispiel Bäckerei GmbH",
                amountCents: cents(846),
                reason: "Referenz fehlt",
              },
              {
                id: "l2",
                valueDate: "2026-10-27",
                payer: "Lukas Probe",
                amountCents: cents(100),
                reason: "Betrag weicht ab",
              },
              {
                id: "l3",
                valueDate: "2026-10-26",
                payer: "Irene Demo",
                amountCents: cents(520),
                reason: "Rechnung bereits bezahlt",
              },
            ],
            stats: { bookings: 330, invoices: 58, payments: 41, reversals: 2 },
          }),
    };
  };
  return {
    calls,
    settings: async () => ({ vatNumber: "CHE-000.000.000 MWST", fiscalYearStartMonth: 1 }),
    openItems: async (asOf) => ({ asOf, rows: openItems() }),
    debtors: async (asOf) => ({
      asOf,
      rows: options.bare
        ? debtors().map((d) => ({
            id: d.id,
            number: d.number,
            name: d.name,
            items: d.items,
            oldestDueDate: d.oldestDueDate,
            overdueDays: d.overdueDays,
            balanceCents: d.balanceCents,
          }))
        : debtors(),
      ...(options.bare
        ? {}
        : {
            accounts: [
              {
                number: "1100",
                name: "Debitoren Mitglieder",
                debtors: 47,
                items: 57,
                balanceCents: cents(9365),
              },
              {
                number: "1101",
                name: "Debitoren Firmen",
                debtors: 14,
                items: 17,
                balanceCents: cents(9275.45),
              },
            ],
          }),
    }),
    trialBalance: async (from, to) => trialBalance(from, to),
    statements: async (from, to) => statements(from, to),
    vat: async (from, to) => vat(from, to),
    monthly: async (from, to) => monthly(from, to),
    periods: async () => list.map((p) => ({ ...p })),
    reviewPeriod: async (id) => {
      calls.push(`review:${id}`);
      return review(id);
    },
    cancelReview: async (id) => {
      calls.push(`cancel:${id}`);
    },
    confirmVat: async (id, confirmed) => {
      calls.push(`vat:${id}:${confirmed}`);
      vatConfirmed = confirmed;
    },
    closePeriod: async (id) => {
      calls.push(`close:${id}`);
      const p = list.find((x) => x.id === id)!;
      p.state = "closed";
      p.closedAt = options.closedAt ?? "2026-11-02T14:52:00";
      p.closedBy = "Sabine Muster";
      p.warnings = currentChecks().filter((c) => c.status === "warning").length;
      return { ...p };
    },
    exportReport: async (name, query, format) => {
      calls.push(`export:${name}:${format}:${JSON.stringify(query)}`);
      return { filename: `${name}.${format}`, blob: new Blob([name]) };
    },
    exportPeriodReport: async (id) => {
      calls.push(`export-period:${id}`);
      return { filename: "abschlussbericht.pdf", blob: new Blob([id]) };
    },
  };
}
