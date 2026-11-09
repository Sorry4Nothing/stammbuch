import type { LoginResponse, SessionResponse, TotpSetupResponse } from "@stammbuch/shared";
import type { AuthService, CodeResult, LockInfo, Session } from "./auth";

type Failed = Exclude<CodeResult, { status: "ok" }>;

interface Reply {
  status: number;
  body: unknown;
  /** Sekunden aus `Retry-After`, falls vorhanden. */
  retryAfter: number | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Fehlercode der API (`{ error: { code } }`). */
function codeOf(body: unknown): string | undefined {
  const error = isRecord(body) ? body["error"] : undefined;
  const code = isRecord(error) ? error["code"] : undefined;
  return typeof code === "string" ? code : undefined;
}

/** Nur Status, nie Text oder Inhalt der Antwort: Fehlermeldungen der API gelangen nicht in Logs oder Oberfläche. */
const unexpected = (r: Reply) => new Error(`Unerwartete Antwort der Anmelde-API (${r.status})`);

/**
 * `AuthService` gegen die Anmelde-API (gleiche Origin, kein CORS). Die Sitzung liegt in einem
 * `HttpOnly`-Cookie, das der Browser selbst mitschickt; das Skript sieht sie nie. Das CSRF-Token
 * liefert jede Antwort, die eine Sitzung ausstellt, und gehört in den Header `X-CSRF-Token`.
 * Es lebt nur im Speicher; nach dem Neuladen holt `restoreSession` es per `GET /auth/me`.
 * Die API verrät nicht die Restzahl der Versuche: dafür bleibt das Feld leer.
 */
export function createHttpAuthService(
  fetchFn: typeof fetch = (...args) => fetch(...args),
  now: () => number = Date.now,
): AuthService {
  let csrfToken: string | null = null;
  let email = "";

  async function send(
    method: "GET" | "POST" | "PATCH",
    path: string,
    payload?: object,
  ): Promise<Reply> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (payload) headers["Content-Type"] = "application/json";
    if (csrfToken && method !== "GET") headers["X-CSRF-Token"] = csrfToken;
    const res = await fetchFn(path, {
      method,
      headers,
      credentials: "same-origin",
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const body: unknown = await res.json().catch(() => null);
    const retry = Number(res.headers.get("Retry-After"));
    return { status: res.status, body, retryAfter: retry > 0 ? retry : null };
  }

  /** Übernimmt das CSRF-Token einer Antwort, die eine Sitzung ausstellt. */
  function adopt(body: unknown): Record<string, unknown> {
    if (!isRecord(body) || typeof body["csrfToken"] !== "string") {
      throw new Error("Unerwartete Antwort der Anmelde-API (Sitzung)");
    }
    csrfToken = body["csrfToken"];
    return body;
  }

  function sessionOf(body: Record<string, unknown>): Session {
    const user = body["user"] as SessionResponse["user"] | undefined;
    if (!isRecord(user) || typeof user.email !== "string") {
      throw new Error("Unerwartete Antwort der Anmelde-API (Benutzer)");
    }
    email = user.email;
    // Die Organisation kommt aus `orgName`.
    const name = typeof user.name === "string" && user.name ? user.name : user.email;
    return {
      name,
      email: user.email,
      organization: "",
      ...(user.role === "chief_admin" ? { role: "chief_admin" as const } : {}),
      startedAt: now(),
    };
  }

  function lockOf(r: Reply, cause: LockInfo["cause"]): LockInfo {
    return { email, until: now() + (r.retryAfter ?? 60) * 1000, cause };
  }

  async function mfa(path: string, payload: object): Promise<Record<string, unknown> | Failed> {
    const r = await send("POST", path, payload);
    if (r.status === 200) return adopt(r.body);
    if (r.status === 429) return { status: "locked", lock: lockOf(r, "code") };
    // Auch eine verbrauchte Zwischen-Sitzung (401 UNAUTHENTICATED) gilt als ungültiger Code.
    if (r.status === 401) return { status: "invalid" };
    throw unexpected(r);
  }

  const isResult = (v: Record<string, unknown> | Failed): v is Failed =>
    v["status"] === "locked" || v["status"] === "invalid";

  const service: AuthService = {
    csrfToken: () => csrfToken,

    async signIn(address, password) {
      const r = await send("POST", "/auth/login", { email: address, password });
      if (r.status === 200) {
        const body = adopt(r.body) as Partial<LoginResponse>;
        email = address;
        if (body.status === "mfa_required") return { status: "otp_required" };
        if (body.status === "mfa_setup_required") return { status: "mfa_setup_required" };
        throw unexpected(r);
      }
      email = address;
      if (r.status === 429) return { status: "locked", lock: lockOf(r, "password") };
      if (r.status === 401) return { status: "invalid" };
      throw unexpected(r);
    },

    async verifyCode(code) {
      const res = await mfa("/auth/2fa", { code });
      return isResult(res) ? res : { status: "ok", session: sessionOf(res) };
    },

    async verifyRecovery(code) {
      const res = await mfa("/auth/recovery", { code });
      return isResult(res) ? res : { status: "ok", session: sessionOf(res) };
    },

    // Es gibt keinen eigenen Endpunkt: wie beim ersten Anmelden Passwort, dann Code.
    async reauthenticate(password, code) {
      if (!email) throw new Error("Keine Adresse für die erneute Anmeldung");
      const first = await service.signIn(email, password);
      if (first.status === "locked") return first;
      if (first.status !== "otp_required") return { status: "invalid" };
      return service.verifyCode(code);
    },

    async signOut() {
      try {
        // Die API antwortet auch ohne Sitzung mit 204 und löscht das Cookie.
        const r = await send("POST", "/auth/logout");
        if (r.status !== 204) throw unexpected(r);
      } finally {
        csrfToken = null;
        email = "";
      }
    },

    async redeemInvitation(token, password) {
      const r = await send("POST", "/auth/invitations/redeem", { token, password });
      if (r.status === 200) {
        adopt(r.body);
        return { status: "ok" };
      }
      if (r.status === 400) {
        const code = codeOf(r.body);
        // Der Text zu schwachen Passwörtern ist für den Nutzer bestimmt (feste Sätze der API).
        const error = isRecord(r.body) ? (r.body["error"] as Record<string, unknown>) : {};
        if (code === "WEAK_PASSWORD" && typeof error["message"] === "string") {
          return { status: "weak", message: error["message"] };
        }
        return { status: "invalid" };
      }
      throw unexpected(r);
    },

    async requestPasswordReset(address) {
      // Immer 204, auch für unbekannte Adressen (SR-05); alles andere ist ein Fehler des Dienstes.
      const r = await send("POST", "/auth/password-reset/request", { email: address });
      if (r.status !== 204) throw unexpected(r);
    },

    async resetPassword(token, password, code) {
      const r = await send("POST", "/auth/password-reset/confirm", {
        token,
        password,
        ...(code ? { code } : {}),
      });
      if (r.status === 204) return { status: "ok" };
      if (r.status === 429) return { status: "locked" };
      if (r.status === 400) {
        const error = isRecord(r.body) ? (r.body["error"] as Record<string, unknown>) : {};
        if (codeOf(r.body) === "WEAK_PASSWORD" && typeof error["message"] === "string") {
          return { status: "weak", message: error["message"] };
        }
        return { status: "invalid" };
      }
      throw unexpected(r);
    },

    async updateName(name) {
      const r = await send("PATCH", "/auth/me", { name });
      const user = isRecord(r.body) ? r.body["user"] : undefined;
      if (r.status !== 200 || !isRecord(user) || typeof user["name"] !== "string") {
        throw unexpected(r);
      }
      return user["name"];
    },

    async changePassword(current, next) {
      const r = await send("POST", "/auth/password", {
        currentPassword: current,
        newPassword: next,
      });
      if (r.status === 200) {
        adopt(r.body); // neue Sitzung, neues CSRF-Token
        return { status: "ok" };
      }
      if (r.status === 429) return { status: "locked" };
      if (r.status === 401) return { status: "invalid" };
      if (r.status === 400) {
        const error = isRecord(r.body) ? (r.body["error"] as Record<string, unknown>) : {};
        if (codeOf(r.body) === "WEAK_PASSWORD" && typeof error["message"] === "string") {
          return { status: "weak", message: error["message"] };
        }
      }
      throw unexpected(r);
    },

    async renewRecoveryCodes(code) {
      const r = await send("POST", "/auth/recovery-codes/renew", { code });
      const codes = isRecord(r.body) ? r.body["recoveryCodes"] : undefined;
      if (r.status === 200 && Array.isArray(codes) && codes.every((c) => typeof c === "string")) {
        return { status: "ok", recoveryCodes: codes as string[] };
      }
      if (r.status === 429) return { status: "locked" };
      if (r.status === 401) return { status: "invalid" };
      throw unexpected(r);
    },

    async beginTotpRenewal(currentCode) {
      const r = await send("POST", "/auth/2fa/renew", { code: currentCode });
      const body = r.body as Partial<TotpSetupResponse> | null;
      if (
        r.status === 200 &&
        typeof body?.secret === "string" &&
        typeof body.otpauthUri === "string"
      ) {
        return { status: "ok", secret: body.secret, otpauthUri: body.otpauthUri };
      }
      if (r.status === 429) return { status: "locked" };
      if (r.status === 401) return { status: "invalid" };
      throw unexpected(r);
    },

    async confirmTotpRenewal(code) {
      const r = await send("POST", "/auth/2fa/renew/confirm", { code });
      if (r.status === 204) return { status: "ok" };
      if (r.status === 429) return { status: "locked" };
      if (r.status === 401) return { status: "invalid" };
      throw unexpected(r);
    },

    async beginTotpSetup() {
      const r = await send("POST", "/auth/2fa/setup", {});
      const body = r.body as Partial<TotpSetupResponse> | null;
      if (
        r.status !== 200 ||
        typeof body?.secret !== "string" ||
        typeof body.otpauthUri !== "string"
      ) {
        throw unexpected(r);
      }
      return { secret: body.secret, otpauthUri: body.otpauthUri };
    },

    async confirmTotpSetup(code) {
      const res = await mfa("/auth/2fa", { code });
      if (isResult(res)) return res;
      const codes = res["recoveryCodes"];
      if (!Array.isArray(codes) || !codes.every((c) => typeof c === "string")) {
        throw new Error("Unerwartete Antwort der Anmelde-API (Wiederherstellungscodes)");
      }
      return { status: "ok", session: sessionOf(res), recoveryCodes: codes as string[] };
    },

    async restoreSession() {
      const r = await send("GET", "/auth/me");
      if (r.status === 401) return null;
      if (r.status !== 200) throw unexpected(r);
      const body = adopt(r.body);
      // Zwischen-Sitzung (Passwort geprüft, zweiter Faktor fehlt): Token merken, aber noch nicht angemeldet.
      return body["state"] === "authenticated" ? sessionOf(body) : null;
    },
  };
  return service;
}
