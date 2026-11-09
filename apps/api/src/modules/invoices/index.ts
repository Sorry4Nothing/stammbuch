import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiError } from "@stammbuch/shared";
import { errorHandler } from "../../lib/errors.js";
import { validate } from "../../lib/validate.js";
import type { Datenbank } from "@stammbuch/db";
import type { ApiModule } from "../types.js";
import { BillingError } from "./domain.js";
import { DomainError } from "../accounting/domain.js";
import { createMailService, mailContextFor } from "../mail/index.js";
import { createMemoryStore } from "../people/memory.js";
import { createPostgresStore } from "../people/postgres.js";
import { toXlsx } from "../reports/export.js";
import { MemoryGroupFeeStore, createCollectiveSource } from "./collective.js";
import { createPersonDirectory } from "./directory.js";
import type { Organisation, Platform } from "../../platform/index.js";
import { mailServicePort } from "./mail-port.js";
import { memorySettingsFor, syncBillingSettings } from "./org-sync.js";
import { createPgDeps } from "./pg-accounting.js";
import { createPgCollectiveSource } from "./pg-collective.js";
import {
  MemoryInvoiceRepository,
  MemoryReminderRepository,
  MemorySettingsRepository,
} from "./memory.js";
import {
  cancelInputSchema,
  collectiveConfigSchema,
  collectiveGroupRunSchema,
  collectiveInputSchema,
  creditInputSchema,
  dunningQuerySchema,
  dunningSettingsSchema,
  emailInputSchema,
  exportInputSchema,
  featuresInputSchema,
  groupFeeParamSchema,
  groupFeeSchema,
  idParamSchema,
  invoiceInputSchema,
  issueReminderSchema,
  listQuerySchema,
  openItemsQuerySchema,
  paymentInputSchema,
  paymentTermSchema,
  reminderParamSchema,
  resendBatchSchema,
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
  /** Organisation des Mandanten; liefert die Angaben für Rechnungseinstellungen, die noch fehlen. */
  organisation?(tenantId: string): Promise<Organisation | undefined>;
}

