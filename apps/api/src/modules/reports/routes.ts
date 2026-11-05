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
import type { LedgerReadPort } from "./ledger-port.js";
import { isValidIsoDate } from "./money.js";
import { PeriodError } from "./periods.js";
import type { PeriodService } from "./periods.js";
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
const formatQuery = z.object({ format: z.enum(["csv", "xlsx"]) });
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
const createPeriodBody = z.object({
  label: z.string().trim().min(1).max(100),
  from: date,
  to: date,
});

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

  // --- Perioden (statische Pfade zuerst; Fastify bevorzugt sie ohnehin vor `/reports/:name`)
  app.get("/reports/periods", async (req) => ({
    periods: await deps.periods.list(auth(req).tenantId),
  }));

  app.post("/reports/periods", async (req, reply) => {
    const body = validate(createPeriodBody, req.body);
    const period = await deps.periods.create(auth(req).tenantId, body);
    return reply.status(201).send(period);
  });

  const transition =
    (action: "runCheck" | "confirm" | "revokeCheck") => async (req: FastifyRequest) => {
      const a = auth(req);
      const { id: periodId } = validate(idParam, req.params);
      const period = await deps.periods[action](a.tenantId, periodId, a.userId);
      req.log.info({ periodId, state: period.state }, "Periodenstatus");
      return period;
    };
  app.post("/reports/periods/:id/check", transition("runCheck"));
  app.post("/reports/periods/:id/confirm", transition("confirm"));
  app.post("/reports/periods/:id/revoke-check", transition("revokeCheck"));

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
      const xlsx = format === "xlsx";
      return reply
        .header(
          "content-type",
          xlsx
            ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            : "text/csv; charset=utf-8",
        )
        .header("content-disposition", `attachment; filename="${name}.${format}"`)
        .header("cache-control", "no-store")
        .send(xlsx ? toXlsx(table) : toCsv(table));
    },
  );
}
