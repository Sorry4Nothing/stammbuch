import type {
  AuditEntryResponse,
  LicenceResponse,
  OrganisationResponse,
  SecurityInfoResponse,
  UserResponse,
} from "@stammbuch/shared";
import { supportEmail } from "../../config";
import { formatDateTime } from "./common";
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

/**
 * Alles, was die Oberfläche zeigt, liefert die API (Issue #114 und #130). Rechtsform, Konto «Gutschriften auf» und
 * Periodenabschluss stehen im Organisationsdokument, die Zahlungsfrist ist `paymentTermDays` der Rechnungseinstellungen.
 */
export const httpFeatures: Features = {
  legalForm: true,
  accountHolder: true,
  creditAccount: true,
  paymentDays: true,
  closing: true,
  lastLogin: true,
  securityInfo: true,
  totpRenewal: true,
  licenceDetails: true,
  auditResult: true,
  auditXlsx: true,
};

/** Zahlungsfrist, solange die Rechnungseinstellungen noch nicht erfasst sind (Standard der API). */
const DEFAULT_PAYMENT_DAYS = "30";

/** Fehlercodes mit Status 401, die einen falschen Code bzw. ein falsches Passwort meinen, nicht eine beendete Sitzung. */
const WRONG_SECRET = new Set(["INVALID_CODE", "INVALID_CREDENTIALS"]);

/** Kalendertag in Zürich als «JJJJ-MM-TT». */
const zurichDay = (iso: string) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(new Date(iso));

/** Konto des Kontenplans (`GET /accounting/accounts`). */
interface AccountDto {
  code: string;
  name: string;
  type: string;
  active: boolean;
}

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

/** Körper für «Konto speichern» und «Konto prüfen» (dieselben Felder, dieselbe Prüfung in der API). */
const accountBody = (draft: MailDraft) => ({
  label: draft.senderName || draft.email,
  fromAddress: draft.email,
  fromName: draft.senderName,
  username: draft.username,
  password: draft.password,
  smtp: { host: draft.smtpHost, port: Number(draft.smtpPort), security: draft.smtpSecurity },
  imap: { host: draft.imapHost, port: Number(draft.imapPort), security: draft.imapSecurity },
});

const TEST_MAIL = {
  subject: "Testmail Stammbuch",
  bodyHtml: "<p>Die Verbindung zu Ihrem Mailkonto funktioniert.</p>",
};

