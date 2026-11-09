import type {
  AuditEntryResponse,
  LicenceResponse,
  OrganisationResponse,
  UserResponse,
} from "@stammbuch/shared";
import { supportEmail } from "../../config";
import {
  ApiError,
  TEST_STAGE_COUNT,
  type Features,
  type MailDraft,
  type MailState,
  type OrgData,
  type TestOutcome,
  type TestStage,
} from "./model";
import type { SettingsService } from "./service";

interface Options {
  /** CSRF-Token der Sitzung für schreibende Anfragen. */
  csrfToken: () => string | null;
  /** Wird bei 401 aufgerufen (Sitzung abgelaufen). */
  onUnauthorized: () => void;
  /** Holt nach einer Änderung des Passworts das neue CSRF-Token (die API stellt eine neue Sitzung aus). */
  refreshSession?: () => Promise<unknown>;
  fetchFn?: typeof fetch;
}

/** Was die API heute nicht liefert, bleibt aus: die Oberfläche blendet die zugehörigen Felder aus. */
export const httpFeatures: Features = {
  legalForm: false,
  accountHolder: false,
  creditAccount: false,
  paymentDays: false,
  closing: false,
  lastLogin: false,
  securityInfo: false,
  totpRenewal: false,
  licenceDetails: false,
  auditResult: false,
  auditXlsx: false,
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const pad = (n: number) => String(n).padStart(2, "0");

/** Letzter Tag der Monate (Februar mit 28; 29 gilt in der Prüfung ebenfalls). */
export const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Beginn des Geschäftsjahres am 1. des Monats `m` (1 bis 12) als «01.MM.», Ende als «TT.MM.». */
export function fiscalRange(startMonth: number): { start: string; end: string } {
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  return {
    start: `01.${pad(startMonth)}.`,
    end: `${pad(DAYS_IN_MONTH[endMonth - 1]!)}.${pad(endMonth)}.`,
  };
}

export const emptyMail = (): MailDraft => ({
  email: "",
  username: "",
  password: "",
  senderName: "",
  imapHost: "",
  imapPort: "993",
  imapSecurity: "tls",
  smtpHost: "",
  smtpPort: "465",
  smtpSecurity: "tls",
});

type Reason = "ok" | string;
type VerifyResult = { smtp: Reason; imap: Reason | null };

/** Stufe (0 bis 5), bei der ein Fehler der API liegt. */
const imapStage = (code: string) => (code === "CONNECT" ? 0 : code === "TLS" ? 1 : 2);
const smtpStage = (code: string) => (code === "CONNECT" || code === "TLS" ? 3 : 4);

/** Die API prüft IMAP und SMTP und liefert je ein Ergebnis. Das Teilergebnis wird auf die sechs Stufen verteilt. */
export function stagesOf(result: VerifyResult): { stages: TestStage[]; failedAt?: number } {
  let failedAt: number | undefined;
  if (result.imap && result.imap !== "ok") failedAt = imapStage(result.imap);
  else if (result.smtp !== "ok") failedAt = smtpStage(result.smtp);
  const stages: TestStage[] = Array.from({ length: TEST_STAGE_COUNT }, (_, i) => ({
    status: failedAt === undefined || i < failedAt ? "ok" : i === failedAt ? "failed" : "skipped",
  }));
  // Die Testmail ist die letzte Stufe und folgt erst, wenn alles andere gelungen ist.
  if (failedAt === undefined) stages[5] = { status: "pending" };
  return { stages, ...(failedAt !== undefined && { failedAt }) };
}

const withScheme = (url: string) => (url && !/^https?:\/\//i.test(url) ? `https://${url}` : url);

export function createHttpSettingsService({
  csrfToken,
  onUnauthorized,
  refreshSession,
  fetchFn = (...args) => fetch(...args),
}: Options): SettingsService {
  /** Zuletzt geladener Stand der Organisation: Felder, die die Oberfläche nicht kennt, gehen so nicht verloren. */
  let raw: OrganisationResponse | null = null;
  let mailId: string | null = null;

  async function request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    init: { json?: object; body?: BodyInit; contentType?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.json) headers["Content-Type"] = "application/json";
    if (init.contentType) headers["Content-Type"] = init.contentType;
    const token = csrfToken();
    if (token && method !== "GET") headers["X-CSRF-Token"] = token;
    const res = await fetchFn(path, {
      method,
      headers,
      credentials: "same-origin",
      ...(init.json && { body: JSON.stringify(init.json) }),
      ...(init.body && { body: init.body }),
      ...(init.signal && { signal: init.signal }),
    });
    if (res.status === 401) onUnauthorized();
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      const error = isRecord(body) ? body["error"] : undefined;
      const code = isRecord(error) && typeof error["code"] === "string" ? error["code"] : "ERROR";
      // Nur Status und Code, nie der Text des Servers: Er gelangt weder in Logs noch in die Oberfläche.
      throw new ApiError(res.status, code);
    }
    return res;
  }

  const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

  function toOrg(r: OrganisationResponse): OrgData {
    const fiscal = fiscalRange(r["fiscal-year"].startMonth);
    return {
      name: r.master.name,
      legalForm: "",
      street: r.master.street,
      zip: r.master.zip,
      city: r.master.city,
      phone: r.master.phone,
      email: r.master.email,
      website: r.master.website,
      vatNumber: r.master.vatNumber,
      uid: r.master.uid,
      senderName: r.sender.name,
      replyTo: r.sender.replyTo,
      footer: r.sender.footer,
      accountHolder: "",
      bankName: r.bank.bankName,
      qrIban: r.bank.qrIban,
      creditAccount: "",
      paymentDays: "",
      fiscalStart: fiscal.start,
      fiscalEnd: fiscal.end,
      closing: "monthly",
      sammelrechnung: r.modules.sammelrechnung,
      mail: r.modules.mail,
      kalender: r.modules.kalender,
    };
  }

  const same = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);

  async function organisation(signal?: AbortSignal) {
    const res = await request("GET", "/settings/organisation", signal ? { signal } : {});
    raw = await json<OrganisationResponse>(res);
    return raw;
  }

  async function putSection(section: string, body: object) {
    await request("PUT", `/settings/organisation/${section}`, { json: body });
  }

  function toMail(account: Record<string, unknown>): MailDraft {
    const endpoint = (v: unknown, fallback: { port: string; security: "tls" | "starttls" }) => {
      const e = isRecord(v) ? v : {};
      return {
        host: typeof e["host"] === "string" ? e["host"] : "",
        port: typeof e["port"] === "number" ? String(e["port"]) : fallback.port,
        security: e["security"] === "starttls" ? ("starttls" as const) : ("tls" as const),
      };
    };
    const imap = endpoint(account["imap"], { port: "993", security: "tls" });
    const smtp = endpoint(account["smtp"], { port: "465", security: "tls" });
    return {
      email: String(account["fromAddress"] ?? ""),
      username: String(account["username"] ?? ""),
      password: "",
      senderName: String(account["fromName"] ?? account["label"] ?? ""),
      imapHost: imap.host,
      imapPort: imap.port,
      imapSecurity: imap.security,
      smtpHost: smtp.host,
      smtpPort: smtp.port,
      smtpSecurity: smtp.security,
    };
  }

  async function saveMail(draft: MailDraft) {
    // Die API kennt kein Ändern: das Konto wird ersetzt (das Passwort ist darum Pflicht).
    if (mailId) {
      await request("DELETE", `/mail/accounts/${encodeURIComponent(mailId)}`);
      mailId = null;
    }
    const res = await request("POST", "/mail/accounts", {
      json: {
        label: draft.senderName || draft.email,
        fromAddress: draft.email,
        fromName: draft.senderName,
        username: draft.username,
        password: draft.password,
        smtp: {
          host: draft.smtpHost,
          port: Number(draft.smtpPort),
          security: draft.smtpSecurity,
        },
        imap: {
          host: draft.imapHost,
          port: Number(draft.imapPort),
          security: draft.imapSecurity,
        },
      },
    });
    const created = await json<{ id: string }>(res);
    mailId = created.id;
  }

  return {
    features: httpFeatures,

    async loadOrganisation(signal) {
      const r = await organisation(signal);
      return {
        data: toOrg(r),
        logo: r.logo,
        creditAccounts: [],
      };
    },

    async saveOrganisation(data) {
      const current = raw ?? (await organisation());
      const before = toOrg(current);
      const changed = (keys: (keyof OrgData)[]) => keys.some((k) => before[k] !== data[k]);
      const next = structuredClone(current);

      if (
        changed(["name", "street", "zip", "city", "phone", "email", "website", "vatNumber", "uid"])
      ) {
        next.master = {
          ...current.master,
          name: data.name,
          street: data.street,
          zip: data.zip,
          city: data.city,
          phone: data.phone,
          email: data.email,
          website: withScheme(data.website),
          vatNumber: data.vatNumber,
          uid: data.uid,
        };
        await putSection("master", next.master);
      }
      if (changed(["senderName", "replyTo", "footer"])) {
        next.sender = {
          ...current.sender,
          name: data.senderName,
          replyTo: data.replyTo,
          footer: data.footer,
        };
        await putSection("sender", next.sender);
      }
      if (changed(["bankName", "qrIban"])) {
        next.bank = { ...current.bank, bankName: data.bankName, qrIban: data.qrIban };
        await putSection("bank", next.bank);
      }
      if (changed(["fiscalStart"])) {
        next["fiscal-year"] = { startMonth: Number(data.fiscalStart.slice(3, 5)) };
        await putSection("fiscal-year", next["fiscal-year"]);
      }
      const modules = {
        sammelrechnung: data.sammelrechnung,
        mail: data.mail,
        kalender: data.kalender,
      };
      if (!same(modules, current.modules)) {
        next.modules = modules;
        await putSection("modules", modules);
      }
      raw = next;
    },

    logoUrl: (version) => `/settings/organisation/logo?v=${encodeURIComponent(version)}`,

    async uploadLogo(file) {
      await request("PUT", "/settings/organisation/logo", {
        body: await file.arrayBuffer(),
        contentType: file.type,
      });
    },

    async removeLogo() {
      await request("DELETE", "/settings/organisation/logo");
    },

    async loadMail(signal): Promise<MailState> {
      const res = await request("GET", "/mail/accounts", signal ? { signal } : {});
      const list = await json<Record<string, unknown>[]>(res);
      const first = list[0];
      if (!first) {
        mailId = null;
        return { draft: emptyMail(), stored: false };
      }
      mailId = String(first["id"]);
      return { draft: toMail(first), stored: true };
    },

    saveMail,

    async testMail(draft, { signal, onStage }): Promise<TestOutcome> {
      onStage(0);
      let persisted = false;
      // Die API prüft nur gespeicherte Konten: Neue oder geänderte Angaben werden dafür gespeichert.
      if (draft.password) {
        await saveMail(draft);
        persisted = true;
      }
      if (!mailId) throw new ApiError(409, "NO_ACCOUNT");
      const res = await request("POST", `/mail/accounts/${encodeURIComponent(mailId)}/verify`, {
        signal,
      });
      const { stages, failedAt } = stagesOf(await json<VerifyResult>(res));
      if (failedAt !== undefined) return { stages, failedAt, persisted };
      onStage(5);
      try {
        await request("POST", "/mail/test-send", {
          signal,
          json: {
            accountId: mailId,
            subject: "Testmail Stammbuch",
            bodyHtml: "<p>Die Verbindung zu Ihrem Mailkonto funktioniert.</p>",
          },
        });
        stages[5] = { status: "ok" };
        return { stages, sentAt: new Date(), persisted };
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") throw e;
        stages[5] = { status: "failed" };
        return { stages, failedAt: 5, persisted };
      }
    },

    async listUsers(signal) {
      const res = await request("GET", "/settings/users", signal ? { signal } : {});
      const body = await json<{ items: UserResponse[] }>(res);
      return body.items.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        status: u.status,
        lastLogin: null,
      }));
    },

    async addUser(name, email) {
      // Es gibt kein Rollenkonzept: Wer Zugriff hat, hat Vollzugriff (Board 9.9). Die API verlangt eine Rolle.
      await request("POST", "/settings/users", { json: { name, email, role: "admin" } });
    },

    async removeUser(id) {
      await request("DELETE", `/settings/users/${encodeURIComponent(id)}`);
    },

    async loadSecurity() {
      return { passwordChangedAt: null, totpSince: null, recoveryLeft: null, recoveryTotal: null };
    },

    async changePassword(current, next) {
      try {
        await request("POST", "/auth/password", {
          json: { currentPassword: current, newPassword: next },
        });
      } catch (e) {
        if (e instanceof ApiError && e.code === "INVALID_CREDENTIALS") return "wrong";
        if (e instanceof ApiError && e.code === "WEAK_PASSWORD") return "weak";
        throw e;
      }
      // Die API stellt eine neue Sitzung aus; das alte CSRF-Token gilt nicht mehr.
      await refreshSession?.();
      return "ok";
    },

    async renewRecoveryCodes(code) {
      try {
        const res = await request("POST", "/auth/recovery-codes/renew", { json: { code } });
        const body = await json<{ recoveryCodes: string[] }>(res);
        return body.recoveryCodes;
      } catch (e) {
        if (e instanceof ApiError && e.code === "INVALID_CODE") return null;
        throw e;
      }
    },

    beginTotpRenewal: () => Promise.reject(new Error("Von der API nicht unterstützt")),
    confirmTotpRenewal: () => Promise.reject(new Error("Von der API nicht unterstützt")),

    async queryAudit(query, signal) {
      const res = await request(
        "GET",
        `/settings/audit?${auditParams(query)}`,
        signal ? { signal } : {},
      );
      const body = await json<{ items: AuditEntryResponse[]; total: number }>(res);
      return {
        total: body.total,
        items: body.items.map((e) => ({
          id: e.id,
          at: e.at,
          actor: e.actor,
          action: e.action,
          target: e.target,
          result: "ok" as const,
        })),
      };
    },

    async exportAudit(query) {
      const res = await request("GET", `/settings/audit/export?${auditParams(query)}`);
      return {
        blob: await res.blob(),
        filename:
          /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ??
          "protokoll.csv",
        truncated: res.headers.get("x-export-truncated") === "true",
      };
    },

    async loadLicence(signal) {
      const res = await request("GET", "/settings/licence", signal ? { signal } : {});
      const body = await json<LicenceResponse>(res);
      const [org, users] = await Promise.all([
        organisation(signal).catch(() => null),
        request("GET", "/settings/users", signal ? { signal } : {})
          .then((r) => json<{ items: unknown[] }>(r))
          .catch(() => null),
      ]);
      return {
        state: body.state,
        validUntil: body.validUntil.slice(0, 10),
        ...(org && { licensee: org.master.name }),
        ...(users && { users: users.items.length }),
        providerEmail: supportEmail,
      };
    },
  };
}

function auditParams(query: object): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query) as [string, unknown][]) {
    if (v !== undefined && v !== "") p.set(k, String(v));
  }
  return p.toString();
}
