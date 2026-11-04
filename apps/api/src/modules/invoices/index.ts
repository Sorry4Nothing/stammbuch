import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiError } from "@stammbuch/shared";
import { errorHandler } from "../../lib/errors.js";
import { validate } from "../../lib/validate.js";
import type { ApiModule } from "../types.js";
import { BillingError } from "./domain.js";
import {
  MemoryInvoiceRepository,
  MemoryReminderRepository,
  MemorySettingsRepository,
} from "./memory.js";
import {
  collectiveInputSchema,
  creditInputSchema,
  dunningQuerySchema,
  featuresInputSchema,
  idParamSchema,
  invoiceInputSchema,
  issueReminderSchema,
  listQuerySchema,
  paymentInputSchema,
  reminderParamSchema,
  settingsInputSchema,
  updateInvoiceSchema,
} from "./schemas.js";
import { type InvoiceView, InvoiceService, type ServiceDeps } from "./service.js";

export const name = "invoices";

/** Berechtigungen des Moduls (SR-10, SR-12). Die Zuordnung zu Rollen liegt im Auth-Modul. */
export const PERMISSIONS = [
  "invoices:read",
  "invoices:write",
  "invoices:book",
  "invoices:dunning",
  "invoices:collective",
  "invoices:settings",
  "invoices:features",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Angemeldeter Nutzer mit Mandant. Kommt aus dem Auth-Modul, nie aus dem Request-Body (SR-11). */
export interface Actor {
  userId: string;
  tenantId: string;
  permissions: ReadonlySet<Permission>;
}

export interface InvoicesModuleDeps extends ServiceDeps {
  /** Liefert den Nutzer zur Anfrage oder null (nicht angemeldet). */
  authenticate(request: FastifyRequest): Promise<Actor | null>;
}

const CODES: Record<number, ApiError["error"]["code"]> = {
  400: "VALIDATION",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  422: "UNPROCESSABLE",
};

/** Antworten tragen nie die Mandanten-ID (SR-74). */
function withoutTenant<T extends { tenantId: string }>(row: T): Omit<T, "tenantId"> {
  const copy: Partial<T> = { ...row };
  delete copy.tenantId;
  return copy as Omit<T, "tenantId">;
}

const actors = new WeakMap<FastifyRequest, Actor>();

/** DTO ohne Mandanten-ID (SR-74) mit den abgeleiteten Beträgen. */
function invoiceDto({ invoice, ...amounts }: InvoiceView) {
  return { ...withoutTenant(invoice), ...amounts };
}

export function createInvoicesModule(deps: InvoicesModuleDeps): ApiModule {
  const service = new InvoiceService(deps);

  return {
    name,
    register(app: FastifyInstance) {
      // Fachliche Fehler tragen eine für den Client bestimmte Meldung; alles andere läuft
      // durch den zentralen Handler (generisch, SR-51).
      app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
        if (error instanceof BillingError) {
          request.log.info({ status: error.statusCode }, "Rechnungsvorgang abgelehnt");
          const body: ApiError = {
            error: { code: CODES[error.statusCode] ?? "VALIDATION", message: error.message },
          };
          return reply.status(error.statusCode).send(body);
        }
        return errorHandler(error, request, reply);
      });

      // Fail secure: ohne gültigen Nutzer keine Route (SR-10, SR-54).
      app.addHook("onRequest", async (request) => {
        const actor = await deps.authenticate(request);
        if (!actor) throw new BillingError(401, "Anmeldung erforderlich.");
        actors.set(request, actor);
      });

      /** Berechtigung der Funktion prüfen und Mandanten des Nutzers liefern. */
      const authorize = (request: FastifyRequest, permission: Permission): Actor => {
        const actor = actors.get(request);
        if (!actor) throw new BillingError(401, "Anmeldung erforderlich.");
        if (!actor.permissions.has(permission)) throw new BillingError(403, "Keine Berechtigung.");
        return actor;
      };

      const pdfLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
      const sendPdf = (reply: FastifyReply, file: { pdf: Uint8Array; filename: string }) =>
        reply
          .type("application/pdf")
          .header("Content-Disposition", `attachment; filename="${file.filename}"`)
          .header("Cache-Control", "no-store")
          .send(Buffer.from(file.pdf));

      // --- Einstellungen und Module -----------------------------------------------------------
      app.get("/invoices/settings", async (req) => {
        const a = authorize(req, "invoices:settings");
        const s = await service.getSettings(a.tenantId);
        if (!s) throw new BillingError(404, "Rechnungseinstellungen sind noch nicht erfasst.");
        return withoutTenant(s);
      });
      app.put("/invoices/settings", async (req) => {
        const a = authorize(req, "invoices:settings");
        return withoutTenant(
          await service.saveSettings(a.tenantId, validate(settingsInputSchema, req.body)),
        );
      });
      app.put("/invoices/settings/features", async (req) => {
        const a = authorize(req, "invoices:features");
        return withoutTenant(
          await service.setFeatures(a.tenantId, validate(featuresInputSchema, req.body)),
        );
      });

      // --- Mahnwesen (feste Pfade vor /invoices/:id) -------------------------------------------
      app.get("/invoices/dunning/due", async (req) => {
        const a = authorize(req, "invoices:dunning");
        const q = validate(dunningQuerySchema, req.query);
        return { items: await service.dueForDunning(a.tenantId, q.asOf) };
      });

      app.post("/invoices/collective", { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
        const a = authorize(req, "invoices:collective");
        const result = await service.runCollective(
          a.tenantId,
          validate(collectiveInputSchema, req.body),
        );
        return reply.status(201).send(result);
      });

      // --- Rechnungen --------------------------------------------------------------------------
      app.get("/invoices", async (req) => {
        const a = authorize(req, "invoices:read");
        const q = validate(listQuerySchema, req.query);
        const { items, total } = await service.list(a.tenantId, q);
        return { items: items.map(invoiceDto), total, limit: q.limit, offset: q.offset };
      });

      app.post("/invoices", async (req, reply) => {
        const a = authorize(req, "invoices:write");
        const view = await service.createDraft(a.tenantId, validate(invoiceInputSchema, req.body));
        return reply.status(201).send(invoiceDto(view));
      });

      app.get("/invoices/:id", async (req) => {
        const a = authorize(req, "invoices:read");
        const { id } = validate(idParamSchema, req.params);
        return invoiceDto(await service.get(a.tenantId, id));
      });

      app.put("/invoices/:id", async (req) => {
        const a = authorize(req, "invoices:write");
        const { id } = validate(idParamSchema, req.params);
        const { version, ...input } = validate(updateInvoiceSchema, req.body);
        return invoiceDto(await service.updateDraft(a.tenantId, id, input, version));
      });

      app.delete("/invoices/:id", async (req, reply) => {
        const a = authorize(req, "invoices:write");
        const { id } = validate(idParamSchema, req.params);
        await service.deleteDraft(a.tenantId, id);
        return reply.status(204).send();
      });

      app.post("/invoices/:id/send", async (req) => {
        const a = authorize(req, "invoices:book");
        const { id } = validate(idParamSchema, req.params);
        return invoiceDto(await service.send(a.tenantId, id));
      });

      app.post("/invoices/:id/payments", async (req) => {
        const a = authorize(req, "invoices:write");
        const { id } = validate(idParamSchema, req.params);
        const body = validate(paymentInputSchema, req.body);
        return invoiceDto(await service.recordPayment(a.tenantId, id, body, a.userId));
      });

      app.post("/invoices/:id/cancel", async (req) => {
        const a = authorize(req, "invoices:book");
        const { id } = validate(idParamSchema, req.params);
        return invoiceDto(await service.cancel(a.tenantId, id));
      });

      app.post("/invoices/:id/credit-notes", async (req, reply) => {
        const a = authorize(req, "invoices:book");
        const { id } = validate(idParamSchema, req.params);
        const body = validate(creditInputSchema, req.body);
        return reply
          .status(201)
          .send(invoiceDto(await service.credit(a.tenantId, id, body.lines, body.subject)));
      });

      app.get("/invoices/:id/pdf", pdfLimit, async (req, reply) => {
        const a = authorize(req, "invoices:read");
        const { id } = validate(idParamSchema, req.params);
        return sendPdf(reply, await service.invoicePdf(a.tenantId, id));
      });

      // --- Mahnungen je Rechnung -----------------------------------------------------------------
      app.get("/invoices/:id/reminders", async (req) => {
        const a = authorize(req, "invoices:dunning");
        const { id } = validate(idParamSchema, req.params);
        const items = await service.listReminders(a.tenantId, id);
        return { items: items.map(withoutTenant) };
      });

      app.post("/invoices/:id/reminders", async (req, reply) => {
        const a = authorize(req, "invoices:dunning");
        const { id } = validate(idParamSchema, req.params);
        const body = validate(issueReminderSchema, req.body ?? {});
        return reply
          .status(201)
          .send(withoutTenant(await service.issueReminder(a.tenantId, id, body.asOf)));
      });

      app.get("/invoices/:id/reminders/:level/pdf", pdfLimit, async (req, reply) => {
        const a = authorize(req, "invoices:dunning");
        const { id, level } = validate(reminderParamSchema, req.params);
        return sendPdf(reply, await service.reminderPdf(a.tenantId, id, level));
      });
    },
  };
}

/**
 * Standardverdrahtung: In-Memory-Ablage und eine Authentifizierung, die alles ablehnt, bis das
 * Auth-Modul (Issue #4) `authenticate` liefert und die Postgres-Repositories (Issue #3) bereitstehen.
 */
const defaults = createInvoicesModule({
  invoices: new MemoryInvoiceRepository(),
  reminders: new MemoryReminderRepository(),
  settings: new MemorySettingsRepository(),
  authenticate: async () => null,
});
export const register = defaults.register;
