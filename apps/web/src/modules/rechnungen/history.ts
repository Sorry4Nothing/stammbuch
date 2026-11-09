import { amount, daysBetween, type DunningLevel, type Invoice, type Reminder } from "./model";
import type { HistoryEntry } from "./service";

/**
 * Verlauf einer Rechnung aus den Daten, die die API liefert (Anlage, Versand, Zahlungen, Mahnungen,
 * Gutschriften). Wer es ausgelöst hat, nennt die API nicht; Buchungsnummern liefert sie hier nicht mit.
 */
export function buildHistory(args: {
  invoice: Invoice;
  reminders: readonly Reminder[];
  creditNotes: readonly Invoice[];
  dueLevel: DunningLevel | undefined;
  today: string;
}): HistoryEntry[] {
  const { invoice: inv, reminders, creditNotes, dueLevel, today } = args;
  const out: HistoryEntry[] = [{ id: "created", at: inv.createdAt, kind: "created", params: {} }];
  if (inv.sentAt) out.push({ id: "sent", at: inv.sentAt, kind: "sent", params: {} });
  for (const p of inv.payments) {
    out.push({
      id: `p-${p.id}`,
      at: p.recordedAt,
      kind: p.amountCents < 0 ? "refund" : "payment",
      params: { amount: amount(Math.abs(p.amountCents)), date: p.paidOn },
    });
  }
  for (const r of reminders) {
    out.push({
      id: `r-${r.id}`,
      at: r.createdAt,
      kind: "reminder",
      params: { title: r.title, level: r.level },
    });
  }
  for (const c of creditNotes) {
    out.push({
      id: `c-${c.id}`,
      at: c.sentAt ?? c.createdAt,
      kind: "credit",
      params: { number: c.number ?? "", amount: amount(-c.totals.totalCents) },
    });
  }
  if (dueLevel) {
    out.push({
      id: "due",
      at: `${today}T00:00:00`,
      dateOnly: true,
      kind: "due",
      params: { title: dueLevel.title, days: daysBetween(inv.dueDate, today) },
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
