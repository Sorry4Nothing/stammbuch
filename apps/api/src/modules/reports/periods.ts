import { createHash } from "node:crypto";
import type { JournalLine, LedgerReadPort } from "./ledger-port.js";
import { isValidIsoDate } from "./money.js";
import {
  balanceSheetReport,
  debtorsReport,
  LedgerInconsistencyError,
  openItemsReport,
  trialBalanceReport,
} from "./reports.js";

/**
 * Periodenabschluss als Zustandsmaschine:
 *
 *   open --runCheck (ohne Fehler)--> checked --confirm--> closed
 *     ^                                 |
 *     +----- revokeCheck / Änderung ----+
 *
 * `closed` ist endgültig. Korrekturen erfolgen per Gegenbuchung in einer offenen Periode
 * (Unveränderbarkeit, Plan Abschnitt 3.5). Die Buchhaltung (#8) ruft vor jedem Festschreiben
 * `PeriodGuard.assertBookingAllowed(tenantId, buchungsdatum)` auf.
 */

export type PeriodState = "open" | "checked" | "closed";

export interface CheckIssue {
  code:
    | "UNKNOWN_ACCOUNT"
    | "BOOKING_UNBALANCED"
    | "TRIAL_BALANCE_UNBALANCED"
    | "BALANCE_SHEET_UNBALANCED"
    | "DEBTOR_CONTROL_MISMATCH"
    | "OVERPAID_ITEM";
  severity: "error" | "warning";
  message: string;
}

export interface PeriodTransition {
  at: string;
  actor: string;
  from: PeriodState;
  to: PeriodState;
}

export interface Period {
  id: string;
  label: string;
  from: string;
  to: string;
  state: PeriodState;
  /** Optimistische Sperre: steigt bei jeder Speicherung. */
  version: number;
  /** Ergebnis der letzten Prüfung. */
  issues: CheckIssue[];
  /** Hash der Buchungszeilen zum Zeitpunkt der erfolgreichen Prüfung. */
  checkFingerprint?: string;
  history: PeriodTransition[];
}

export type PeriodErrorCode =
  | "NOT_FOUND"
  | "INVALID_RANGE"
  | "OVERLAP"
  | "INVALID_STATE"
  | "CHECK_FAILED"
  | "STALE_CHECK"
  | "PREDECESSOR_OPEN"
  | "PERIOD_CLOSED"
  | "CONFLICT";