const CODES: Record<number, ApiError["error"]["code"]> = {
  400: "VALIDATION",
  401: "UNAUTHENTICATED",
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
        // Die Buchhaltung lehnt ab (gesperrte Periode, unbekanntes Konto): fester Text ohne Interna (SR-51).
        if (error instanceof BillingError || error instanceof DomainError) {
          const status = error instanceof BillingError ? error.statusCode : error.status;
          request.log.info({ status }, "Rechnungsvorgang abgelehnt");
          const body: ApiError = {
            error: { code: CODES[status] ?? "VALIDATION", message: error.message },
          };
          return reply.status(status).send(body);
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
      // Mails und Läufe belasten das Mailkonto bzw. die Buchhaltung: enger begrenzt als Lesezugriffe (SR-71).
      const mailLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };
      const exportLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };
      const runLimit = { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } };
      const sendPdf = (reply: FastifyReply, file: { pdf: Uint8Array; filename: string }) =>
        reply
          .type("application/pdf")
          .header("Content-Disposition", `attachment; filename="${file.filename}"`)
          .header("Cache-Control", "no-store")
          .send(Buffer.from(file.pdf));

      // --- Einstellungen und Module -----------------------------------------------------------
      app.get("/invoices/settings", async (req) => {
        const a = authorize(req, "invoices:settings");
        let s = await service.getSettings(a.tenantId);
        // Organisation war schon vollständig erfasst, bevor es den Abgleich gab: einmalig nachholen.
        if (!s) {
          const org = await deps.organisation?.(a.tenantId);
          if (org && (await syncBillingSettings(deps.settings, a.tenantId, org)))
            s = await service.getSettings(a.tenantId);
        }
        if (!s) throw new BillingError(404, "Rechnungseinstellungen sind noch nicht erfasst.");
        return withoutTenant(s);
      });
      app.put("/invoices/settings", async (req) => {
        const a = authorize(req, "invoices:settings");
        return withoutTenant(
          await service.saveSettings(a.tenantId, validate(settingsInputSchema, req.body), a.userId),
        );
      });
      app.put("/invoices/settings/features", async (req) => {
        const a = authorize(req, "invoices:features");
        return withoutTenant(
          await service.setFeatures(a.tenantId, validate(featuresInputSchema, req.body)),
        );
      });

      app.put("/invoices/settings/payment-term", async (req) => {
        const a = authorize(req, "invoices:settings");
        return withoutTenant(
          await service.savePaymentTerm(
            a.tenantId,
            validate(paymentTermSchema, req.body).paymentTermDays,
          ),
        );
      });

      app.put("/invoices/settings/dunning", async (req) => {
        const a = authorize(req, "invoices:settings");
        return withoutTenant(
          await service.saveDunning(a.tenantId, validate(dunningSettingsSchema, req.body)),
        );
      });

      // --- Mahnwesen (feste Pfade vor /invoices/:id) -------------------------------------------
      app.get("/invoices/dunning/due", async (req) => {
        const a = authorize(req, "invoices:dunning");
        const q = validate(dunningQuerySchema, req.query);
        return { items: await service.dueForDunning(a.tenantId, q.asOf) };
      });

      // Sammelrechnung nach Gruppen: Einrichtung, Beitrag je Gruppe, Vorschau, Lauf.
      app.get("/invoices/collective/setup", async (req) => {
        const a = authorize(req, "invoices:collective");
        return service.collectiveSetup(a.tenantId);
      });
      app.put("/invoices/collective/groups/:id/fee", async (req) => {
        const a = authorize(req, "invoices:collective");
        const { id } = validate(groupFeeParamSchema, req.params);
        const { feeCents } = validate(groupFeeSchema, req.body);
        await service.setGroupFee(a.tenantId, id, feeCents);
        return { id, feeCents };
      });
      app.post("/invoices/collective/preview", async (req) => {
        const a = authorize(req, "invoices:collective");
        return service.collectivePreview(a.tenantId, validate(collectiveConfigSchema, req.body));
      });
      app.post("/invoices/collective/run", runLimit, async (req, reply) => {
        const a = authorize(req, "invoices:collective");
        // Der Lauf bucht Rechnungen: wie das Versenden verlangt er auch das Recht zum Buchen.
        authorize(req, "invoices:book");
        const result = await service.runCollectiveByGroups(
          a.tenantId,
          validate(collectiveGroupRunSchema, req.body),
          a.userId,
        );
        req.log.info(
          {
            created: result.created,
            mailed: result.mailed,
            notMailed: result.notMailed,
            remaining: result.remaining,
          },
          "Sammelrechnung erstellt",
        );
        return reply.status(201).send(result);
      });

      // Sammelaktion «Rechnungen erneut senden». Fester Pfad vor /invoices/:id. Wie der Einzelversand verlangt sie das
      // Recht zu buchen; die engere Begrenzung gilt, weil eine Anfrage bis zu 200 PDFs und Mails auslöst (SR-71).
      app.post("/invoices/email-batch", runLimit, async (req) => {
        const a = authorize(req, "invoices:book");
        const { ids } = validate(resendBatchSchema, req.body);
        const items = await service.resendInvoices(a.tenantId, ids, a.userId);
        req.log.info(
          {
            requested: ids.length,
            sent: items.filter((i) => i.outcome === "sent").length,
            skipped: items.filter((i) => i.outcome === "skipped").length,
            failed: items.filter((i) => i.outcome === "failed").length,
          },
          "Rechnungen erneut gesendet",
        );
        return { items };
      });

      app.post("/invoices/export", exportLimit, async (req, reply) => {
        const a = authorize(req, "invoices:read");
        const { ids } = validate(exportInputSchema, req.body ?? {});
        const table = await service.exportTable(a.tenantId, ids);
        return reply
          .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
          .header("Content-Disposition", `attachment; filename="rechnungen.xlsx"`)
          .header("Cache-Control", "no-store")
          .send(toXlsx(table));
      });

      // Offene Posten mit Schuldner (Startseite, Navigationszähler). Fester Pfad vor /invoices/:id.
      app.get("/invoices/open-items", async (req, reply) => {
        const a = authorize(req, "invoices:read");
        const q = validate(openItemsQuerySchema, req.query);
        const { items, total, overdue } = await service.openItems(a.tenantId, q.limit);
        return reply.header("cache-control", "no-store").send({
          items: items.map((i) => ({
            id: i.invoiceId,
            number: i.number,
            debtor: i.debtor,
            openCents: i.openCents,
            currency: i.currency,
            dueDate: i.dueDate,
          })),
          total,
          overdue,
        });
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
        const view = await service.createDraft(
          a.tenantId,
          validate(invoiceInputSchema, req.body),
          a.userId,
        );
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
        return invoiceDto(await service.updateDraft(a.tenantId, id, input, version, a.userId));
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
        return invoiceDto(await service.send(a.tenantId, id, a.userId));
      });

      app.post("/invoices/:id/payments", async (req) => {
        const a = authorize(req, "invoices:write");
        const { id } = validate(idParamSchema, req.params);
        const body = validate(paymentInputSchema, req.body);
        // Eine Rückbuchung öffnet eine bezahlte Forderung wieder: das ist eine Buchung, nicht nur Erfassen.
        if (body.amountCents < 0) authorize(req, "invoices:book");
        return invoiceDto(await service.recordPayment(a.tenantId, id, body, a.userId));
      });

      app.post("/invoices/:id/cancel", async (req) => {
        const a = authorize(req, "invoices:book");
        const { id } = validate(idParamSchema, req.params);
        const why = validate(cancelInputSchema, req.body ?? {});
        const view = await service.cancel(a.tenantId, id, a.userId, why);
        if (view.notification)
          req.log.info(
            { invoiceId: id, notification: view.notification },
            "Storno-Benachrichtigung",
          );
        return invoiceDto(view);
      });

      app.post("/invoices/:id/email", mailLimit, async (req, reply) => {
        const a = authorize(req, "invoices:book");
        const { id } = validate(idParamSchema, req.params);
        await service.emailInvoice(a.tenantId, id, a.userId, validate(emailInputSchema, req.body));
        req.log.info({ invoiceId: id }, "Rechnung in die Versandwarteschlange gestellt");
        return reply.status(202).send({ queued: true });
      });

      app.get("/invoices/:id/bookings", async (req) => {
        const a = authorize(req, "invoices:read");
        const { id } = validate(idParamSchema, req.params);
        return { items: await service.bookings(a.tenantId, id, a.userId) };
      });

      app.post("/invoices/:id/credit-notes", async (req, reply) => {
        const a = authorize(req, "invoices:book");
        const { id } = validate(idParamSchema, req.params);
        const body = validate(creditInputSchema, req.body);
        return reply
          .status(201)
          .send(
            invoiceDto(await service.credit(a.tenantId, id, body.lines, body.subject, a.userId)),
          );
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

      app.post("/invoices/:id/reminders/:level/email", mailLimit, async (req, reply) => {
        const a = authorize(req, "invoices:dunning");
        const { id, level } = validate(reminderParamSchema, req.params);
        await service.emailReminder(
          a.tenantId,
          id,
          level,
          a.userId,
          validate(emailInputSchema, req.body),
        );
        req.log.info({ invoiceId: id, level }, "Mahnung in die Versandwarteschlange gestellt");
        return reply.status(202).send({ queued: true });
      });

      app.get("/invoices/:id/reminders/:level/pdf", pdfLimit, async (req, reply) => {
        const a = authorize(req, "invoices:dunning");
        const { id, level } = validate(reminderParamSchema, req.params);
        return sendPdf(reply, await service.reminderPdf(a.tenantId, id, level));
      });
    },
  };
}

