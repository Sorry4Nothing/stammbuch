import { z } from "zod";

/** Gemeinsame Verträge der Anmelde-API (Server prüft Eingaben, Oberfläche prüft Antworten). */

export const loginRequestSchema = z.object({
  email: z.string().trim().pipe(z.email().max(254)),
  // Obergrenze nur gegen Missbrauch (Hash-Kosten); die Passwortregeln gelten beim Setzen.
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * Einladung einlösen (öffentlich). Token und Passwort werden hier nur gegen Missbrauch begrenzt;
 * die Passwortregeln gelten serverseitig. Die Antwort ist `LoginResponse` mit `mfa_setup_required`.
 */
export const redeemInvitationRequestSchema = z.object({
  token: z.string().min(1).max(256),
  password: z.string().min(1).max(256),
});
export type RedeemInvitationRequest = z.infer<typeof redeemInvitationRequestSchema>;

/** Nach dem Passwort ist der Nutzer erst "halb" angemeldet; der zweite Faktor fehlt noch. */
export const loginResponseSchema = z.object({
  status: z.enum(["mfa_required", "mfa_setup_required"]),
  csrfToken: z.string(),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const totpCodeRequestSchema = z.object({
  code: z
    .string()
    .max(16)
    .transform((v) => v.replace(/\s/g, ""))
    .pipe(z.string().regex(/^\d{6}$/)),
});

export const recoveryRequestSchema = z.object({ code: z.string().min(1).max(40) });

export const totpSetupResponseSchema = z.object({
  secret: z.string(),
  otpauthUri: z.string(),
});
export type TotpSetupResponse = z.infer<typeof totpSetupResponseSchema>;

/** Antwort nach erfolgreichem zweiten Faktor. `recoveryCodes` nur bei der Einrichtung (einmalig). */
export const sessionResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    role: z.enum(["user", "chief_admin"]),
  }),
  csrfToken: z.string(),
  recoveryCodes: z.array(z.string()).optional(),
  remainingRecoveryCodes: z.number().int().optional(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const meResponseSchema = z.union([
  z.object({ state: z.literal("pending"), csrfToken: z.string() }),
  sessionResponseSchema.extend({ state: z.literal("authenticated") }),
]);

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});