export class PeriodError extends Error {
  constructor(
    readonly code: PeriodErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface PeriodStore {
  list(tenantId: string): Promise<Period[]>;
  get(tenantId: string, id: string): Promise<Period | undefined>;
  /** Legt an (`expectedVersion` fehlt) oder ersetzt, wenn die gespeicherte Version stimmt. */
  save(tenantId: string, period: Period, expectedVersion?: number): Promise<void>;
}

export class InMemoryPeriodStore implements PeriodStore {
  private readonly data = new Map<string, Map<string, Period>>();

  list = async (t: string) =>
    [...(this.data.get(t)?.values() ?? [])]
      .map((p) => structuredClone(p))
      .sort((a, b) => a.from.localeCompare(b.from));

  get = async (t: string, id: string) => {
    const p = this.data.get(t)?.get(id);
    return p ? structuredClone(p) : undefined;
  };

  save = async (t: string, period: Period, expectedVersion?: number) => {
    const m = this.data.get(t) ?? new Map<string, Period>();
    const cur = m.get(period.id);
    if ((cur?.version ?? undefined) !== expectedVersion) {
      throw new PeriodError("CONFLICT", "Die Periode wurde zwischenzeitlich geändert.");
    }
    m.set(period.id, structuredClone(period));
    this.data.set(t, m);
  };
}

/** Von #8 vor jeder Buchung aufzurufen. Wirft `PeriodError("PERIOD_CLOSED")`. */
export interface PeriodGuard {
  assertBookingAllowed(tenantId: string, bookingDate: string): Promise<void>;
}

export function createPeriodGuard(store: PeriodStore): PeriodGuard {
  return {
    async assertBookingAllowed(tenantId, bookingDate) {
      if (!isValidIsoDate(bookingDate)) throw new PeriodError("INVALID_RANGE", "Ungültiges Datum.");
      const periods = await store.list(tenantId);
      if (
        periods.some((p) => p.state === "closed" && p.from <= bookingDate && bookingDate <= p.to)
      ) {
        throw new PeriodError("PERIOD_CLOSED", "Die Periode ist abgeschlossen.");
      }
    },
  };
}

export function fingerprint(lines: JournalLine[]): string {
  const h = createHash("sha256");
  for (const l of [...lines].sort((a, b) => a.id.localeCompare(b.id))) {
    h.update(`${l.id}|${l.bookingId}|${l.date}|${l.accountId}|${l.side}|${l.amountCents}\n`);
  }
  return h.digest("hex");
}

export interface PeriodServiceDeps {
  ledger: LedgerReadPort;
  store: PeriodStore;
  now?: () => Date;
  newId?: () => string;
}

export class PeriodService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: PeriodServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  list(tenantId: string) {
    return this.deps.store.list(tenantId);
  }

  async create(tenantId: string, input: { label: string; from: string; to: string }) {
    if (!isValidIsoDate(input.from) || !isValidIsoDate(input.to) || input.from > input.to) {
      throw new PeriodError("INVALID_RANGE", "Ungültiger Zeitraum.");
    }
    const existing = await this.deps.store.list(tenantId);
    if (existing.some((p) => p.from <= input.to && input.from <= p.to)) {
      throw new PeriodError("OVERLAP", "Der Zeitraum überschneidet sich mit einer Periode.");
    }
    const period: Period = {
      id: this.newId(),
      label: input.label,
      from: input.from,
      to: input.to,
      state: "open",
      version: 1,
      issues: [],
      history: [],
    };
    await this.deps.store.save(tenantId, period);
    return period;
  }

  /** Prüfung: bei Erfolg `checked`, sonst bleibt die Periode `open` mit Befunden. */
  async runCheck(tenantId: string, id: string, actor: string): Promise<Period> {
    const p = await this.load(tenantId, id);
    if (p.state === "closed") throw new PeriodError("INVALID_STATE", "Periode ist abgeschlossen.");
    const lines = (await this.deps.ledger.listJournalLines(tenantId, { to: p.to })).filter(
      (l) => l.date >= p.from,
    );
    const issues = await this.check(tenantId, p, lines);
    const ok = !issues.some((i) => i.severity === "error");
    const next: Period = { ...p, issues, version: p.version + 1 };
    if (ok) next.checkFingerprint = fingerprint(lines);
    else delete next.checkFingerprint;
    this.move(next, ok ? "checked" : "open", actor);
    await this.deps.store.save(tenantId, next, p.version);
    return next;
  }

  async revokeCheck(tenantId: string, id: string, actor: string): Promise<Period> {
    const p = await this.load(tenantId, id);
    if (p.state !== "checked") throw new PeriodError("INVALID_STATE", "Periode ist nicht geprüft.");
    const next: Period = { ...p, version: p.version + 1 };
    delete next.checkFingerprint;
    this.move(next, "open", actor);
    await this.deps.store.save(tenantId, next, p.version);
    return next;
  }

  /** Bestätigung: nur aus `checked`, nur wenn sich seit der Prüfung nichts geändert hat. */
  async confirm(tenantId: string, id: string, actor: string): Promise<Period> {
    const p = await this.load(tenantId, id);
    if (p.state !== "checked" || !p.checkFingerprint) {
      throw new PeriodError("INVALID_STATE", "Die Periode ist nicht geprüft.");
    }
    const all = await this.deps.store.list(tenantId);
    if (all.some((o) => o.to < p.from && o.state !== "closed")) {
      throw new PeriodError("PREDECESSOR_OPEN", "Frühere Perioden sind noch nicht abgeschlossen.");
    }
    const lines = (await this.deps.ledger.listJournalLines(tenantId, { to: p.to })).filter(
      (l) => l.date >= p.from,
    );
    const next: Period = { ...p, version: p.version + 1 };
    if (fingerprint(lines) !== p.checkFingerprint) {
      delete next.checkFingerprint;
      this.move(next, "open", actor);
      await this.deps.store.save(tenantId, next, p.version);
      throw new PeriodError("STALE_CHECK", "Seit der Prüfung wurde gebucht. Bitte neu prüfen.");
    }
    this.move(next, "closed", actor);
    await this.deps.store.save(tenantId, next, p.version);
    return next;
  }

  private async load(tenantId: string, id: string) {
    const p = await this.deps.store.get(tenantId, id);
    if (!p) throw new PeriodError("NOT_FOUND", "Periode nicht gefunden.");
    return p;
  }

  private move(p: Period, to: PeriodState, actor: string) {
    p.history = [...p.history, { at: this.now().toISOString(), actor, from: p.state, to }];
    p.state = to;
  }

  private async check(tenantId: string, p: Period, lines: JournalLine[]): Promise<CheckIssue[]> {
    const issues: CheckIssue[] = [];
    const sums = new Map<string, number>();
    for (const l of lines) {
      sums.set(
        l.bookingId,
        (sums.get(l.bookingId) ?? 0) + (l.side === "debit" ? 1 : -1) * l.amountCents,
      );
    }
    for (const [bookingId, diff] of sums) {
      if (diff !== 0) {
        issues.push({
          code: "BOOKING_UNBALANCED",
          severity: "error",
          message: `Buchung ${bookingId}: Soll und Haben weichen um ${diff} Rappen ab.`,
        });
      }
    }
    try {
      const l = this.deps.ledger;
      const [tb, bs, debtors, items] = await Promise.all([
        trialBalanceReport(l, tenantId, { from: p.from, to: p.to }),
        balanceSheetReport(l, tenantId, { asOf: p.to }),
        debtorsReport(l, tenantId, { asOf: p.to }),
        openItemsReport(l, tenantId, { asOf: p.to }),
      ]);
      if (!tb.totals.balanced) {
        issues.push({
          code: "TRIAL_BALANCE_UNBALANCED",
          severity: "error",
          message: "Die Saldenliste geht nicht auf.",
        });
      }
      if (!bs.totals.balanced) {
        issues.push({
          code: "BALANCE_SHEET_UNBALANCED",
          severity: "error",
          message: `Die Bilanz geht nicht auf (Differenz ${bs.totals.differenceCents} Rappen).`,
        });
      }
      if (debtors.totals.differenceCents !== 0) {
        issues.push({
          code: "DEBTOR_CONTROL_MISMATCH",
          severity: "error",
          message: `Debitorenkonto und offene Posten weichen um ${debtors.totals.differenceCents} Rappen ab.`,
        });
      }
      for (const r of items.rows) {
        if (r.amountCents > 0 && r.openCents < 0) {
          issues.push({
            code: "OVERPAID_ITEM",
            severity: "warning",
            message: `Rechnung ${r.reference} ist überzahlt.`,
          });
        }
      }
    } catch (e) {
      if (!(e instanceof LedgerInconsistencyError)) throw e;
      issues.push({
        code: "UNKNOWN_ACCOUNT",
        severity: "error",
        message: "Eine Buchung verweist auf ein unbekanntes Konto.",
      });
    }
    return issues;
  }
}
