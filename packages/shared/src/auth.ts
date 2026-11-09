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

/** Passwort vergessen: Link anfordern. Die Antwort ist immer dieselbe, auch für unbekannte Adressen. */
export const passwordResetRequestSchema = z.object({
  email: z.string().trim().pipe(z.email().max(254)),
});

/**
 * Passwort mit dem Token aus dem Link neu setzen. `code` ist der Einmalcode der Authenticator-App oder ein
 * Wiederherstellungscode; er ist Pflicht, sobald der zweite Faktor eingerichtet ist (die Antwort verrät das nicht).
 */
export const passwordResetConfirmSchema = z.object({
  token: z.string().min(1).max(256),
  password: z.string().min(1).max(256),
  code: z.string().max(40).optional(),
});

export const updateNameRequestSchema = z.object({ name: z.string().trim().min(1).max(120) });

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

/** Mindestlänge des Grundes beim 2FA-Reset (Zeichen nach dem Trimmen). */
export const MFA_RESET_REASON_MIN = 10;

/**
 * Chef-Admin setzt den zweiten Faktor eines Benutzers zurück: frischer Einmalcode des Chef-Admins (Step-up) plus
 * Pflicht: ein Grund und die Bestätigung des Rückrufs (`calledBack` muss `true` sein). Beides kommt ins
 * Plattformprotokoll (Design 10.4).
 */
export const adminMfaResetRequestSchema = totpCodeRequestSchema.extend({
  reason: z.string().trim().min(MFA_RESET_REASON_MIN).max(200),
  calledBack: z.literal(true),
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
    name: z.string(),
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

/** Angaben zur eigenen Anmeldung. `null`: unbekannt bzw. kein zweiter Faktor eingerichtet. */
export const securityInfoResponseSchema = z.object({
  passwordChangedAt: z.string().nullable(),
  totpSince: z.string().nullable(),
  recoveryLeft: z.number().int().nullable(),
  recoveryTotal: z.number().int().nullable(),
  /** Kurze Bezeichnung des Geräts dieser Sitzung («Firefox auf Windows»); `null`: unbekannt. */
  device: z.string().nullable().optional(),
});
export type SecurityInfoResponse = z.infer<typeof securityInfoResponseSchema>;

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});
