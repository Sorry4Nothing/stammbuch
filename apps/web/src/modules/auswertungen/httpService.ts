import { t, tp } from "../../i18n";
import { daysBetween, formatChf } from "./format";
import type {
  Bucket,
  DebtorAccountSummary,
  DebtorsReport,
  ExportFile,
  ExportName,
  Leftover,
  MonthlyReport,
  OpenItemsReport,
  PeriodCheck,
  PeriodInfo,
  PeriodReview,
  ReportSettings,
  ReportsService,
  StatementRow,
  StatementsReport,
  TrialBalanceReport,
  VatReport,
} from "./types";

/** Antwort der API, die nicht erwartet wurde. Nur Status und Code, nie der Text der Antwort (ausser feste Sätze der Periodenregeln). */
export class ReportsError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    /** Fester Satz der API, der für den Nutzer bestimmt ist. */
    readonly text?: string,
  ) {
    super(text ?? `Unerwartete Antwort der Auswertungs-API (${status})`);
  }
}

export interface HttpOptions {
  fetchFn?: typeof fetch;
  csrfToken: () => string | null;
  /** Wird bei 401 aufgerufen (Sitzung abgelaufen, Design 2.7). */
  onUnauthorized: () => void;
}

const PAGE = 500;

interface RawIssue {
  code: string;
  severity: "error" | "warning";
}
interface RawPeriod {
  id: string;
  label: string;
  from: string;
  to: string;
  state: "open" | "checked" | "closed";
  issues: RawIssue[];
  history: { at: string; to: string }[];
  /** Bestätigung der MwSt-Abrechnung; fehlt, solange niemand sie bestätigt hat. */
  vatConfirmation?: { at: string; actor: string };
  /** Anzahl Buchungen und Name der abschliessenden Person; die API lässt sie weg, wenn sie sie nicht kennt. */
  bookings?: number;
  closedBy?: string;
}
interface RawFacts {
  invoices: { total: number; unbooked: number };
  drafts: number;
  leftovers: { count: number; totalCents: number; rows: Leftover[] };
  stats: { bookings: number; invoices: number; payments: number; reversals: number };
}
interface Paged<T> {
  rows: T[];
  page: { total: number };
}

const rows = (list: { number: string; name: string; amountCents: number }[]): StatementRow[] =>
  list.map((r) => ({ number: r.number, name: r.name, amountCents: r.amountCents }));

/**
 * `ReportsService` gegen die Routen unter `/reports` (gleiche Origin, Cookie-Sitzung). Schreibende
 * Anfragen tragen das CSRF-Token.
 */
