import { t } from "../../i18n";
import { daysBetween, formatChf } from "./format";
import type {
  Bucket,
  DebtorsReport,
  ExportFile,
  ExportName,
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
}
interface Paged<T> {
  rows: T[];
  page: { total: number };
}

const rows = (list: { number: string; name: string; amountCents: number }[]): StatementRow[] =>
  list.map((r) => ({ number: r.number, name: r.name, amountCents: r.amountCents }));

/**
 * `ReportsService` gegen die Routen unter `/reports` (gleiche Origin, Cookie-Sitzung). Schreibende
 * Anfragen tragen das CSRF-Token. Die Perioden-Prüfung der API kennt weniger Prüfpunkte als das
 * Design; die übrigen entfallen (siehe «Fehlende API»).
 */
export function createHttpReportsService(options: HttpOptions): ReportsService {
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function send(method: "GET" | "POST", path: string, query?: Record<string, string>) {
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = options.csrfToken();
    if (token && method !== "GET") headers["X-CSRF-Token"] = token;
    const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
    const res = await fetchFn(`${path}${qs}`, { method, headers, credentials: "same-origin" });
    if (res.status === 401) {
      options.onUnauthorized();
      throw new ReportsError(401);
    }
    return res;
  }

  async function json<T>(method: "GET" | "POST", path: string, query?: Record<string, string>) {
    const res = await send(method, path, query);
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
      ? { closedAt: [...p.history].reverse().find((h) => h.to === "closed")?.at }
      : {}),
    warnings: p.issues.filter((i) => i.severity === "warning").length,
  });

  async function checksOf(p: RawPeriod, others: RawPeriod[]): Promise<PeriodCheck[]> {
    const has = (...codes: string[]) => p.issues.some((i) => codes.includes(i.code));
    const [tb, debtors] = await Promise.all([
      json<{ totals: { debitCents: number; creditCents: number } }>(
        "GET",
        "/reports/trial-balance",
        { from: p.from, to: p.to, limit: "1" },
      ),
      json<{ totals: { openCents: number; differenceCents: number } }>("GET", "/reports/debtors", {
        asOf: p.to,
        limit: "1",
      }),
    ]);
    const checks: PeriodCheck[] = [];

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
        }>
      >("debtors", { asOf });
      return {
        asOf,
        rows: r.rows.map((d) => ({
          id: d.debtorId,
          number: d.number,
          name: d.name,
          items: d.itemCount,
          oldestDueDate: d.oldestDueDate,
          overdueDays: Math.max(0, daysBetween(d.oldestDueDate, asOf)),
          balanceCents: d.openCents,
        })),
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
          rows: { kind: "output" | "input"; rateBp: number; netCents: number; taxCents: number }[];
          totals: { turnoverCents: number; payableCents: number };
        }>("GET", "/reports/vat", { from, to, method: "effective", limit: String(PAGE) }),
        rawPeriods(),
      ]);
      const output = r.rows.filter((x) => x.kind === "output");
      return {
        from,
        to,
        method: r.method,
        turnover: {
          totalCents: r.totals.turnoverCents,
          taxableCents: output.filter((x) => x.rateBp > 0).reduce((s, x) => s + x.netCents, 0),
        },
        rates: output
          .filter((x) => x.rateBp > 0)
          .map((x) => ({ rateBp: x.rateBp, turnoverCents: x.netCents, taxCents: x.taxCents })),
        payableCents: r.totals.payableCents,
        // Solange nicht jede Periode des Zeitraums abgeschlossen ist, bleibt es eine Vorschau.
        preview:
          periods.length === 0 ||
          periods.some((p) => p.state !== "closed" && p.from <= to && p.to >= from),
      };
    },

    async periods() {
      return (await rawPeriods()).map(info);
    },

    async reviewPeriod(id): Promise<PeriodReview> {
      const list = await rawPeriods();
      let p = list.find((x) => x.id === id);
      if (!p) throw new ReportsError(404, "NOT_FOUND");
      // Die Prüfung läuft nur aus `open`; eine geprüfte Periode zeigt ihren gespeicherten Befund.
      if (p.state === "open") p = await json<RawPeriod>("POST", `/reports/periods/${id}/check`);
      return { period: info(p), checks: p.state === "closed" ? [] : await checksOf(p, list) };
    },

    async cancelReview(id) {
      const list = await rawPeriods();
      if (list.find((x) => x.id === id)?.state === "checked") {
        await json("POST", `/reports/periods/${id}/revoke-check`);
      }
    },

    async closePeriod(id) {
      return info(await json<RawPeriod>("POST", `/reports/periods/${id}/confirm`));
    },

    async exportReport(name: ExportName, query, format): Promise<ExportFile> {
      const res = await send("GET", `/reports/${name}/export`, { ...query, format });
      if (!res.ok) throw new ReportsError(res.status);
      return { filename: `${name}.${format}`, blob: await res.blob() };
    },
  };
}
