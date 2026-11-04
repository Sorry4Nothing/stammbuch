import type { ApiError } from "@stammbuch/shared";

/** Erwarteter Fehler mit festem Code und Text für den Client (SR-51). Details gehören ins Log. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiError["error"]["code"],
    message: string,
  ) {
    super(message);
  }
}

export const unauthenticated = () => new HttpError(401, "UNAUTHENTICATED", "Nicht angemeldet.");
export const forbidden = () => new HttpError(403, "FORBIDDEN", "Keine Berechtigung.");
export const notFound = () => new HttpError(404, "NOT_FOUND", "Nicht gefunden.");
export const conflict = (message = "Die Aktion ist nicht möglich.") =>
  new HttpError(409, "CONFLICT", message);
