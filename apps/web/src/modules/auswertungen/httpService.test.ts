import { describe, expect, it, vi } from "vitest";
import { createHttpReportsService, ReportsError } from "./httpService";

type Call = { url: string; method: string; headers: Record<string, string> };

/** Antwortet nach Pfad; hält die Aufrufe fest. */
function setup(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: Call[] = [];
  const onUnauthorized = vi.fn();
  const fetchFn = vi.fn((url: string, init: RequestInit) => {
    calls.push({
      url,
      method: String(init.method),
      headers: init.headers as Record<string, string>,
    });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) throw new Error(`keine Antwort für ${url}`);
    const r = routes[key]!;
    const body = r.body;
    return Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), { status: r.status ?? 200 }),
    );
  });
  const service = createHttpReportsService({
    fetchFn: fetchFn as unknown as typeof fetch,
    csrfToken: () => "tok",
    onUnauthorized,
  });
  return { calls, service, onUnauthorized };
}

const facts = (over: object = {}) => ({
  invoices: { total: 58, unbooked: 0 },
  drafts: 2,
  leftovers: {
    count: 3,
    totalCents: 146_600,
    rows: [
      {
        id: "l1",
        valueDate: "2026-10-28",
        payer: "Beispiel Bäckerei GmbH",
        amountCents: 84_600,
        reason: "Referenz fehlt",
      },
    ],
  },
  stats: { bookings: 330, invoices: 58, payments: 41, reversals: 2 },
  ...over,
});

const period = (over: object = {}) => ({
  id: "p1",
  label: "Oktober 2026",
  from: "2026-10-01",
  to: "2026-10-31",
  state: "open",
  issues: [],
  history: [],
  ...over,
});

