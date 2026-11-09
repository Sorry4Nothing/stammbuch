import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { errorHandler } from "../../lib/errors.js";
import { validate } from "../../lib/validate.js";
import {
  balanceSheetTable,
  debtorsTable,
  incomeStatementTable,
  openItemsTable,
  toCsv,
  toXlsx,
  trialBalanceTable,
  vatTable,
} from "./export.js";
import type { Table } from "./export.js";
import type { PeriodFactsPort } from "./facts.js";
import type { LedgerReadPort } from "./ledger-port.js";
import { isValidIsoDate } from "./money.js";
import { toPdf } from "./pdf.js";
import { PeriodError } from "./periods.js";
import type { Period, PeriodService } from "./periods.js";
import {
  balanceSheetReport,
  debtorsReport,
  incomeStatementReport,
  openItemsReport,
  trialBalanceReport,
  vatReport,
} from "./reports.js";

/** Angemeldeter Benutzer samt Mandant. Liefert das Auth-Modul (Phase 0); hier nur die Schnittstelle. */
export interface ReportsAuth {
  tenantId: string;
  userId: string;
}

export interface ReportsDeps {
  ledger: LedgerReadPort;
  periods: PeriodService;
  /** Rechnungen, Zahlungsimport und Benutzernamen für den Periodenabschluss; ohne sie entfallen die Zusatzangaben. */
  facts?: PeriodFactsPort;
  /** `undefined` = nicht angemeldet. Fehler führen zu 500, nie zu Zugriff (SR-54). */
  authenticate(request: FastifyRequest): Promise<ReportsAuth | undefined>;
}

// ---------------------------------------------------------------- Eingaben