export function createHttpReportsService(options: HttpOptions): ReportsService {
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function send(
    method: "GET" | "POST",
    path: string,
    query?: Record<string, string>,
    body?: unknown,
  ) {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const token = options.csrfToken();
    if (token && method !== "GET") headers["X-CSRF-Token"] = token;
    const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
    const res = await fetchFn(`${path}${qs}`, {
      method,
      headers,
      credentials: "same-origin",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 401) {
      options.onUnauthorized();
      throw new ReportsError(401);
    }
    return res;
  }

  async function json<T>(
    method: "GET" | "POST",
    path: string,
    query?: Record<string, string>,
    payload?: unknown,
  ) {
    const res = await send(method, path, query, payload);
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const e = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      const code = typeof e?.code === "string" ? e.code : undefined;
      // Feste Sätze der Periodenregeln («Seit der Prüfung wurde gebucht.») sind für den Nutzer bestimmt.
      const text = res.status === 409 && typeof e?.message === "string" ? e.message : undefined;
      throw new ReportsError(res.status, code, text);
    }
    return body as T;
  }

  /** Holt alle Zeilen eines Berichts seitenweise. */
  async function all<R extends Paged<unknown>>(name: string, query: Record<string, string>) {
    let first: R | undefined;
    const out: R["rows"] = [];
    for (let offset = 0; ; offset += PAGE) {
      const r = await json<R>("GET", `/reports/${name}`, {
        ...query,
        limit: String(PAGE),
        offset: String(offset),
      });
      first ??= r;
      out.push(...r.rows);
      if (out.length >= r.page.total || r.rows.length === 0) return { ...first, rows: out } as R;
    }
  }

  const rawPeriods = async () =>
    (await json<{ periods: RawPeriod[] }>("GET", "/reports/periods")).periods;

  const info = (p: RawPeriod): PeriodInfo => ({
    id: p.id,
    label: p.label,
    from: p.from,
    to: p.to,
    state: p.state,
    ...(p.state === "closed"
      ? {
          closedAt: [...p.history].reverse().find((h) => h.to === "closed")?.at,
          ...(p.closedBy ? { closedBy: p.closedBy } : {}),
        }
      : {}),
    ...(p.bookings !== undefined ? { bookings: p.bookings } : {}),
    warnings: p.issues.filter((i) => i.severity === "warning").length,
  });

  async function checksOf(
    p: RawPeriod,
    others: RawPeriod[],
    facts: RawFacts,
  ): Promise<PeriodCheck[]> {
    const has = (...codes: string[]) => p.issues.some((i) => codes.includes(i.code));
    const [tb, debtors, vat] = await Promise.all([
      json<{ totals: { debitCents: number; creditCents: number } }>(
        "GET",
        "/reports/trial-balance",
        { from: p.from, to: p.to, limit: "1" },
      ),
      json<{ totals: { openCents: number; differenceCents: number } }>("GET", "/reports/debtors", {
        asOf: p.to,
        limit: "1",
      }),
      json<{
        rows: { rateBp: number; taxCents: number }[];
        totals: { payableCents: number };
      }>("GET", "/reports/vat", {
        from: p.from,
        to: p.to,
        method: "effective",
        limit: String(PAGE),
      }),
    ]);
    const checks: PeriodCheck[] = [];

    const unbooked = has("INVOICE_NOT_BOOKED");
    checks.push({
      id: "invoicesBooked",
      title: t("closing.check.invoicesBooked"),
      status: unbooked ? "error" : "ok",
      result: unbooked
        ? tp("closing.result.invoicesOff", facts.invoices.unbooked)
        : facts.invoices.total === 0
          ? t("closing.result.invoices.none")
          : tp("closing.result.invoices", facts.invoices.total),
    });

    const unbalanced = has("TRIAL_BALANCE_UNBALANCED", "BOOKING_UNBALANCED");
    checks.push({
      id: "trialBalance",
      title: t("closing.check.trialBalance"),
      status: unbalanced ? "error" : "ok",
      result: unbalanced
        ? t("closing.result.trialBalanceOff", {
            debit: formatChf(tb.totals.debitCents),
            credit: formatChf(tb.totals.creditCents),
          })
        : t("closing.result.trialBalance", { total: formatChf(tb.totals.debitCents) }),
    });

    const mismatch = has("DEBTOR_CONTROL_MISMATCH");
    checks.push({
      id: "openItems",
      title: t("closing.check.openItems"),
      status: mismatch ? "error" : "ok",
      result: mismatch
        ? t("closing.result.openItemsOff", { diff: formatChf(debtors.totals.differenceCents) })
        : t("closing.result.openItems", { total: formatChf(debtors.totals.openCents) }),
    });

    if (has("BALANCE_SHEET_UNBALANCED")) {
      checks.push({
        id: "balanceSheet",
        title: t("closing.check.balanceSheet"),
        status: "error",
        result: t("closing.result.balanceSheetOff"),
      });
    }
    if (has("UNKNOWN_ACCOUNT")) {
      checks.push({
        id: "accounts",
        title: t("closing.check.accounts"),
        status: "error",
        result: t("closing.result.accountsOff"),
      });
    }
    const overpaid = p.issues.filter((i) => i.code === "OVERPAID_ITEM").length;
    if (overpaid > 0) {
      checks.push({
        id: "overpaid",
        title: t("closing.check.overpaid"),
        status: "warning",
        warningName: t("closing.warning.overpaid"),
        result: t("closing.result.overpaid", { n: overpaid }),
      });
    }

    const leftovers = has("PAYMENT_LEFTOVERS");
    checks.push({
      id: "paymentImports",
      title: t("closing.check.paymentImports"),
      status: leftovers ? "warning" : "ok",
      ...(leftovers
        ? {
            warningName: t("closing.warning.leftovers"),
            action: { kind: "leftovers" as const, label: t("closing.action.leftovers") },
          }
        : {}),
      result: leftovers
        ? tp("closing.result.leftovers", facts.leftovers.count, {
            total: formatChf(facts.leftovers.totalCents),
          })
        : t("closing.result.paymentImports"),
    });

    const drafts = has("DRAFT_INVOICES");
    checks.push({
      id: "drafts",
      title: t("closing.check.drafts"),
      status: drafts ? "warning" : "ok",
      ...(drafts
        ? {
            warningName: t("closing.warning.drafts"),
            action: { kind: "drafts" as const, label: t("closing.action.drafts") },
          }
        : {}),
      result: drafts ? tp("closing.result.drafts", facts.drafts) : t("closing.result.drafts.none"),
    });

    // MwSt: nur Perioden mit MwSt-Buchungen brauchen die Bestätigung der Person; die API warnt zusätzlich bei
    // Abweichung von den Steuerkonten und wenn sich die Abrechnung nach der Bestätigung geändert hat.
    const vatActive = vat.rows.some((r) => r.rateBp > 0 || r.taxCents !== 0);
    const total = formatChf(vat.totals.payableCents);
    const vatChanged = has("VAT_NOT_CONFIRMED") && p.vatConfirmation !== undefined;
    const vatMismatch = has("VAT_ACCOUNT_MISMATCH");
    const vatOpen = has("VAT_NOT_CONFIRMED");
    checks.push({
      id: "vat",
      title: t("closing.check.vat"),
      status: !vatActive ? "ok" : vatMismatch || vatOpen ? "warning" : "ok",
      ...(vatActive
        ? {
            confirm: { confirmed: !vatOpen },
            action: { kind: "vat" as const, label: t("closing.action.vat") },
            ...(vatMismatch || vatOpen ? { warningName: t("closing.warning.vat") } : {}),
          }
        : {}),
      result: !vatActive
        ? t("closing.result.vat.none")
        : vatMismatch
          ? t("closing.result.vat.mismatch", { total })
          : vatChanged
            ? t("closing.result.vat.changed", { total })
            : vatOpen
              ? t("closing.result.vat.open", { total })
              : t("closing.result.vat.ok", { total }),
    });

    const before = others.filter((o) => o.to < p.from);
    const open = before.filter((o) => o.state !== "closed");
    checks.push({
      id: "predecessors",
      title: t("closing.check.predecessors"),
      status: open.length > 0 ? "error" : "ok",
      result:
        open.length > 0
          ? t("closing.result.predecessorsOpen", { n: open.length })
          : before.length === 0
            ? t("closing.result.predecessorsNone")
            : before.length === 1
              ? before[0]!.label
              : t("closing.result.predecessors", {
                  from: before[0]!.label,
                  to: before[before.length - 1]!.label,
                }),
    });
    return checks;
  }

  return {
    async settings(): Promise<ReportSettings> {
      const org = await json<{
        master?: { vatNumber?: string };
        "fiscal-year"?: { startMonth?: number };
      }>("GET", "/settings/organisation");
      return {
        vatNumber: org.master?.vatNumber ?? "",
        fiscalYearStartMonth: org["fiscal-year"]?.startMonth ?? 1,
      };
    },

    async openItems(asOf): Promise<OpenItemsReport> {
      const r = await all<
        Paged<{
          itemId: string;
          reference: string;
          debtorNumber: string;
          debtorName: string;
          issueDate: string;
          dueDate: string;
          daysOverdue: number;
          bucket: Bucket;
          openCents: number;
        }>
      >("open-items", { asOf });
      return {
        asOf,
        rows: r.rows.map((i) => ({
          id: i.itemId,
          reference: i.reference,
          debtorNumber: i.debtorNumber,
          debtorName: i.debtorName,
          issueDate: i.issueDate,
          dueDate: i.dueDate,
          daysOverdue: i.daysOverdue,
          bucket: i.bucket,
          openCents: i.openCents,
        })),
      };
    },

    async debtors(asOf): Promise<DebtorsReport> {
      const r = await all<
        Paged<{
          debtorId: string;
          number: string;
          name: string;
          itemCount: number;
          openCents: number;
          oldestDueDate: string;
          type?: "company" | "person";
          dunningLevel?: number;
        }> & { accounts?: DebtorAccountSummary[] }
      >("debtors", { asOf });
      return {
        asOf,
        rows: r.rows.map((d) => ({
          id: d.debtorId,
          number: d.number,
          name: d.name,
          ...(d.type ? { type: d.type } : {}),
          items: d.itemCount,
          oldestDueDate: d.oldestDueDate,
          overdueDays: Math.max(0, daysBetween(d.oldestDueDate, asOf)),
          balanceCents: d.openCents,
          ...(d.dunningLevel !== undefined ? { dunningLevel: d.dunningLevel } : {}),
        })),
        ...(r.accounts ? { accounts: r.accounts } : {}),
      };
    },

    async trialBalance(from, to): Promise<TrialBalanceReport> {
      const r = await all<
        Paged<{
          number: string;
          name: string;
          type: TrialBalanceReport["rows"][number]["type"];
          debitCents: number;
          creditCents: number;
          closingCents: number;
        }>
      >("trial-balance", { from, to });
      return {
        from,
        to,
        rows: r.rows.map((a) => ({
          number: a.number,
          name: a.name,
          type: a.type,
          debitCents: a.debitCents,
          creditCents: a.creditCents,
          balanceCents: a.closingCents,
        })),
      };
    },

    async statements(from, to): Promise<StatementsReport> {
      type Row = { number: string; name: string; type: string; amountCents: number };
      const [is, bs] = await Promise.all([
        all<
          Paged<Row> & {
            totals: { revenueCents: number; expenseCents: number; resultCents: number };
          }
        >("income-statement", { from, to }),
        all<
          Paged<Row> & {
            totals: { assetsCents: number; liabilitiesAndEquityCents: number; resultCents: number };
          }
        >("balance-sheet", { asOf: to }),
      ]);
      return {
        from,
        to,
        income: {
          revenue: rows(is.rows.filter((r) => r.type === "revenue")),
          expenses: rows(is.rows.filter((r) => r.type === "expense")),
          ...is.totals,
        },
        balance: {
          assets: rows(bs.rows.filter((r) => r.type === "asset")),
          liabilities: rows(bs.rows.filter((r) => r.type !== "asset")),
          assetsCents: bs.totals.assetsCents,
          liabilitiesCents: bs.totals.liabilitiesAndEquityCents,
          resultCents: bs.totals.resultCents,
        },
      };
    },

    async vat(from, to): Promise<VatReport> {
      const [r, periods] = await Promise.all([
        json<{
          method: "effective" | "saldo";
          rows: {
            kind: "output" | "input";
            rateBp: number;
            netCents: number;
            taxCents: number;
            account?: string;
          }[];
          totals: {
            turnoverCents: number;
            untaxedCents?: number;
            untaxedBreakdown?: {
              contributionsCents: number;
              dunningFeesCents: number;
              creditNotesCents: number;
              otherCents: number;
            };
            payableCents: number;
          };
        }>("GET", "/reports/vat", { from, to, method: "effective", limit: String(PAGE) }),
        rawPeriods(),
      ]);
      const output = r.rows.filter((x) => x.kind === "output");
      const b = r.totals.untaxedBreakdown;
      return {
        from,
        to,
        method: r.method,
        turnover: {
          totalCents: r.totals.turnoverCents,
          // Umsatz ohne Steuersatz (0 %) als Abzug zwischen Gesamt- und steuerbarem Umsatz, nach Herkunft aus den
          // Buchungen: Beiträge, Mahngebühren (Konto 3600), Gutschriften; was sich nicht zuordnen lässt, bleibt «übrig».
          ...(b
            ? {
                adjustments: [
                  { kind: "contributions" as const, cents: -b.contributionsCents || 0 },
                  { kind: "dunningFees" as const, cents: -b.dunningFeesCents || 0 },
                  { kind: "creditNotes" as const, cents: -b.creditNotesCents || 0 },
                  ...(b.otherCents ? [{ kind: "untaxed" as const, cents: -b.otherCents }] : []),
                ],
              }
            : r.totals.untaxedCents
              ? { adjustments: [{ kind: "untaxed" as const, cents: -r.totals.untaxedCents }] }
              : {}),
          taxableCents: output.filter((x) => x.rateBp > 0).reduce((s, x) => s + x.netCents, 0),
        },
        rates: output
          .filter((x) => x.rateBp > 0)
          .map((x) => ({
            rateBp: x.rateBp,
            turnoverCents: x.netCents,
            taxCents: x.taxCents,
            ...(x.account ? { account: x.account } : {}),
          })),
        payableCents: r.totals.payableCents,
        // Solange nicht jede Periode des Zeitraums abgeschlossen ist, bleibt es eine Vorschau.
        preview:
          periods.length === 0 ||
          periods.some((p) => p.state !== "closed" && p.from <= to && p.to >= from),
      };
    },

    async monthly(from, to): Promise<MonthlyReport> {
      const r = await json<{ rows: MonthlyReport["rows"] }>("GET", "/reports/monthly-result", {
        from,
        to,
        limit: String(PAGE),
      });
      return { from, to, rows: r.rows };
    },

    async periods() {
      // Legt fehlende Monatsperioden an (idempotent) und liefert die Liste.
      const r = await json<{ periods: RawPeriod[] }>("POST", "/reports/periods/ensure");
      return r.periods.map(info);
    },

    async reviewPeriod(id): Promise<PeriodReview> {
      const list = await rawPeriods();
      let p = list.find((x) => x.id === id);
      if (!p) throw new ReportsError(404, "NOT_FOUND");
      // Die Prüfung läuft nur aus `open`; eine geprüfte Periode zeigt ihren gespeicherten Befund.
      if (p.state === "open") p = await json<RawPeriod>("POST", `/reports/periods/${id}/check`);
      if (p.state === "closed") return { period: info(p), checks: [] };
      const facts = await json<RawFacts>("GET", `/reports/periods/${id}/facts`);
      return {
        period: info(p),
        checks: await checksOf(p, list, facts),
        leftovers: facts.leftovers.rows,
        stats: facts.stats,
      };
    },

    async cancelReview(id) {
      const list = await rawPeriods();
      if (list.find((x) => x.id === id)?.state === "checked") {
        await json("POST", `/reports/periods/${id}/revoke-check`);
      }
    },

    async confirmVat(id, confirmed) {
      await json("POST", `/reports/periods/${id}/vat-confirmation`, undefined, { confirmed });
    },

    async closePeriod(id) {
      return info(await json<RawPeriod>("POST", `/reports/periods/${id}/confirm`));
    },

    async exportReport(name: ExportName, query, format): Promise<ExportFile> {
      const res = await send("GET", `/reports/${name}/export`, { ...query, format });
      if (!res.ok) throw new ReportsError(res.status);
      return { filename: `${name}.${format}`, blob: await res.blob() };
    },

    async exportPeriodReport(id): Promise<ExportFile> {
      const res = await send("GET", `/reports/periods/${id}/export`, { format: "pdf" });
      if (!res.ok) throw new ReportsError(res.status);
      return { filename: "abschlussbericht.pdf", blob: await res.blob() };
    },
  };
}