describe("HTTP-Dienst der Auswertungen", () => {
  it("holt alle Seiten der offenen Posten und übernimmt die Felder", async () => {
    let n = 0;
    const row = (i: number) => ({
      itemId: `i${i}`,
      reference: `R-${i}`,
      debtorNumber: "M-1",
      debtorName: "Anna",
      issueDate: "2026-09-01",
      dueDate: "2026-10-01",
      daysOverdue: 5,
      bucket: "d1_30",
      openCents: 100,
    });
    const { service, calls } = setup({
      "/reports/open-items": {
        get body() {
          const offset = n++ * 500;
          return {
            rows: Array.from({ length: offset === 0 ? 500 : 20 }, (_, i) => row(offset + i)),
            page: { total: 520 },
          };
        },
      },
    });
    const report = await service.openItems("2026-11-02");
    expect(report.rows).toHaveLength(520);
    expect(report.rows[0]).toMatchObject({
      id: "i0",
      reference: "R-0",
      openCents: 100,
      bucket: "d1_30",
    });
    expect(calls[0]!.url).toBe("/reports/open-items?asOf=2026-11-02&limit=500&offset=0");
    expect(calls[1]!.url).toBe("/reports/open-items?asOf=2026-11-02&limit=500&offset=500");
    expect(calls[0]!.headers["X-CSRF-Token"]).toBeUndefined();
  });

  it("leitet die Tage der Debitoren aus der ältesten Fälligkeit ab", async () => {
    const { service } = setup({
      "/reports/debtors": {
        body: {
          rows: [
            {
              debtorId: "d1",
              number: "M-1",
              name: "Anna",
              itemCount: 2,
              openCents: 500,
              overdueCents: 500,
              oldestDueDate: "2026-10-31",
            },
            {
              debtorId: "d2",
              number: "M-2",
              name: "Ben",
              itemCount: 1,
              openCents: 100,
              overdueCents: 0,
              oldestDueDate: "2026-11-20",
            },
          ],
          page: { total: 2 },
        },
      },
    });
    const report = await service.debtors("2026-11-02");
    expect(report.rows.map((r) => r.overdueDays)).toEqual([2, 0]);
    expect(report.rows[0]!.type).toBeUndefined();
    expect(report.accounts).toBeUndefined();
  });

  it("übernimmt Art, Mahnstufe und Konten der Debitorenliste", async () => {
    const { service } = setup({
      "/reports/debtors": {
        body: {
          rows: [
            {
              debtorId: "d1",
              number: "M-1",
              name: "Anna",
              type: "person",
              itemCount: 2,
              openCents: 500,
              overdueCents: 500,
              oldestDueDate: "2026-10-31",
              dunningLevel: 2,
            },
          ],
          accounts: [
            { number: "1100", name: "Debitoren", debtors: 1, items: 2, balanceCents: 500 },
          ],
          page: { total: 1 },
        },
      },
    });
    const report = await service.debtors("2026-11-02");
    expect(report.rows[0]).toMatchObject({ type: "person", dunningLevel: 2 });
    expect(report.accounts).toEqual([
      { number: "1100", name: "Debitoren", debtors: 1, items: 2, balanceCents: 500 },
    ]);
  });

  it("übernimmt Steuerkonto und Umsatz ohne Steuersatz der MwSt-Abrechnung", async () => {
    const { service } = setup({
      "/reports/vat": {
        body: {
          method: "effective",
          rows: [
            { kind: "output", rateBp: 810, netCents: 1000, taxCents: 81, account: "2200" },
            { kind: "output", rateBp: 0, netCents: 500, taxCents: 0 },
          ],
          totals: { turnoverCents: 1500, untaxedCents: 500, payableCents: 81 },
        },
      },
      "/reports/periods": { body: { periods: [period({ state: "closed" })] } },
    });
    const vat = await service.vat("2026-01-01", "2026-10-31");
    expect(vat.rates).toEqual([
      { rateBp: 810, turnoverCents: 1000, taxCents: 81, account: "2200" },
    ]);
    expect(vat.turnover).toEqual({
      totalCents: 1500,
      adjustments: [{ kind: "untaxed", cents: -500 }],
      taxableCents: 1000,
    });
    expect(vat.preview).toBe(false);
  });

  it("zeigt in der MwSt-Abrechnung nur Umsatzsteuer und erkennt die Vorschau", async () => {
    const { service } = setup({
      "/reports/vat": {
        body: {
          method: "effective",
          rows: [
            { kind: "output", rateBp: 810, netCents: 1000, taxCents: 81 },
            { kind: "output", rateBp: 0, netCents: 500, taxCents: 0 },
            { kind: "input", rateBp: 810, netCents: 100, taxCents: 8 },
          ],
          totals: { turnoverCents: 1500, payableCents: 73 },
        },
      },
      "/reports/periods": {
        body: { periods: [period({ state: "closed" }), period({ id: "p2" })] },
      },
    });
    const vat = await service.vat("2026-01-01", "2026-11-02");
    expect(vat.rates).toEqual([{ rateBp: 810, turnoverCents: 1000, taxCents: 81 }]);
    expect(vat.turnover).toEqual({ totalCents: 1500, taxableCents: 1000 });
    expect(vat.payableCents).toBe(73);
    expect(vat.preview).toBe(true);
  });

  it("prüft eine offene Periode mit CSRF-Token und baut die Prüfpunkte", async () => {
    const checked = period({
      state: "checked",
      issues: [
        { code: "OVERPAID_ITEM", severity: "warning", message: "x" },
        { code: "OVERPAID_ITEM", severity: "warning", message: "y" },
        { code: "PAYMENT_LEFTOVERS", severity: "warning", message: "z" },
        { code: "DRAFT_INVOICES", severity: "warning", message: "w" },
      ],
    });
    const { service, calls } = setup({
      "/reports/periods/p1/check": { body: checked },
      "/reports/periods/p1/facts": { body: facts() },
      "/reports/periods": {
        body: {
          periods: [
            period({
              id: "p0",
              label: "September 2026",
              from: "2026-09-01",
              to: "2026-09-30",
              state: "closed",
            }),
            period(),
          ],
        },
      },
      "/reports/trial-balance": {
        body: { totals: { debitCents: 20494685, creditCents: 20494685 } },
      },
      "/reports/debtors": { body: { totals: { openCents: 1864045, differenceCents: 0 } } },
    });
    const review = await service.reviewPeriod("p1");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/reports/periods/p1/check");
    expect(post.headers["X-CSRF-Token"]).toBe("tok");
    expect(review.period.state).toBe("checked");
    expect(review.period.warnings).toBe(4);
    expect(review.checks.map((c) => [c.id, c.status, c.result])).toEqual([
      ["invoicesBooked", "ok", "58 Rechnungen in der Periode"],
      ["trialBalance", "ok", "Soll = Haben = CHF 204'946.85"],
      ["openItems", "ok", "CHF 18'640.45 in beiden Listen"],
      ["overpaid", "warning", "2 Rechnungen sind überzahlt"],
      ["paymentImports", "warning", "3 Restposten über CHF 1'466.00 offen"],
      ["drafts", "warning", "2 Entwürfe sind nicht versendet und nicht gebucht"],
      ["predecessors", "ok", "September 2026"],
    ]);
    expect(review.checks.find((c) => c.id === "paymentImports")).toMatchObject({
      warningName: "Restposten",
      action: { kind: "leftovers", label: "Restposten ansehen" },
    });
    expect(review.checks.find((c) => c.id === "drafts")?.action?.kind).toBe("drafts");
    expect(review.leftovers).toEqual(facts().leftovers.rows);
    expect(review.stats).toEqual({ bookings: 330, invoices: 58, payments: 41, reversals: 2 });
  });

  it("meldet nicht gebuchte Rechnungen als nicht erfüllt", async () => {
    const { service } = setup({
      "/reports/periods/p1/check": {
        body: period({
          issues: [{ code: "INVOICE_NOT_BOOKED", severity: "error", message: "x" }],
        }),
      },
      "/reports/periods/p1/facts": {
        body: facts({
          invoices: { total: 5, unbooked: 1 },
          leftovers: { count: 0, totalCents: 0, rows: [] },
          drafts: 0,
        }),
      },
      "/reports/periods": { body: { periods: [period()] } },
      "/reports/trial-balance": { body: { totals: { debitCents: 0, creditCents: 0 } } },
      "/reports/debtors": { body: { totals: { openCents: 0, differenceCents: 0 } } },
    });
    const review = await service.reviewPeriod("p1");
    expect(review.checks.slice(0, 1).map((c) => [c.id, c.status, c.result])).toEqual([
      ["invoicesBooked", "error", "1 Rechnung ist nicht gebucht"],
    ]);
    expect(review.checks.find((c) => c.id === "paymentImports")).toMatchObject({
      status: "ok",
      result: "Alle Zahlungen sind zugeordnet",
    });
    expect(review.checks.find((c) => c.id === "drafts")?.result).toBe("Keine Entwürfe");
  });

  it("legt Monatsperioden an und übernimmt Namen und Buchungsanzahl", async () => {
    const { service, calls } = setup({
      "/reports/periods/ensure": {
        body: {
          periods: [
            period({
              state: "closed",
              history: [{ at: "2026-11-02T13:52:00Z", to: "closed" }],
              closedBy: "Sabine Muster",
              bookings: 330,
            }),
            period({ id: "p2", bookings: 0 }),
          ],
        },
      },
    });
    const list = await service.periods();
    expect(calls[0]).toMatchObject({ method: "POST", url: "/reports/periods/ensure" });
    expect(calls[0]!.headers["X-CSRF-Token"]).toBe("tok");
    expect(list[0]).toMatchObject({ closedBy: "Sabine Muster", bookings: 330 });
    expect(list[1]).toMatchObject({ bookings: 0 });
    expect(list[1]).not.toHaveProperty("closedBy");
  });

  it("schliesst die geprüfte Periode ab und übernimmt den Zeitpunkt", async () => {
    const { service, calls } = setup({
      "/reports/periods/p1/confirm": {
        body: period({
          state: "closed",
          history: [{ at: "2026-11-02T13:52:00Z", to: "closed" }],
        }),
      },
    });
    const closed = await service.closePeriod("p1");
    expect(closed).toMatchObject({ state: "closed", closedAt: "2026-11-02T13:52:00Z" });
    expect(calls[0]!.headers["X-CSRF-Token"]).toBe("tok");
  });

  it("gibt feste Sätze der Periodenregeln bei Konflikt weiter, sonst nur den Status", async () => {
    const stale = setup({
      "/reports/periods/p1/confirm": {
        status: 409,
        body: { error: { code: "STALE_CHECK", message: "Seit der Prüfung wurde gebucht." } },
      },
    });
    await expect(stale.service.closePeriod("p1")).rejects.toMatchObject({
      status: 409,
      code: "STALE_CHECK",
      text: "Seit der Prüfung wurde gebucht.",
    });
    const broken = setup({
      "/reports/periods": { status: 500, body: { error: { message: "geheim" } } },
    });
    const err = await broken.service.periods().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReportsError);
    expect((err as ReportsError).text).toBeUndefined();
    expect((err as ReportsError).message).not.toContain("geheim");
  });

  it("meldet abgelaufene Sitzungen", async () => {
    const { service, onUnauthorized } = setup({ "/reports/periods": { status: 401 } });
    await expect(service.periods()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("liest MwSt-Nummer und Geschäftsjahr aus den Einstellungen", async () => {
    const { service } = setup({
      "/settings/organisation": {
        body: { master: { vatNumber: "CHE-1" }, "fiscal-year": { startMonth: 4 } },
      },
    });
    expect(await service.settings()).toEqual({ vatNumber: "CHE-1", fiscalYearStartMonth: 4 });
  });

  it("lädt das PDF einer Auswertung und den Abschlussbericht", async () => {
    const { service, calls } = setup({
      "/reports/periods/p1/export": { body: "x" },
      "/reports/debtors/export": { body: "x" },
    });
    expect((await service.exportReport("debtors", { asOf: "2026-11-02" }, "pdf")).filename).toBe(
      "debtors.pdf",
    );
    expect((await service.exportPeriodReport("p1")).filename).toBe("abschlussbericht.pdf");
    expect(calls.map((c) => c.url)).toEqual([
      "/reports/debtors/export?asOf=2026-11-02&format=pdf",
      "/reports/periods/p1/export?format=pdf",
    ]);
  });

  it("lädt den Export als Datei", async () => {
    const { service, calls } = setup({ "/reports/vat/export": { body: "x" } });
    const file = await service.exportReport(
      "vat",
      { from: "2026-01-01", to: "2026-11-02" },
      "xlsx",
    );
    expect(file.filename).toBe("vat.xlsx");
    expect(calls[0]!.url).toBe("/reports/vat/export?from=2026-01-01&to=2026-11-02&format=xlsx");
  });
});
