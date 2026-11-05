import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  changePasswordRequestSchema,
  loginRequestSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  redeemInvitationRequestSchema,
  recoveryRequestSchema,
  totpCodeRequestSchema,
  updateNameRequestSchema,
} from "@stammbuch/shared";
import type { ApiError, SessionResponse } from "@stammbuch/shared";
import { validate } from "../../lib/validate.js";
import { AuthService } from "./service.js";
import type { Issued, SessionContext } from "./service.js";
import type { PasswordProblem } from "./password.js";

/** `__Host-`: nur über HTTPS, Path=/, ohne Domain-Attribut (kein Subdomain-Cookie-Tossing). */
export const SESSION_COOKIE = "__Host-sid";

type ErrorCode = ApiError["error"]["code"];

function fail(reply: FastifyReply, status: number, code: ErrorCode, message: string) {
  return reply.status(status).send({ error: { code, message } } satisfies ApiError);
}

const WEAK_TEXT: Record<PasswordProblem | "unchanged", string> = {
  too_short: "Das Passwort ist zu kurz (mindestens 12 Zeichen).",
  too_long: "Das Passwort ist zu lang (höchstens 128 Zeichen).",
  blocked: "Dieses Passwort ist zu einfach oder bekannt. Bitte ein anderes wählen.",
  contains_email: "Das Passwort darf nicht Teil der E-Mail-Adresse sein.",
  unchanged: "Das neue Passwort muss sich vom bisherigen unterscheiden.",
};

const idParams = z.object({ id: z.string().min(1).max(64) });

