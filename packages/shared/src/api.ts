import { z } from "zod";

/** Antwort von GET /health. Wird von API (Ausgabe) und Web (Prüfung) gemeinsam genutzt. */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Einheitliche Fehlerantwort der API. Enthält nie interne Details (SR-51). */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      "VALIDATION",
      "UNAUTHENTICATED",
      "FORBIDDEN",
      "NOT_FOUND",
      "CONFLICT",
      "UNPROCESSABLE",
      "LICENCE_READ_ONLY",
      "UNSUPPORTED_MEDIA",
      "RATE_LIMITED",
      "PAYLOAD_TOO_LARGE",
      "INTERNAL",
      "INVALID_CREDENTIALS",
      "INVALID_CODE",
      "CSRF_INVALID",
      "WEAK_PASSWORD",
      "INVALID_INVITATION",
      "INVALID_RESET",
    ]),
    message: z.string(),
    /** Nur bei VALIDATION: Feldpfad -> Fehlercode, nie Eingabewerte (SR-51). */
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
