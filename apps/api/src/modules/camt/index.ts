import multipart from "@fastify/multipart";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { errorHandler } from "../../lib/errors.js";
import { validate } from "../../lib/validate.js";
import type { ApiModule } from "../types.js";
import type { ImportedPayment } from "./repository.js";
import { CamtRestService } from "./rest.js";
import { CamtImportService } from "./service.js";
import type { ImportResult } from "./service.js";
import { CamtError } from "./types.js";
import { MAX_CAMT_BYTES } from "./upload.js";

export const name = "camt";

export type Authorize = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const paymentSchema = z.object({
  id: z.string(),
  status: z.enum(["MATCHED", "REST", "MANUAL"]),
  openItemId: z.string().optional(),
  restReason: z.string().optional(),
  bookingDate: z.string(),
  amountRappen: z.number().int(),
  currency: z.string(),
  direction: z.enum(["CREDIT", "DEBIT"]),
  reversal: z.boolean(),
  reference: z.string().optional(),
  debtorName: z.string().optional(),
  debtorIban: z.string().optional(),
  remittanceInfo: z.string().optional(),
});

/** Antwortformat von POST /camt/import: nur Felder, die Ergebnis- und Restposten-Ansicht brauchen (SR-74). */
export const importResponseSchema = z.object({
  importId: z.string(),
  kind: z.enum(["camt.053", "camt.054"]),
  messageId: z.string(),
  counts: z.object({
    total: z.number().int(),
    matched: z.number().int(),
    rest: z.number().int(),
    duplicates: z.number().int(),
    ignored: z.number().int(),
  }),
  matched: z.array(paymentSchema),
  rest: z.array(paymentSchema),
});
export type ImportResponse = z.infer<typeof importResponseSchema>;

export function toPaymentResponse(p: ImportedPayment): z.infer<typeof paymentSchema> {
  const t = p.transaction;
  return paymentSchema.parse({
    id: p.id,
    status: p.status,
    openItemId: p.openItemId,
    restReason: p.restReason,
    bookingDate: t.bookingDate,
    amountRappen: t.amountRappen,
    currency: t.currency,
    direction: t.direction,
    reversal: t.reversal,
    reference: t.reference?.value,
    debtorName: t.debtorName,
    debtorIban: t.debtorIban,
    remittanceInfo: t.remittanceInfo,
  });
}

export function toResponse(r: ImportResult): ImportResponse {
  return importResponseSchema.parse({
    importId: r.import.id,
    kind: r.import.kind,
    messageId: r.import.messageId,
    counts: r.import.counts,
    matched: r.matched.map(toPaymentResponse),
    rest: r.rest.map(toPaymentResponse),
  });
}

const STATUS: Record<CamtError["code"], number> = {
  INVALID_UPLOAD: 400,
  FILE_TOO_LARGE: 413,
  INVALID_XML: 422,
  UNSUPPORTED_FORMAT: 422,
  INVALID_CONTENT: 422,
  DUPLICATE_FILE: 409,
  INVALID_CURSOR: 400,
  PAYMENT_NOT_FOUND: 404,
  PAYMENT_NOT_REST: 409,
  PAYMENT_NOT_ASSIGNABLE: 409,
  OPEN_ITEM_NOT_FOUND: 404,
  OPEN_ITEM_NOT_OPEN: 409,
};

/** Ohne Authentifizierung gibt es keinen Import: fail secure, bis das Auth-Modul eingehängt ist (SR-10). */
const denyAll: Authorize = (_req, reply) => {
  void reply
    .status(401)
    .send({ error: { code: "UNAUTHENTICATED", message: "Anmeldung erforderlich." } });
  return Promise.resolve();
};

/** Dienste für genau einen Kunden, gebaut aus der serverseitig aufgelösten Sitzung (SR-13). */
export interface CamtScope {
  service: CamtImportService;
  rest: CamtRestService;
}

export interface CamtModuleDeps {
  authorize: Authorize;
  /** Läuft nach `authorize`; liefert die Dienste des angemeldeten Kunden. */
  scope: (request: FastifyRequest) => CamtScope;
}

const restQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,40}$/)
    .optional(),
});
const assignParams = z.object({ id: z.uuid() });
const assignBody = z.object({ openItemId: z.string().min(1).max(100) });

export function createCamtModule(deps: CamtModuleDeps): ApiModule {
  return {
    name,
    async register(app) {
      await app.register(multipart, {
        limits: { fileSize: MAX_CAMT_BYTES, files: 1, fields: 0, parts: 2, headerPairs: 20 },
      });

      // Eigene, fest formulierte Fehlerantworten (SR-51); alles andere geht an den zentralen Handler.
      app.setErrorHandler((error, request, reply) => {
        if (!(error instanceof CamtError)) return errorHandler(error, request, reply);
        request.log.info({ code: error.code }, "CAMT-Anfrage abgelehnt");
        return reply.status(STATUS[error.code]).send({
          error: { code: error.code, message: error.message },
          ...(error.details?.importId ? { importId: error.details.importId } : {}),
        });
      });

      app.post(
        "/camt/import",
        { preHandler: deps.authorize, bodyLimit: MAX_CAMT_BYTES + 64 * 1024 },
        async (request) => {
          if (!request.isMultipart()) throw new CamtError("INVALID_UPLOAD", "Multipart erwartet.");
          const part = await request.file();
          if (!part || part.fieldname !== "file") {
            throw new CamtError("INVALID_UPLOAD", "Feld «file» fehlt.");
          }
          // Wirft bei Überschreitung des Limits (413); Dateiname und Content-Type bleiben unbeachtet.
          const bytes = await part.toBuffer();
          return toResponse(await deps.scope(request).service.importFile(bytes));
        },
      );

      app.get("/camt/rest", { preHandler: deps.authorize }, async (request) => {
        const q = validate(restQuery, request.query);
        const page = await deps
          .scope(request)
          .rest.list({ limit: q.limit, ...(q.cursor ? { after: q.cursor } : {}) });
        return {
          items: page.items.map(toPaymentResponse),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      });

      app.post("/camt/rest/:id/zuordnen", { preHandler: deps.authorize }, async (request) => {
        const { id } = validate(assignParams, request.params);
        const { openItemId } = validate(assignBody, request.body);
        await deps.scope(request).rest.assign(id, openItemId);
        return { id, status: "MANUAL", openItemId };
      });
    },
  };
}

/**
 * Standard-Einhängung ohne Datenbank: Zugriff verweigert (nur Tests und Entwicklung).
 * Die Verdrahtung mit Datenbank und Anmeldung steht in `pg.ts` (`register`).
 */
const unavailable = (): CamtScope => {
  throw new Error("CAMT-Modul ohne Kunden-Kontext");
};
const defaultModule = createCamtModule({ authorize: denyAll, scope: unavailable });
export const register = defaultModule.register;