export function createAuthRoutes(service: AuthService) {
  const cfg = service.config;

  return async function authRoutes(app: FastifyInstance) {
    await app.register(cookie);

    const limit = { config: { rateLimit: { max: cfg.rateLimitMax, timeWindow: "1 minute" } } };

    // Antworten mit Sitzungsdaten dürfen nie zwischengespeichert werden.
    app.addHook("onSend", (_req, reply, payload, done) => {
      void reply.header("Cache-Control", "no-store");
      done(null, payload);
    });

    // CSRF, Schicht 1: Browser senden bei Cross-Site-POSTs immer `Origin`; fremde Origin = Abbruch.
    // Schicht 2: SameSite=Strict am Cookie. Schicht 3: Token-Header bei allen Sitzungsrouten.
    app.addHook("onRequest", async (req, reply) => {
      if (req.method === "GET" || req.method === "HEAD") return;
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== cfg.appOrigin) {
        await service.audit("csrf_rejected", req.ip);
        return fail(reply, 403, "CSRF_INVALID", "Anfrage abgelehnt.");
      }
    });

    const setSession = (reply: FastifyReply, issued: Issued) => {
      const maxAge = Math.max(
        1,
        Math.floor(
          (issued.session.expiresAt.getTime() - issued.session.createdAt.getTime()) / 1000,
        ),
      );
      void reply.setCookie(SESSION_COOKIE, issued.token, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        path: "/",
        maxAge,
      });
    };
    const clearSession = (reply: FastifyReply) =>
      void reply.clearCookie(SESSION_COOKIE, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "strict",
      });

    const tokenOf = (req: FastifyRequest) => req.cookies[SESSION_COOKIE];

    /** Sitzung auflösen, Stufe und CSRF-Token prüfen. Gibt `null` zurück, nachdem geantwortet wurde. */
    async function guard(
      req: FastifyRequest,
      reply: FastifyReply,
      stage: "pending" | "full" | "any",
    ): Promise<SessionContext | null> {
      const ctx = await service.resolve(tokenOf(req), req.ip);
      if (!ctx || (stage !== "any" && ctx.session.stage !== stage)) {
        clearSession(reply);
        void fail(reply, 401, "UNAUTHENTICATED", "Nicht angemeldet.");
        return null;
      }
      if (req.method !== "GET" && !service.verifyCsrf(ctx, req.headers["x-csrf-token"] as string)) {
        await service.audit("csrf_rejected", req.ip, ctx.user);
        void fail(reply, 403, "CSRF_INVALID", "Anfrage abgelehnt.");
        return null;
      }
      return ctx;
    }

    const locked = (reply: FastifyReply, seconds: number) =>
      void reply
        .header("Retry-After", String(seconds))
        .status(429)
        .send({
          error: {
            code: "RATE_LIMITED",
            message: "Zu viele Versuche. Bitte später erneut versuchen.",
          },
        } satisfies ApiError);

    const sessionBody = (
      user: SessionContext["user"],
      csrfToken: string,
      extra: Partial<SessionResponse> = {},
    ): SessionResponse => ({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      csrfToken,
      ...extra,
    });

    // --- POST /auth/login -------------------------------------------------------------
    app.post("/auth/login", limit, async (req, reply) => {
      const body = validate(loginRequestSchema, req.body);
      const res = await service.login({ ...body, previousToken: tokenOf(req) }, req.ip);
      if (res.kind === "locked") return locked(reply, res.retryAfterSeconds);
      // Eine Antwort für "Konto unbekannt" und "Passwort falsch" (SR-05).
      if (res.kind === "invalid") {
        return fail(reply, 401, "INVALID_CREDENTIALS", "Anmeldung fehlgeschlagen.");
      }
      setSession(reply, res.issued);
      return { status: res.next, csrfToken: res.issued.session.csrfToken };
    });

    // --- POST /auth/invitations/redeem (öffentlich) -----------------------------------
    // Eine Antwort für unbekannt, abgelaufen und schon benutzt (SR-05). Rate-Limit pro IP (SR-71).
    app.post("/auth/invitations/redeem", limit, async (req, reply) => {
      const body = validate(redeemInvitationRequestSchema, req.body);
      const res = await service.redeemInvitation({ ...body, previousToken: tokenOf(req) }, req.ip);
      if (res.kind === "invalid") {
        return fail(
          reply,
          400,
          "INVALID_INVITATION",
          "Die Einladung ist ungültig oder abgelaufen.",
        );
      }
      if (res.kind === "weak") return fail(reply, 400, "WEAK_PASSWORD", WEAK_TEXT[res.problem]);
      setSession(reply, res.issued);
      return { status: "mfa_setup_required", csrfToken: res.issued.session.csrfToken };
    });

    // --- POST /auth/password-reset/request (öffentlich) --------------------------------
    // Immer dieselbe Antwort, egal ob es das Konto gibt (SR-05). Engeres Limit pro IP (SR-04, SR-71); das Limit pro
    // Konto sitzt in der Datenbank.
    app.post(
      "/auth/password-reset/request",
      {
        config: {
          rateLimit: { max: Math.max(1, Math.floor(cfg.rateLimitMax / 2)), timeWindow: "1 minute" },
        },
      },
      async (req, reply) => {
        const body = validate(passwordResetRequestSchema, req.body);
        await service.requestPasswordReset(body.email, req.ip);
        return reply.status(204).send();
      },
    );

    // --- POST /auth/password-reset/confirm (öffentlich) --------------------------------
    // Token aus dem Link, neues Passwort und (falls eingerichtet) der zweite Faktor.
    app.post("/auth/password-reset/confirm", limit, async (req, reply) => {
      const body = validate(passwordResetConfirmSchema, req.body);
      const res = await service.resetPassword(body, req.ip);
      if (res.kind === "locked") return locked(reply, res.retryAfterSeconds);
      if (res.kind === "invalid") {
        return fail(
          reply,
          400,
          "INVALID_RESET",
          "Der Link oder der Code ist ungültig oder abgelaufen.",
        );
      }
      if (res.kind === "weak") return fail(reply, 400, "WEAK_PASSWORD", WEAK_TEXT[res.problem]);
      return reply.status(204).send();
    });

    // --- POST /auth/2fa/setup ---------------------------------------------------------
    app.post("/auth/2fa/setup", limit, async (req, reply) => {
      const ctx = await guard(req, reply, "pending");
      if (!ctx) return reply;
      const setup = await service.beginTotpSetup(ctx);
      if (!setup) return fail(reply, 403, "FORBIDDEN", "Nicht erlaubt.");
      return setup;
    });

    // --- POST /auth/2fa ---------------------------------------------------------------
    app.post("/auth/2fa", limit, async (req, reply) => {
      const body = validate(totpCodeRequestSchema, req.body);
      const ctx = await guard(req, reply, "pending");
      if (!ctx) return reply;
      const res = await service.completeMfa(ctx, body.code, req.ip);
      if (res.kind === "locked") return locked(reply, res.retryAfterSeconds);
      if (res.kind === "invalid") return fail(reply, 401, "INVALID_CODE", "Code ungültig.");
      setSession(reply, res.issued);
      return sessionBody(ctx.user, res.issued.session.csrfToken, {
        ...(res.recoveryCodes ? { recoveryCodes: res.recoveryCodes } : {}),
        remainingRecoveryCodes: res.remainingRecoveryCodes,
      });
    });

    // --- POST /auth/recovery ----------------------------------------------------------
    app.post("/auth/recovery", limit, async (req, reply) => {
      const body = validate(recoveryRequestSchema, req.body);
      const ctx = await guard(req, reply, "pending");
      if (!ctx) return reply;
      const res = await service.useRecoveryCode(ctx, body.code, req.ip);
      if (res.kind === "locked") return locked(reply, res.retryAfterSeconds);
      if (res.kind === "invalid") return fail(reply, 401, "INVALID_CODE", "Code ungültig.");
      setSession(reply, res.issued);
      return sessionBody(ctx.user, res.issued.session.csrfToken, {
        remainingRecoveryCodes: res.remainingRecoveryCodes,
      });
    });

    // --- POST /auth/logout ------------------------------------------------------------
    app.post("/auth/logout", async (req, reply) => {
      const ctx = await service.resolve(tokenOf(req), req.ip);
      if (ctx) {
        if (!service.verifyCsrf(ctx, req.headers["x-csrf-token"] as string)) {
          await service.audit("csrf_rejected", req.ip, ctx.user);
          return fail(reply, 403, "CSRF_INVALID", "Anfrage abgelehnt.");
        }
        await service.logout(ctx, req.ip);
      }
      clearSession(reply);
      return reply.status(204).send();
    });

    // --- POST /auth/password ----------------------------------------------------------
    app.post("/auth/password", limit, async (req, reply) => {
      const body = validate(changePasswordRequestSchema, req.body);
      const ctx = await guard(req, reply, "full");
      if (!ctx) return reply;
      const res = await service.changePassword(ctx, body, req.ip);
      if (res.kind === "locked") return locked(reply, res.retryAfterSeconds);
      if (res.kind === "invalid") {
        return fail(reply, 401, "INVALID_CREDENTIALS", "Aktuelles Passwort falsch.");
      }
      if (res.kind === "weak") return fail(reply, 400, "WEAK_PASSWORD", WEAK_TEXT[res.problem]);
      setSession(reply, res.issued);
      return sessionBody(ctx.user, res.issued.session.csrfToken);
    });

    // --- POST /auth/admin/users/:id/2fa-reset -----------------------------------------
    // Step-up: verlangt einen frischen TOTP-Code des Chef-Admins im Body.
    app.post("/auth/admin/users/:id/2fa-reset", limit, async (req, reply) => {
      const { id } = validate(idParams, req.params);
      const body = validate(totpCodeRequestSchema, req.body);
      const ctx = await guard(req, reply, "full");
      if (!ctx) return reply;
      const res = await service.resetMfa(ctx, id, body.code, req.ip);
      if (res.kind === "locked") return locked(reply, res.retryAfterSeconds);
      if (res.kind === "invalid") return fail(reply, 401, "INVALID_CODE", "Code ungültig.");
      if (res.kind === "forbidden") return fail(reply, 403, "FORBIDDEN", "Nicht erlaubt.");
      if (res.kind === "not_found") return fail(reply, 404, "NOT_FOUND", "Nicht gefunden.");
      return reply.status(204).send();
    });

    // --- POST /auth/recovery-codes/renew ----------------------------------------------
    // Neue Wiederherstellungscodes (einmalig sichtbar), nur mit frischem TOTP-Code.
    app.post("/auth/recovery-codes/renew", limit, async (req, reply) => {
      const body = validate(totpCodeRequestSchema, req.body);
      const ctx = await guard(req, reply, "full");
      if (!ctx) return reply;
      const res = await service.renewRecoveryCodes(ctx, body.code, req.ip);
      if (res.kind === "locked") return locked(reply, res.retryAfterSeconds);
      if (res.kind === "invalid") return fail(reply, 401, "INVALID_CODE", "Code ungültig.");
      return { recoveryCodes: res.recoveryCodes, remainingRecoveryCodes: res.recoveryCodes.length };
    });

    // --- PATCH /auth/me ---------------------------------------------------------------
    // Eigenen Namen ändern. Betroffen ist immer der Benutzer der Sitzung, nie eine ID aus dem Request.
    app.patch("/auth/me", async (req, reply) => {
      const body = validate(updateNameRequestSchema, req.body);
      const ctx = await guard(req, reply, "full");
      if (!ctx) return reply;
      const user = await service.changeName(ctx, body.name, req.ip);
      if (!user) return fail(reply, 403, "FORBIDDEN", "Nicht erlaubt.");
      return sessionBody(user, ctx.session.csrfToken);
    });

    // --- GET /auth/me -----------------------------------------------------------------
    app.get("/auth/me", async (req, reply) => {
      const ctx = await guard(req, reply, "any");
      if (!ctx) return reply;
      if (ctx.session.stage === "pending") {
        return { state: "pending", csrfToken: ctx.session.csrfToken };
      }
      return { state: "authenticated", ...sessionBody(ctx.user, ctx.session.csrfToken) };
    });
  };
}
