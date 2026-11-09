import { ApiError, CodeRejectedError } from "./model";
import {
  RotationLimitError,
  RotationLockedError,
  ROTATION_KINDS,
  type RotationKindStatus,
  type RotationOutcome,
  type RotationRun,
  type RotationService,
  type RotationStatus,
} from "./rotationModel";

interface Options {
  /** CSRF-Token der Sitzung für schreibende Anfragen. */
  csrfToken: () => string | null;
  /** Wird bei 401 aufgerufen (Sitzung abgelaufen). */
  onUnauthorized: () => void;
  fetchFn?: typeof fetch;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];

function toStatus(data: unknown): RotationStatus {
  const part = (raw: unknown): RotationKindStatus => {
    const r = isRecord(raw) ? raw : {};
    return {
      configured: r["configured"] === true,
      lastRunAt: typeof r["lastRunAt"] === "string" ? r["lastRunAt"] : null,
      unreadable: strings(r["unreadable"]),
    };
  };
  const d = isRecord(data) ? data : {};
  return { mail: part(d["mail"]), totp: part(d["totp"]) };
}

function toRun(data: unknown): RotationRun {
  const outcome = (raw: unknown): RotationOutcome | null => {
    if (!isRecord(raw)) return null;
    return {
      rotated: typeof raw["rotated"] === "number" ? raw["rotated"] : 0,
      failed: strings(raw["failed"]),
      aborted: raw["aborted"] === true,
    };
  };
  const d = isRecord(data) ? data : {};
  return Object.fromEntries(ROTATION_KINDS.map((k) => [k, outcome(d[k])])) as RotationRun;
}

/** Wartezeit aus `Retry-After` (Sekunden); fehlt oder fehlerhaft: `null`. */
function retryAfter(res: Response): number | null {
  const n = Number(res.headers.get("Retry-After"));
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}

/**
 * `RotationService` gegen `GET/POST /admin/rotation`. Gleiche Origin, Cookie-Sitzung, `X-CSRF-Token` beim Starten.
 * Der Einmalcode steht nur im Body, nie in der URL; nichts davon wird protokolliert.
 */
export function createHttpRotationService({
  csrfToken,
  onUnauthorized,
  fetchFn = (...args) => fetch(...args),
}: Options): RotationService {
  return {
    async status(signal) {
      const res = await fetchFn("/admin/rotation", {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        ...(signal ? { signal } : {}),
      });
      if (res.status === 401) onUnauthorized();
      if (!res.ok) throw new ApiError(res.status);
      return toStatus(await res.json().catch(() => null));
    },

    async run(code) {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/json",
      };
      const token = csrfToken();
      if (token) headers["X-CSRF-Token"] = token;
      const res = await fetchFn("/admin/rotation", {
        method: "POST",
        headers,
        credentials: "same-origin",
        body: JSON.stringify({ code }),
      });
      if (res.status === 401) {
        // 401 heisst hier auch «falscher Code»; nur eine verlorene Sitzung meldet sich ab.
        const data: unknown = await res.json().catch(() => null);
        const error = isRecord(data) && isRecord(data["error"]) ? data["error"] : null;
        if (error?.["code"] === "INVALID_CODE") throw new CodeRejectedError();
        onUnauthorized();
      }
      if (res.status === 423) throw new RotationLockedError();
      if (res.status === 429) throw new RotationLimitError(retryAfter(res));
      if (!res.ok) throw new ApiError(res.status);
      return toRun(await res.json().catch(() => null));
    },
  };
}
