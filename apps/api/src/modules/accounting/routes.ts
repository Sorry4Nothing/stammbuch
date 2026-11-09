import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { errorHandler } from "../../lib/errors.js";
import { validate } from "../../lib/validate.js";
import { toXlsx } from "../reports/export.js";
import { DomainError } from "./domain.js";
import {
  accountCode,
  allocateInput,
  createAccountInput,
  idempotentOnly,
  isoDate,
  manualEntryInput,
  pageQuery,
  paymentInput,
  period,
  personId,
  receivableInput,
  reopenPeriodInput,
  reverseEntryInput,
  updateAccountInput,
  uuid,
} from "./schemas.js";
import { renderStatementPdf } from "./statement-pdf.js";
import type { AccountingService, Ctx, Idem } from "./service.js";

/** Liefert Mandant und Akteur der Anfrage oder `null` (nicht angemeldet). Kommt aus der Auth-Schicht. */
export type Authenticate = (request: FastifyRequest) => Promise<Ctx | null>;

const idParam = z.strictObject({ id: uuid });
const personParam = z.strictObject({ personId });
const codeParam = z.strictObject({ code: accountCode });
const periodParam = z.strictObject({ period });
const rangeQuery = z.strictObject({ from: isoDate.optional(), to: isoDate.optional() });
const exportLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };
const boolQuery = z.enum(["true", "false"]).transform((v) => v === "true");

/**
 * Alle Routen unter `/accounting`. Jede Route verlangt Authentifizierung (SR-10, SR-12); der
 * Mandant kommt nur aus der Authentifizierung, nie aus Body oder URL (SR-11). Wer Zugriff hat,
 * hat Vollzugriff (projektplan.md, Abschnitt 8): es gibt keine Rollenstufen innerhalb eines Mandanten.
 */
