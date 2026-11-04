import { ZodError } from "zod";
import type { ZodType } from "zod";

/**
 * Muster für die Eingabevalidierung (SR-20, SR-72): jede Eingabe an der Vertrauensgrenze
 * (Body, Query, Params) geht durch ein Zod-Schema. Das Ergebnis enthält nur die Felder des
 * Schemas (z.B. `z.object`, nicht `z.looseObject`), so gibt es keine Massenzuweisung.
 * Ein Fehler wird vom zentralen Fehlerhandler als generische 400-Antwort ausgegeben.
 */
export function validate<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw result.error;
  return result.data;
}

export function isValidationError(error: unknown): error is ZodError {
  return error instanceof ZodError;
}
