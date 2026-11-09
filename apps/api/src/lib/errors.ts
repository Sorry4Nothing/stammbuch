import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiError } from "@stammbuch/shared";
import { HttpError } from "./http-error.js";
import { isValidationError } from "./validate.js";
import type { ZodError } from "zod";

const notFound: ApiError["error"] = { code: "NOT_FOUND", message: "Nicht gefunden." };
const known: Record<number, ApiError["error"]> = {
  400: { code: "VALIDATION", message: "Ungültige Anfrage." },
  401: { code: "UNAUTHENTICATED", message: "Nicht angemeldet." },
  403: { code: "FORBIDDEN", message: "Keine Berechtigung." },
  404: notFound,
  409: { code: "CONFLICT", message: "Konflikt mit dem aktuellen Stand." },
  413: { code: "PAYLOAD_TOO_LARGE", message: "Anfrage zu gross." },
  415: { code: "VALIDATION", message: "Ungültige Anfrage." },
  429: { code: "RATE_LIMITED", message: "Zu viele Anfragen." },
};
const internal: ApiError["error"] = { code: "INTERNAL", message: "Interner Fehler." };

/**
 * Erwarteter Fachfehler mit Text, der für den Client bestimmt ist (kein Interna-Leck!).
 * Der Text darf keine Personendaten enthalten.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: 400 | 401 | 403 | 404 | 409,
    readonly clientMessage?: string,
  ) {
    super(clientMessage ?? "AppError");
  }
}

function statusOf(error: unknown): number {
  if (isValidationError(error)) return 400;
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const { statusCode } = error;
    if (typeof statusCode === "number") return statusCode;
  }
  return 500;
}

const MAX_FIELDS = 20;

/** Nur Formular-Routen melden Feldpfade; alle anderen Routen verraten kein Schema (SR-51). */
const FIELD_ERROR_ROUTES = /^(\/api)?\/(mitglieder|firmen|settings\/organisation)(\/|\?|$)/;

/**
 * Feldpfad -> Zod-Fehlercode (z.B. `adresse.plz: "custom"`), damit die Oberfläche das Feld markieren
 * kann. Nie Eingabewerte oder Zod-Texte (SR-51): nur Pfad und Code.
 */
function fieldCodes(error: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.map(String).join(".").slice(0, 80);
    if (path && !(path in out) && Object.keys(out).length < MAX_FIELDS) out[path] = issue.code;
  }
  return out;
}

/**
 * Zentraler Fehlerhandler (SR-51, SR-54): Der Client sieht nur Code und festen Text.
 * Details und Stacktrace gehen ausschliesslich ins Server-Log. Alles Unbekannte ist ein 500.
 */
export function errorHandler(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  const status = statusOf(error);
  const base = known[status];
  const body =
    error instanceof HttpError
      ? { code: error.code, message: error.message }
      : base && error instanceof AppError && error.clientMessage
        ? { ...base, message: error.clientMessage }
        : base;

  if (!body) {
    request.log.error({ err: error }, "Unbehandelter Fehler");
    return reply.status(500).send({ error: internal } satisfies ApiError);
  }
  request.log.info({ status }, "Anfrage abgelehnt");
  const fields =
    isValidationError(error) && FIELD_ERROR_ROUTES.test(request.url) ? fieldCodes(error) : {};
  return reply
    .status(status)
    .send({ error: Object.keys(fields).length > 0 ? { ...body, fields } : body } satisfies ApiError);
}

export function notFoundHandler(_request: FastifyRequest, reply: FastifyReply) {
  return reply.status(404).send({ error: notFound } satisfies ApiError);
}
