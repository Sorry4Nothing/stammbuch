import { z } from "zod";

/** Antwort von GET /health. Wird von API (Ausgabe) und Web (Prüfung) gemeinsam genutzt. */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Einheitliche Fehlerantwort der API. Enthält nie interne Details (SR-51). */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(["VALIDATION", "NOT_FOUND", "RATE_LIMITED", "PAYLOAD_TOO_LARGE", "INTERNAL"]),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