const date = z.string().refine(isValidIsoDate);
const asOfQuery = z.object({ asOf: date });
const rangeQuery = z.object({ from: date, to: date }).refine((q) => q.from <= q.to);
const id = z.string().min(1).max(64);
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const formatQuery = z.object({ format: z.enum(["csv", "xlsx", "pdf"]) });
const vatQuery = z
  .object({
    from: date,
    to: date,
    method: z.enum(["effective", "saldo"]).default("effective"),
    // Saldosteuersätze liegen zwischen 0.1 % und 6.8 %; Obergrenze grosszügig als Plausibilitätsschutz.
    saldoRateBp: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .refine((q) => q.from <= q.to && (q.method === "effective" || q.saldoRateBp !== undefined));

interface Def {
  run(
    l: LedgerReadPort,
    tenantId: string,
    query: unknown,
  ): Promise<{ report: { rows: unknown[] }; table: Table }>;
}

function def<Q, R extends { rows: unknown[] }>(
  schema: z.ZodType<Q>,
  run: (l: LedgerReadPort, t: string, q: Q) => Promise<R>,
  table: (r: R) => Table,
): Def {
  return {
    async run(l, t, query) {
      const r = await run(l, t, validate(schema, query));
      return { report: r, table: table(r) };
    },
  };
}

const defs: Record<string, Def> = {
  "open-items": def(
    z.object({ asOf: date, debtorId: id.optional(), overdueOnly: bool.optional() }),
    openItemsReport,
    openItemsTable,
  ),
  debtors: def(asOfQuery, debtorsReport, debtorsTable),
  "trial-balance": def(rangeQuery, trialBalanceReport, trialBalanceTable),
  "income-statement": def(rangeQuery, incomeStatementReport, incomeStatementTable),
  "balance-sheet": def(asOfQuery, balanceSheetReport, balanceSheetTable),
  vat: def(vatQuery, vatReport, vatTable),
};

const nameParam = z.object({ name: z.string().max(32) });
const idParam = z.object({ id });
const vatConfirmationBody = z.strictObject({ confirmed: z.boolean() });
const createPeriodBody = z.object({
  label: z.string().trim().min(1).max(100),
  from: date,
  to: date,
});

const FORMATS = {
  csv: ["text/csv; charset=utf-8", toCsv],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", toXlsx],
  pdf: ["application/pdf", toPdf],
} as const;

const swissDate = (iso: string) => iso.split("-").reverse().join(".");
const swissDateTime = (iso: string) =>
  new Intl.DateTimeFormat("de-CH", {
    timeZone: "Europe/Zurich",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(iso));

// ---------------------------------------------------------------- Routen

const periodStatus: Record<string, number> = { NOT_FOUND: 404, INVALID_RANGE: 400 };

export function registerReportRoutes(app: FastifyInstance, deps: ReportsDeps) {
  const sessions = new WeakMap<FastifyRequest, ReportsAuth>();

  // Jede Route hier verlangt Anmeldung (SR-10). Daten sind immer auf den Mandanten der Sitzung begrenzt (SR-11).
  app.addHook("preHandler", async (req, reply) => {
    const auth = await deps.authenticate(req);
    if (!auth) {
      return reply
        .status(401)
        .send({ error: { code: "UNAUTHENTICATED", message: "Nicht angemeldet." } });
    }
    sessions.set(req, auth);
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof PeriodError) {
      const status = periodStatus[error.code] ?? 409;
      req.log.info({ code: error.code }, "Periodenaktion abgelehnt");
      return reply.status(status).send({ error: { code: error.code, message: error.message } });
    }
    return errorHandler(error, req, reply);
  });

  const auth = (req: FastifyRequest): ReportsAuth => {
    const a = sessions.get(req);
    if (!a) throw new Error("Anmeldung fehlt trotz preHandler."); // fail closed
    return a;
  };

  /**
   * Ergänzt Perioden um Buchungsanzahl und, bei abgeschlossenen, den Namen der abschliessenden Person (die Periode
   * trägt nur die Benutzerkennung). Fehlen Zahlen oder Namen in der Quelle, bleiben die Felder weg.
   */
  async function present(tenantId: string, periods: Period[]) {
    if (!deps.facts || periods.length === 0) return periods;
    const closer = (p: Period) => [...p.history].reverse().find((h) => h.to === "closed")?.actor;
    const ids = [...new Set(periods.flatMap((p) => closer(p) ?? []))];
    const [counts, names] = await Promise.all([
      deps.facts.bookingCounts(
        tenantId,
        periods.map((p) => ({ from: p.from, to: p.to })),
      ),
      deps.facts.userNames(tenantId, ids),
    ]);
    return periods.map((p, i) => {
      const name = names.get(closer(p) ?? "");
      return { ...p, bookings: counts[i] ?? 0, ...(name ? { closedBy: name } : {}) };
    });
  }
  const presentOne = async (tenantId: string, p: Period) => (await present(tenantId, [p]))[0]!;

  // --- Perioden (statische Pfade zuerst; Fastify bevorzugt sie ohnehin vor `/reports/:name`)
  app.get("/reports/periods", async (req) => {
    const { tenantId } = auth(req);
    return { periods: await present(tenantId, await deps.periods.list(tenantId)) };
  });

  // Legt die fehlenden Monatsperioden an (idempotent) und liefert die Liste. Eigene Route statt Schreiben im GET.
  app.post("/reports/periods/ensure", async (req) => {
    const { tenantId } = auth(req);
    const periods = await deps.periods.ensureMonths(tenantId);
    req.log.info({ count: periods.length }, "Monatsperioden sichergestellt");
    return { periods: await present(tenantId, periods) };
  });

  app.post("/reports/periods", async (req, reply) => {
    const { tenantId } = auth(req);
    const body = validate(createPeriodBody, req.body);
    const period = await deps.periods.create(tenantId, body);
    return reply.status(201).send(await presentOne(tenantId, period));
  });

  const findPeriod = async (tenantId: string, periodId: string) => {
    const period = (await deps.periods.list(tenantId)).find((p) => p.id === periodId);
    if (!period) throw new PeriodError("NOT_FOUND", "Periode nicht gefunden.");
    return period;
  };

  // Angaben aus Rechnungen und Zahlungsimport zur Periode (Prüfpunkte, Restposten, Zähler).
  app.get("/reports/periods/:id/facts", async (req) => {
    const { tenantId } = auth(req);
    const period = await findPeriod(tenantId, validate(idParam, req.params).id);
    if (!deps.facts) throw new PeriodError("NOT_FOUND", "Periode nicht gefunden.");
    return deps.facts.periodFacts(tenantId, { from: period.from, to: period.to });
  });

  // Abschlussbericht der Periode (Protokoll und Zähler) als PDF.
  app.get(
    "/reports/periods/:id/export",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { tenantId } = auth(req);
      const { id: periodId } = validate(idParam, req.params);
      validate(z.object({ format: z.literal("pdf") }), req.query);
      const period = await findPeriod(tenantId, periodId);
      const [shown, facts] = await Promise.all([
        presentOne(tenantId, period),
        deps.facts?.periodFacts(tenantId, { from: period.from, to: period.to }),
      ]);
      const closed = [...period.history].reverse().find((h) => h.to === "closed");
      const closedBy = "closedBy" in shown ? shown.closedBy : undefined;
      const warnings = period.issues.filter((i) => i.severity === "warning");
      const pairs: [string, string][] = [
        ["Periode", period.label],
        ["Zeitraum", `${swissDate(period.from)} bis ${swissDate(period.to)}`],
        ["Status", { open: "Offen", checked: "Geprüft", closed: "Abgeschlossen" }[period.state]],
        ...(closed ? [["Abgeschlossen am", swissDateTime(closed.at)] as [string, string]] : []),
        ...(closedBy ? [["Abgeschlossen von", closedBy] as [string, string]] : []),
        ["Warnungen", String(warnings.length)],
        ...warnings.map((w): [string, string] => ["", w.message]),
        ...(facts
          ? ([
              ["Buchungen", String(facts.stats.bookings)],
              ["Rechnungen", String(facts.stats.invoices)],
              ["Zahlungen", String(facts.stats.payments)],
              ["Gegenbuchungen", String(facts.stats.reversals)],
            ] as [string, string][])
          : []),
      ];
      const table: Table = {
        title: `Abschlussbericht ${period.label}`,
        columns: [
          { label: "Angabe", type: "text" },
          { label: "Wert", type: "text" },
        ],
        rows: pairs,
      };
      req.log.info({ periodId, format: "pdf" }, "Abschlussbericht exportiert");
      return reply
        .header("content-type", FORMATS.pdf[0])
        .header("content-disposition", 'attachment; filename="abschlussbericht.pdf"')
        .header("cache-control", "no-store")
        .send(await toPdf(table));
    },
  );

  const transition =
    (action: "runCheck" | "confirm" | "revokeCheck") => async (req: FastifyRequest) => {
      const a = auth(req);
      const { id: periodId } = validate(idParam, req.params);
      const period = await deps.periods[action](a.tenantId, periodId, a.userId);
      req.log.info({ periodId, state: period.state }, "Periodenstatus");
      return presentOne(a.tenantId, period);
    };
  app.post("/reports/periods/:id/check", transition("runCheck"));
  app.post("/reports/periods/:id/confirm", transition("confirm"));
  app.post("/reports/periods/:id/revoke-check", transition("revokeCheck"));

  // Die Person bestätigt die MwSt-Abrechnung der Periode (oder nimmt die Bestätigung zurück); die Prüfung läuft neu.
  app.post("/reports/periods/:id/vat-confirmation", async (req) => {
    const a = auth(req);
    const { id: periodId } = validate(idParam, req.params);
    const { confirmed } = validate(vatConfirmationBody, req.body);
    const period = await deps.periods.setVatConfirmation(a.tenantId, periodId, a.userId, confirmed);
    req.log.info({ periodId, confirmed }, "MwSt-Abrechnung bestätigt");
    return presentOne(a.tenantId, period);
  });

  // --- Auswertungen
  const find = (req: FastifyRequest, reply: FastifyReply) => {
    const { name } = validate(nameParam, req.params);
    const d = Object.hasOwn(defs, name) ? defs[name] : undefined;
    if (!d) void reply.callNotFound();
    return d;
  };

  app.get("/reports/:name", async (req, reply) => {
    const d = find(req, reply);
    if (!d) return reply;
    const page = validate(pageQuery, req.query);
    const { report } = await d.run(deps.ledger, auth(req).tenantId, req.query);
    // Summen und Kontrollwerte stammen aus dem vollen Bericht, nur die Zeilenliste wird geschnitten (SR-71).
    return {
      ...report,
      rows: report.rows.slice(page.offset, page.offset + page.limit),
      page: { ...page, total: report.rows.length },
    };
  });

  // Export ist teuer: engeres Limit pro Client (SR-71). `shortcut`: Bericht wird im Speicher gebaut, ab
  // sehr grossen Mandanten per Stream/Datenbankaggregat ersetzen.
  app.get(
    "/reports/:name/export",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const d = find(req, reply);
      if (!d) return reply;
      const { format } = validate(formatQuery, req.query);
      const { table } = await d.run(deps.ledger, auth(req).tenantId, req.query);
      const { name } = req.params as { name: string };
      const [contentType, render] = FORMATS[format];
      req.log.info({ report: name, format }, "Auswertung exportiert");
      return reply
        .header("content-type", contentType)
        .header("content-disposition", `attachment; filename="${name}.${format}"`)
        .header("cache-control", "no-store")
        .send(await render(table));
    },
  );
}
