import multipart from "@fastify/multipart";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { errorHandler } from "../../lib/errors.js";
import type { ApiModule } from "../types.js";
import { InMemoryCamtRepository } from "./repository.js";
import { CamtImportService } from "./service.js";
import type { ImportResult, OpenItemLookup } from "./service.js";
import { CamtError } from "./types.js";
import { MAX_CAMT_BYTES } from "./upload.js";

export const name = "camt";

export type Authorize = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const paymentSchema = z.object({
  id: z.string(),
  status: z.enum(["MATCHED", "REST"]),
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

export function toResponse(r: ImportResult): ImportResponse {
  const map = (p: ImportResult["matched"][number]) => {
    const t = p.transaction;
    return {
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
    };
  };
  return importResponseSchema.parse({
    importId: r.import.id,
    kind: r.import.kind,
    messageId: r.import.messageId,
    counts: r.import.counts,
    matched: r.matched.map(map),
    rest: r.rest.map(map),
  });
}

const STATUS: Record<CamtError["code"], number> = {
  INVALID_UPLOAD: 400,
  FILE_TOO_LARGE: 413,
  INVALID_XML: 422,
  UNSUPPORTED_FORMAT: 422,
  INVALID_CONTENT: 422,
  DUPLICATE_FILE: 409,
};

/** Ohne Authentifizierung gibt es keinen Import: fail secure, bis das Auth-Modul eingehängt ist (SR-10). */
const denyAll: Authorize = (_req, reply) => {
  void reply
    .status(401)
    .send({ error: { code: "UNAUTHENTICATED", message: "Anmeldung erforderlich." } });
  return Promise.resolve();
};

export interface CamtModuleDeps {
  service: CamtImportService;
  authorize: Authorize;
}

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
        request.log.info({ code: error.code }, "CAMT-Import abgelehnt");
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
          return toResponse(await deps.service.importFile(bytes));
        },
      );
    },
  };
}

/**
 * Standard-Einhängung: In-Memory-Persistenz, keine offenen Posten, Zugriff verweigert.
 * Die Verdrahtung mit DB (#3), Rechnungen (#7) und Auth erfolgt über `createCamtModule`.
 */
const noOpenItems: OpenItemLookup = { findByReferences: () => Promise.resolve([]) };
const defaultModule = createCamtModule({
  service: new CamtImportService(new InMemoryCamtRepository(), noOpenItems),
  authorize: denyAll,
});
export const register = defaultModule.register;