const withScheme = (url: string) => (url && !/^https?:\/\//i.test(url) ? `https://${url}` : url);

export function createHttpSettingsService({
  csrfToken,
  onUnauthorized,
  refreshSession,
  fetchFn = (...args) => fetch(...args),
}: Options): SettingsService {
  /** Zuletzt geladener Stand der Organisation: Felder, die die Oberfläche nicht kennt, gehen so nicht verloren. */
  let raw: OrganisationResponse | null = null;
  /** Zahlungsfrist der Rechnungseinstellungen, wie zuletzt geladen oder gespeichert. */
  let paymentDays = DEFAULT_PAYMENT_DAYS;
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
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      const error = isRecord(body) ? body["error"] : undefined;
      const code = isRecord(error) && typeof error["code"] === "string" ? error["code"] : "ERROR";
      // Ein falscher Code oder ein falsches Passwort ist keine abgelaufene Sitzung.
      if (res.status === 401 && !WRONG_SECRET.has(code)) onUnauthorized();
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
      legalForm: r.master.legalForm,
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
      accountHolder: r.bank.accountHolder,
      bankName: r.bank.bankName,
      qrIban: r.bank.qrIban,
      creditAccount: r.bank.creditAccount,
      paymentDays,
      fiscalStart: fiscal.start,
      fiscalEnd: fiscal.end,
      closing: r["fiscal-year"].closing,
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
    const res = await request("POST", "/mail/accounts", { json: accountBody(draft) });
    const created = await json<{ id: string }>(res);
    mailId = created.id;
  }

  return {
    features: httpFeatures,

    async loadOrganisation(signal) {
      const opts = signal ? { signal } : {};
      // Konten und Zahlungsfrist liegen in anderen Modulen. Fehlen sie, bleibt die Organisation trotzdem lesbar.
      const [r, accounts, billing] = await Promise.all([
        organisation(signal),
        request("GET", "/accounting/accounts", opts)
          .then((res) => json<AccountDto[]>(res))
          .catch(() => []),
        request("GET", "/invoices/settings", opts)
          .then((res) => json<{ paymentTermDays?: unknown }>(res))
          .catch(() => null),
      ]);
      paymentDays =
        typeof billing?.paymentTermDays === "number"
          ? String(billing.paymentTermDays)
          : DEFAULT_PAYMENT_DAYS;
      // Nur aktive Bestandskonten (Bank, Kasse, Post) kommen als Ziel der Gutschriften in Frage.
      const options = accounts
        .filter((a) => a.type === "asset" && a.active)
        .map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }));
      const stored = r.bank.creditAccount;
      if (stored && !options.some((o) => o.value === stored)) {
        options.unshift({ value: stored, label: stored });
      }
      return { data: toOrg(r), logo: r.logo, creditAccounts: options };
    },

    async saveOrganisation(data) {
      const current = raw ?? (await organisation());
      const before = toOrg(current);
      const changed = (keys: (keyof OrgData)[]) => keys.some((k) => before[k] !== data[k]);
      const next = structuredClone(current);

      if (
        changed([
          "name",
          "legalForm",
          "street",
          "zip",
          "city",
          "phone",
          "email",
          "website",
          "vatNumber",
          "uid",
        ])
      ) {
        next.master = {
          ...current.master,
          name: data.name,
          legalForm: data.legalForm as OrganisationResponse["master"]["legalForm"],
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
      if (changed(["accountHolder", "bankName", "qrIban", "creditAccount"])) {
        next.bank = {
          ...current.bank,
          accountHolder: data.accountHolder,
          bankName: data.bankName,
          qrIban: data.qrIban,
          creditAccount: data.creditAccount,
        };
        await putSection("bank", next.bank);
      }
      if (changed(["fiscalStart", "closing"])) {
        next["fiscal-year"] = {
          startMonth: Number(data.fiscalStart.slice(3, 5)),
          closing: data.closing,
        };
        await putSection("fiscal-year", next["fiscal-year"]);
      }
      if (changed(["paymentDays"])) {
        // Dasselbe Feld wie in den Rechnungseinstellungen, nicht ein zweites daneben.
        await request("PUT", "/invoices/settings/payment-term", {
          json: { paymentTermDays: Number(data.paymentDays) },
        });
        paymentDays = String(Number(data.paymentDays));
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
      let res: Response;
      try {
        res = await request("GET", "/mail/accounts", signal ? { signal } : {});
      } catch (e) {
        // Ohne Schlüssel für Mailkonten registriert der Server das Mail-Modul nicht.
        if (e instanceof ApiError && (e.status === 404 || e.status === 503)) {
          mailId = null;
          return { draft: emptyMail(), stored: false, unavailable: true };
        }
        throw e;
      }
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
      // Neue oder geänderte Angaben (mit Passwort) werden geprüft, ohne sie zu speichern.
      if (draft.password) {
        const res = await request("POST", "/mail/accounts/verify", {
          signal,
          json: { ...accountBody(draft), testMail: TEST_MAIL },
        });
        const result = await json<VerifyResult & { testMail: Reason | null }>(res);
        const { stages, failedAt } = stagesOf(result);
        if (failedAt !== undefined) return { stages, failedAt, persisted: false };
        const sent = result.testMail === "ok";
        stages[5] = { status: sent ? "ok" : "failed" };
        return sent
          ? { stages, sentAt: new Date(), persisted: false }
          : { stages, failedAt: 5, persisted: false };
      }
      // Ohne neues Passwort gilt das gespeicherte Konto.
      if (!mailId) throw new ApiError(409, "NO_ACCOUNT");
      const res = await request("POST", `/mail/accounts/${encodeURIComponent(mailId)}/verify`, {
        signal,
      });
      const { stages, failedAt } = stagesOf(await json<VerifyResult>(res));
      if (failedAt !== undefined) return { stages, failedAt, persisted: false };
      onStage(5);
      try {
        await request("POST", "/mail/test-send", {
          signal,
          json: { accountId: mailId, ...TEST_MAIL },
        });
        stages[5] = { status: "ok" };
        return { stages, sentAt: new Date(), persisted: false };
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") throw e;
        stages[5] = { status: "failed" };
        return { stages, failedAt: 5, persisted: false };
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
        lastLogin: u.lastLoginAt ? formatDateTime(u.lastLoginAt) : null,
        totpEnrolled: u.totpEnrolled,
      }));
    },

    async addUser(name, email) {
      // Es gibt kein Rollenkonzept: Wer Zugriff hat, hat Vollzugriff (Board 9.9). Die API verlangt eine Rolle.
      await request("POST", "/settings/users", { json: { name, email, role: "admin" } });
    },

    async removeUser(id) {
      await request("DELETE", `/settings/users/${encodeURIComponent(id)}`);
    },

    async loadSecurity(signal) {
      const res = await request("GET", "/auth/security", signal ? { signal } : {});
      const body = await json<SecurityInfoResponse>(res);
      return {
        passwordChangedAt: body.passwordChangedAt && zurichDay(body.passwordChangedAt),
        totpSince: body.totpSince && zurichDay(body.totpSince),
        recoveryLeft: body.recoveryLeft,
        recoveryTotal: body.recoveryTotal,
        device: body.device ?? null,
      };
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

    async beginTotpRenewal(currentCode) {
      try {
        const res = await request("POST", "/auth/2fa/renew", { json: { code: currentCode } });
        const body = await json<{ secret: string; otpauthUri: string }>(res);
        return { secret: body.secret, otpauthUri: body.otpauthUri };
      } catch (e) {
        if (e instanceof ApiError && e.code === "INVALID_CODE") return null;
        throw e;
      }
    },

    async confirmTotpRenewal(code) {
      try {
        await request("POST", "/auth/2fa/renew/confirm", { json: { code } });
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.code === "INVALID_CODE") return false;
        throw e;
      }
    },

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
          result: e.result === "failure" ? ("failed" as const) : ("ok" as const),
        })),
      };
    },

    async exportAudit(query) {
      const res = await request(
        "GET",
        `/settings/audit/export?${auditParams({ ...query, format: "xlsx" })}`,
      );
      return {
        blob: await res.blob(),
        filename:
          /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ??
          "protokoll.xlsx",
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
        customerId: body.customerId,
        ...(body.licenceNumber && { licenceNo: body.licenceNumber }),
        ...(body.licenceStart && { validFrom: body.licenceStart.slice(0, 10) }),
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