/** Ohne Anmeldung keine Route (fail closed), z. B. in Tests ohne Auth-Dienste. */
const denyAll: InvoicesModuleDeps["authenticate"] = async () => null;

/**
 * Anmeldung über `app.authenticateRequest` (#4). Feinere Rollen gibt es noch nicht: `user` darf alles in diesem
 * Modul, der Chef-Admin nichts (er sieht keine Kundendaten, Projektplan Abschnitt 8).
 */
const ALL: ReadonlySet<Permission> = new Set(PERMISSIONS);
const NONE: ReadonlySet<Permission> = new Set();
export function authenticateWith(app: FastifyInstance): InvoicesModuleDeps["authenticate"] {
  return async (request) => {
    const auth = await app.authenticateRequest(request);
    if (!auth) return null;
    return {
      userId: auth.userId,
      tenantId: auth.tenantId,
      permissions: auth.rolle === "user" ? ALL : NONE,
    };
  };
}

/**
 * Standardverdrahtung: mit Datenbank (`app.db`, Rolle stammbuch_app, Mandantentrennung per RLS) PostgreSQL, sonst
 * In-Memory nur für Entwicklung und Tests (in Produktion verlangt die Konfiguration die Datenbank).
 */
export function createInvoicesModuleFor(
  db: Datenbank | undefined,
  authenticate: InvoicesModuleDeps["authenticate"] = denyAll,
  platform?: Platform,
): ApiModule {
  // E-Mail-Versand über das Mail-Modul (#10); ohne Schlüssel (`MAIL_ENCRYPTION_KEYS`) bleibt der Versand aus.
  const mail = createMailService(db);
  const mailPort = mail
    ? mailServicePort(mail, async (who) =>
        db ? mailContextFor(db, who.tenantId, who.userId) : null,
      )
    : undefined;
  const orgDep = platform ? { organisation: (id: string) => platform.organisations.get(id) } : {};
  if (!db) {
    const people = createMemoryStore();
    return createInvoicesModule({
      invoices: new MemoryInvoiceRepository(),
      reminders: new MemoryReminderRepository(),
      settings: platform ? memorySettingsFor(platform) : new MemorySettingsRepository(),
      collective: createCollectiveSource(people, new MemoryGroupFeeStore()),
      people: createPersonDirectory(people),
      ...(mailPort ? { mail: mailPort } : {}),
      authenticate,
      ...orgDep,
    });
  }
  return createInvoicesModule({
    ...createPgDeps(db),
    collective: createPgCollectiveSource(db),
    people: createPersonDirectory(createPostgresStore(db)),
    ...(mailPort ? { mail: mailPort } : {}),
    authenticate,
    ...orgDep,
  });
}

export const register: ApiModule["register"] = (app) =>
  createInvoicesModuleFor(app.db, authenticateWith(app), app.platform).register(app);
