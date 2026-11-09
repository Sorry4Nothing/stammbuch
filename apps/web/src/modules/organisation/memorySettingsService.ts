import type { TotpSetup } from "../../auth/auth";
import {
  ApiError,
  TEST_STAGE_COUNT,
  type AuditEntry,
  type Features,
  type Licence,
  type LogoInfo,
  type MailDraft,
  type MailState,
  type OrgData,
  type SecurityInfo,
  type SettingsUser,
  type TestOutcome,
  type TestStage,
} from "./model";
import type { SettingsService } from "./service";

/** Alle Möglichkeiten eingeschaltet: so zeigen die Boards die Seiten. */
export const allFeatures: Features = {
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

export interface MemorySeed {
  features?: Features;
  org?: OrgData;
  logo?: LogoInfo | null;
  mail?: MailState;
  users?: SettingsUser[];
  security?: SecurityInfo;
  audit?: AuditEntry[];
  /** Gemeldete Gesamtzahl ohne Filter (das Board zeigt «14 von 2'418»). */
  auditTotal?: number;
  licence?: Licence;
  /** Ergebnis von `testMail`: gelungen oder bei dieser Stufe (0 bis 5) gescheitert. */
  mailTest?: "ok" | { failAt: number };
  /** `testMail` endet erst, wenn `signal` abbricht. */
  mailTestHangs?: boolean;
  /** Gültiger Einmalcode für Wiederherstellungscodes und Einrichtung. */
  validCode?: string;
  recoveryCodes?: string[];
}

export const memoryTestStages = (failAt?: number): TestStage[] =>
  Array.from({ length: TEST_STAGE_COUNT }, (_, i) => ({
    status: failAt === undefined || i < failAt ? "ok" : i === failAt ? "failed" : "skipped",
  }));

/** In-Memory-Dienst für Tests und Entwicklung. `state` zeigt, was die Oberfläche gespeichert hat. */
export function memorySettingsService(seed: MemorySeed = {}) {
  const state = {
    org: structuredClone(seed.org ?? ({} as OrgData)),
    logo: seed.logo ?? null,
    mail: structuredClone(seed.mail ?? ({} as MailState)),
    users: structuredClone(seed.users ?? []),
    removed: [] as string[],
    added: [] as { name: string; email: string }[],
    exported: 0,
    password: null as { current: string; next: string } | null,
    logoUploads: [] as string[],
    totpConfirmed: false,
  };
  const validCode = seed.validCode ?? "482916";
  const audit = seed.audit ?? [];

  const service: SettingsService = {
    features: seed.features ?? allFeatures,

    loadOrganisation: async () => ({
      data: structuredClone(state.org),
      logo: state.logo,
      creditAccounts: [{ value: "1020", label: "1020 Bank Zahlungsverkehr" }],
    }),
    async saveOrganisation(data) {
      state.org = structuredClone(data);
    },
    logoUrl: (version) => `/logo?v=${version}`,
    async uploadLogo(file) {
      state.logoUploads.push(file.name);
      state.logo = { mime: file.type, size: file.size, updatedAt: String(Date.now()) };
    },
    async removeLogo() {
      state.logo = null;
    },

    loadMail: async () => structuredClone(state.mail),
    async saveMail(draft: MailDraft) {
      state.mail = { draft: { ...draft, password: "" }, stored: true };
    },
    async testMail(draft, { signal, onStage }): Promise<TestOutcome> {
      onStage(0);
      if (seed.mailTestHangs) {
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new DOMException("", "AbortError"))),
        );
      }
      const plan = seed.mailTest ?? "ok";
      const failAt = plan === "ok" ? undefined : plan.failAt;
      const stages = memoryTestStages(failAt);
      const persisted = Boolean(draft.password);
      if (persisted) state.mail = { draft: { ...draft, password: "" }, stored: true };
      if (failAt !== undefined) return { stages, failedAt: failAt, persisted };
      stages.forEach((s, i) => (s.ms = [200, 400, 1100, 300, 900, 2600][i]!));
      return { stages, sentAt: new Date(2026, 10, 2, 14, 41), persisted };
    },

    listUsers: async () => structuredClone(state.users),
    async addUser(name, email) {
      state.added.push({ name, email });
      state.users.push({
        id: `u${state.users.length + 1}`,
        name,
        email,
        status: "invited",
        lastLogin: null,
      });
    },
    async removeUser(id) {
      state.removed.push(id);
      state.users = state.users.filter((u) => u.id !== id);
    },
    loadSecurity: async () =>
      seed.security ?? {
        passwordChangedAt: null,
        totpSince: null,
        recoveryLeft: null,
        recoveryTotal: null,
      },
    async changePassword(current, next) {
      if (current !== "Altes-Passwort-1234") return "wrong";
      if (next.length < 12) return "weak";
      state.password = { current, next };
      return "ok";
    },
    async renewRecoveryCodes(code) {
      return code === validCode ? (seed.recoveryCodes ?? []) : null;
    },
    async beginTotpRenewal(currentCode): Promise<TotpSetup | null> {
      if (currentCode !== validCode) return null;
      return {
        secret: "DEMO5Q2K7XM4TEST",
        otpauthUri: "otpauth://totp/Stammbuch:demo?secret=DEMO5Q2K7XM4TEST&issuer=Stammbuch",
      };
    },
    async confirmTotpRenewal(code) {
      state.totpConfirmed = code === validCode;
      return state.totpConfirmed;
    },

    async queryAudit(query) {
      const rows = audit.filter(
        (e) =>
          (!query.from || e.at >= query.from) &&
          (!query.actor || e.actor === query.actor) &&
          (!query.action || e.action === query.action) &&
          (!query.q || `${e.action} ${e.target}`.toLowerCase().includes(query.q.toLowerCase())),
      );
      const unfiltered = !query.actor && !query.action && !query.q;
      return {
        items: rows.slice(query.offset, query.offset + query.limit),
        total: unfiltered && seed.auditTotal ? seed.auditTotal : rows.length,
      };
    },
    async exportAudit() {
      state.exported += 1;
      return {
        blob: new Blob(["Zeitpunkt;Benutzer;Aktion;Objekt\n"]),
        filename: "protokoll.xlsx",
        truncated: false,
      };
    },

    async loadLicence() {
      if (!seed.licence) throw new ApiError(404, "NOT_FOUND");
      return seed.licence;
    },
  };
  return Object.assign(service, { state });
}