export async function registerAccountingRoutes(
  app: FastifyInstance,
  deps: { service: AccountingService; authenticate: Authenticate },
) {
  const { service, authenticate } = deps;
  const contexts = new WeakMap<FastifyRequest, Ctx>();
  const ctxOf = (req: FastifyRequest): Ctx => {
    const ctx = contexts.get(req);
    if (!ctx) throw new Error("Kontext fehlt"); // fail closed: wird zu 500
    return ctx;
  };
  const page = (q: unknown) => validate(pageQuery, q);
  const created = <T>(reply: FastifyReply, r: Idem<T>) =>
    reply.status(r.replayed ? 200 : 201).send({ ...r.result, replayed: r.replayed });

  await app.register(
    async (scope) => {
      scope.addHook("onRequest", async (req, reply) => {
        const ctx = await authenticate(req);
        if (!ctx) {
          req.log.warn(
            { url: req.routeOptions.url },
            "Buchhaltung: Zugriff ohne Anmeldung verweigert",
          );
          return reply
            .status(401)
            .send({ error: { code: "UNAUTHENTICATED", message: "Nicht angemeldet." } });
        }
        contexts.set(req, ctx);
      });

      scope.setErrorHandler((error, req, reply) => {
        if (error instanceof DomainError) {
          req.log.info({ code: error.code }, "Buchhaltung: Regel verletzt");
          return reply
            .status(error.status)
            .send({ error: { code: error.code, message: error.message } });
        }
        return errorHandler(error, req, reply);
      });

      // Kontenplan
      scope.get("/accounts", (req) => service.listAccounts(ctxOf(req)));
      scope.post("/accounts", async (req, reply) =>
        reply
          .status(201)
          .send(await service.createAccount(ctxOf(req), validate(createAccountInput, req.body))),
      );

      scope.patch("/accounts/:code", (req) =>
        service.updateAccount(
          ctxOf(req),
          validate(codeParam, req.params).code,
          validate(updateAccountInput, req.body),
        ),
      );
      // Export ist teuer: engeres Limit pro Client (SR-71).
      scope.get("/export/accounts", exportLimit, async (req, reply) =>
        reply
          .header(
            "content-type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          )
          .header("content-disposition", 'attachment; filename="kontenplan.xlsx"')
          .header("cache-control", "no-store")
          .send(toXlsx(await service.accountsTable(ctxOf(req)))),
      );

      // Buchungen
      const entryQuery = rangeQuery.extend({ accountCode: accountCode.optional() });
      scope.get("/entries", (req) => {
        const q = validate(entryQuery.extend(pageQuery.shape), req.query);
        const { limit, offset, ...filter } = q;
        return service.listEntries(ctxOf(req), filter, { limit, offset });
      });
      scope.get("/entries/count", (req) =>
        service.countEntries(ctxOf(req), validate(entryQuery, req.query)),
      );
      scope.get("/entries/:id", (req) =>
        service.getEntry(ctxOf(req), validate(idParam, req.params).id),
      );
      scope.post("/entries", async (req, reply) =>
        created(
          reply,
          await service.postManualEntry(ctxOf(req), validate(manualEntryInput, req.body)),
        ),
      );
      scope.post("/entries/:id/reverse", async (req, reply) =>
        created(
          reply,
          await service.reverseEntry(
            ctxOf(req),
            validate(idParam, req.params).id,
            validate(reverseEntryInput, req.body),
          ),
        ),
      );

      // Rechnungen/Gutschriften und Zahlungen
      scope.post("/receivables", async (req, reply) =>
        created(
          reply,
          await service.postReceivable(ctxOf(req), validate(receivableInput, req.body)),
        ),
      );
      scope.post("/payments", async (req, reply) =>
        created(reply, await service.bookPayment(ctxOf(req), validate(paymentInput, req.body))),
      );

      // Zuordnung
      scope.post("/allocations", async (req, reply) =>
        created(reply, await service.allocate(ctxOf(req), validate(allocateInput, req.body))),
      );
      scope.post("/allocations/:id/reverse", async (req, reply) =>
        created(
          reply,
          await service.reverseAllocation(
            ctxOf(req),
            validate(idParam, req.params).id,
            validate(idempotentOnly, req.body).idempotencyKey,
          ),
        ),
      );

      // Offene Posten, Debitoren, Auswertungen
      scope.get("/open-items", (req) => {
        const q = validate(
          z.strictObject({
            personId: personId.optional(),
            onlyOpen: boolQuery.default(true),
            asOf: isoDate.optional(),
            ...pageQuery.shape,
          }),
          req.query,
        );
        const { limit, offset, ...filter } = q;
        return service.listOpenItems(ctxOf(req), filter, { limit, offset });
      });
      scope.get("/credits", (req) => {
        const q = validate(
          z.strictObject({ personId: personId.optional(), ...pageQuery.shape }),
          req.query,
        );
        return service.openCredits(ctxOf(req), { personId: q.personId }, q);
      });
      scope.get("/debtors", (req) => {
        const q = validate(
          z.strictObject({ nonZero: boolQuery.default(true), ...pageQuery.shape }),
          req.query,
        );
        return service.debtorList(ctxOf(req), { nonZero: q.nonZero }, q);
      });
      scope.get("/debtors/reconciliation", (req) => service.reconcileDebtors(ctxOf(req)));
      scope.get("/persons/:personId/ledger", (req) =>
        service.personLedger(
          ctxOf(req),
          validate(personParam, req.params).personId,
          page(req.query),
        ),
      );
      scope.get("/persons/:personId/statement", exportLimit, async (req, reply) => {
        const data = await service.personStatement(
          ctxOf(req),
          validate(personParam, req.params).personId,
        );
        return reply
          .header("content-type", "application/pdf")
          .header("content-disposition", 'attachment; filename="kontoauszug.pdf"')
          .header("cache-control", "no-store")
          .send(await renderStatementPdf(data));
      });
      scope.get("/trial-balance", (req) =>
        service.trialBalance(ctxOf(req), validate(rangeQuery, req.query)),
      );

      // Perioden
      scope.get("/periods", (req) => service.listPeriods(ctxOf(req)));
      scope.post("/periods/:period/close", (req) =>
        service.closePeriod(ctxOf(req), validate(periodParam, req.params).period),
      );
      scope.post("/periods/:period/reopen", (req) =>
        service.reopenPeriod(
          ctxOf(req),
          validate(periodParam, req.params).period,
          validate(reopenPeriodInput, req.body).reason,
        ),
      );

      // Protokoll und Integrität
      scope.get("/audit", (req) => service.listAudit(ctxOf(req), page(req.query)));
      scope.get("/integrity", (req) => service.verifyIntegrity(ctxOf(req)));
    },
    { prefix: "/accounting" },
  );
}
