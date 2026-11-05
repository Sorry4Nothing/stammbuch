import { BillingError, type Invoice } from "./domain.js";
import { type Cents, addDays, daysBetween } from "./money.js";

export interface DunningLevel {
  level: number;
  title: string;
  /** Tage ab Fälligkeit (Stufe 1) bzw. ab Ablauf der vorherigen Zahlungsfrist, bevor die Stufe fällig wird. */
  waitDays: number;
  /** Zahlungsfrist der Mahnung in Tagen. */
  graceDays: number;
  feeCents: Cents;
}

export interface DunningConfig {
  levels: DunningLevel[];
}

export const DEFAULT_DUNNING: DunningConfig = {
  levels: [
    { level: 1, title: "Zahlungserinnerung", waitDays: 10, graceDays: 10, feeCents: 0 },
    { level: 2, title: "1. Mahnung", waitDays: 0, graceDays: 10, feeCents: 2000 },
    { level: 3, title: "Letzte Mahnung", waitDays: 0, graceDays: 5, feeCents: 3000 },
  ],
};

/** Gespeicherte Mahnung; unveränderlich, die Gebühr gilt für die Mahnung, nicht für die Rechnung. */
export interface Reminder {
  id: string;
  tenantId: string;
  invoiceId: string;
  level: number;
  title: string;
  issuedOn: string;
  dueOn: string;
  /** Gebühr dieser Stufe. */
  feeCents: Cents;
  /** Offener Rechnungsbetrag zum Zeitpunkt der Mahnung. */
  openCents: Cents;
  /** Zu zahlen: offener Betrag plus alle Gebühren bis einschliesslich dieser Stufe. */
  totalCents: Cents;
  createdAt: string;
}

export function validateDunningConfig(c: DunningConfig): void {
  c.levels.forEach((l, idx) => {
    if (l.level !== idx + 1)
      throw new BillingError(422, "Mahnstufen müssen lückenlos ab 1 nummeriert sein.");
  });
}

/**
 * Nächste fällige Mahnstufe oder null. Gemahnt wird nur eine versendete, nicht vollständig bezahlte
 * Rechnung (kein Entwurf, keine Gutschrift) und nur in der Reihenfolge der Stufen.
 */
export function nextDueLevel(
  invoice: Invoice,
  open: Cents,
  existing: Reminder[],
  config: DunningConfig,
  asOf: string,
): DunningLevel | null {
  if (invoice.kind !== "invoice" || invoice.status !== "sent" || open <= 0) return null;
  const last = existing.reduce<Reminder | null>((m, r) => (m && m.level >= r.level ? m : r), null);
  const next = config.levels[last ? last.level : 0];
  if (!next) return null;
  const from = last ? last.dueOn : invoice.dueDate;
  return asOf > from && daysBetween(from, asOf) >= next.waitDays ? next : null;
}

export function buildReminder(
  invoice: Invoice,
  open: Cents,
  existing: Reminder[],
  level: DunningLevel,
  asOf: string,
  id: string,
  now: string,
): Reminder {
  const priorFees = existing.reduce((s, r) => s + r.feeCents, 0);
  return {
    id,
    tenantId: invoice.tenantId,
    invoiceId: invoice.id,
    level: level.level,
    title: level.title,
    issuedOn: asOf,
    dueOn: addDays(asOf, level.graceDays),
    feeCents: level.feeCents,
    openCents: open,
    totalCents: open + priorFees + level.feeCents,
    createdAt: now,
  };
}
