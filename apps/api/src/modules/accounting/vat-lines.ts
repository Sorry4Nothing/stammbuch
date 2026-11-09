import type { AccountType, VatTransaction } from "../reports/ledger-port.js";
import { VAT_INPUT_ACCOUNT, VAT_OUTPUT_ACCOUNT } from "../reports/ledger-port.js";
import { applyRateBp } from "../reports/money.js";

/** Konto der Mitgliederbeiträge und Konto für Mahngebühren der Standard-Vorlage (nur für die Umsatzüberleitung). */
const CONTRIBUTIONS_ACCOUNT = "3000";
const DUNNING_FEES_ACCOUNT = "3600";
// Steuersätze in Basispunkte (Normal-, Sonder-, reduzierter Satz). Dient nur dazu, den Satz einer Buchung ohne
// Steuersatz am Konto zu erkennen.
const KNOWN_RATES_BP = [810, 380, 260];

/** Eine Buchungszeile mit allem, was die MwSt-Auswertung braucht. */
export interface VatLine {
  bookingId: string;
  date: string;
  /** Art der Buchung (`credit_note`, `invoice`, …). */
  bookingKind: string;
  account: string;
  accountType: AccountType;
  side: "debit" | "credit";
  cents: number;
  /** Satz der Zeile (Basispunkte), `null` bei Bestandszeilen und Konten ohne Satz. */
  rateBp: number | null;
}

function rateOf(netCents: number, taxCents: number): number {
  if (taxCents === 0 || netCents === 0) return 0;
  const known = KNOWN_RATES_BP.find((bp) => applyRateBp(netCents, bp) === taxCents);
  // Verhältnis als Fliesskomma, nur zur Anzeige des Satzes; die Beträge selbst bleiben ganzzahlig.
  return known ?? Math.round((taxCents / netCents) * 10_000);
}

interface Side {
  net: number;
  tax: number;
  account?: string;
}

/**
 * Leitet aus den Zeilen (sortiert nach Datum und Belegnummer) Umsatz und Vorsteuer je Buchung ab.
 *
 * Zeilen mit Satz (das Konto trug beim Buchen einen): Erlöszeilen sind der Umsatz, Zeilen auf Passivkonten (Steuer
 * geschuldet) die Steuer, Aufwandzeilen die Vorsteuerbasis, Zeilen auf Aktivkonten die Vorsteuer, je zu ihrem Satz.
 * Zeilen ohne Satz folgen der früheren Regel: Steuer = Saldo auf 2200 bzw. 1170, Netto = Erlös- bzw. Aufwandzeilen
 * derselben Buchung, Satz = bekannter Satz, der die Steuer exakt ergibt, sonst der berechnete. Hat die Buchung genau
 * einen Satz auf Erlöszeilen (bzw. Aufwandzeilen), gehört die Steuer auf 2200 (bzw. 1170) zu diesem Satz.
 * shortcut: Buchung mit mehreren Sätzen ohne Satz am Steuerkonto erscheint mit Mischsatz.
 * Erlösbuchungen ohne Steuerzeile zählen als Umsatz zu 0 %, mit Herkunft (Gutschrift, Beiträge, Mahngebühren).
 */
export function vatTransactionsOf(lines: readonly VatLine[]): VatTransaction[] {
  const byBooking = new Map<string, VatLine[]>();
  for (const l of lines) byBooking.set(l.bookingId, [...(byBooking.get(l.bookingId) ?? []), l]);

  const out: VatTransaction[] = [];
  for (const [bookingId, ls] of byBooking) {
    const date = ls[0]!.date;
    const bookingKind = ls[0]!.bookingKind;
    const haben = (l: VatLine) => (l.side === "credit" ? l.cents : -l.cents);
    const sum = (list: VatLine[], f: (l: VatLine) => boolean) =>
      list.filter(f).reduce((s, l) => s + haben(l), 0);
    const push = (
      kind: VatTransaction["kind"],
      rateBp: number,
      netCents: number,
      taxCents: number,
      extra: Partial<Pick<VatTransaction, "account" | "origin">> = {},
    ) => {
      if (netCents === 0 && taxCents === 0) return;
      out.push({ bookingId, date, kind, rateBp, netCents, taxCents, ...extra });
    };

    const rated = ls.filter((l) => l.rateBp !== null);
    const legacy = ls.filter((l) => l.rateBp === null);

    // Zeilen mit Satz, je Satz.
    const output = new Map<number, Side>();
    const input = new Map<number, Side>();
    const slot = (m: Map<number, Side>, rate: number) => {
      const s = m.get(rate) ?? { net: 0, tax: 0 };
      m.set(rate, s);
      return s;
    };
    for (const l of rated) {
      const rate = l.rateBp!;
      if (l.accountType === "revenue") slot(output, rate).net += haben(l);
      else if (l.accountType === "liability") {
        const s = slot(output, rate);
        s.tax += haben(l);
        if (s.account === undefined || l.account < s.account) s.account = l.account;
      } else if (l.accountType === "expense") slot(input, rate).net += -haben(l);
      else if (l.accountType === "asset") {
        const s = slot(input, rate);
        s.tax += -haben(l);
        if (s.account === undefined || l.account < s.account) s.account = l.account;
      }
    }

    // Zeilen ohne Satz auf den Steuerkonten des Bestands.
    let hasOutput = legacy.some((l) => l.account === VAT_OUTPUT_ACCOUNT);
    let hasInput = legacy.some((l) => l.account === VAT_INPUT_ACCOUNT);
    let outputTax = sum(legacy, (l) => l.account === VAT_OUTPUT_ACCOUNT);
    let inputTax = -sum(legacy, (l) => l.account === VAT_INPUT_ACCOUNT);
    const only = (type: AccountType) => {
      const rates = new Set(rated.filter((l) => l.accountType === type).map((l) => l.rateBp!));
      return rates.size === 1 ? [...rates][0]! : undefined;
    };
    const outRate = only("revenue");
    if (hasOutput && outRate !== undefined) {
      const s = slot(output, outRate);
      s.tax += outputTax;
      s.account ??= VAT_OUTPUT_ACCOUNT;
      hasOutput = false;
      outputTax = 0;
    }
    const inRate = only("expense");
    if (hasInput && inRate !== undefined) {
      const s = slot(input, inRate);
      s.tax += inputTax;
      s.account ??= VAT_INPUT_ACCOUNT;
      hasInput = false;
      inputTax = 0;
    }

    for (const [rate, s] of [...output].sort((a, b) => b[0] - a[0])) {
      push("output", rate, s.net, s.tax, s.account === undefined ? {} : { account: s.account });
    }
    for (const [rate, s] of [...input].sort((a, b) => b[0] - a[0])) {
      push("input", rate, s.net, s.tax, s.account === undefined ? {} : { account: s.account });
    }

    const erloes = sum(legacy, (l) => l.accountType === "revenue");
    const aufwand = sum(legacy, (l) => l.accountType === "expense");
    // Haben-Saldo: Erlös positiv; Aufwand (z. B. Erlösminderung) im Soll negativ, als Vorsteuerbasis umgekehrt.
    if (hasOutput) {
      push(
        "output",
        rateOf(erloes + (hasInput ? 0 : aufwand), outputTax),
        erloes + (hasInput ? 0 : aufwand),
        outputTax,
        { account: VAT_OUTPUT_ACCOUNT },
      );
    } else if (erloes !== 0) {
      // Wie bisher steht das Steuerkonto 2200 auch bei Umsatz ohne Steuer als Konto da.
      const account = VAT_OUTPUT_ACCOUNT;
      if (bookingKind === "credit_note") {
        push("output", 0, erloes, 0, { account, origin: "creditNotes" });
      } else {
        const revenueOn = (code: string) =>
          sum(legacy, (l) => l.accountType === "revenue" && l.account === code);
        const contributions = revenueOn(CONTRIBUTIONS_ACCOUNT);
        const dunning = revenueOn(DUNNING_FEES_ACCOUNT);
        push("output", 0, contributions, 0, { account, origin: "contributions" });
        push("output", 0, dunning, 0, { account, origin: "dunningFees" });
        push("output", 0, erloes - contributions - dunning, 0, { account });
      }
    }
    if (hasInput) {
      const net = -aufwand + (hasOutput ? 0 : -erloes);
      push("input", rateOf(net, inputTax), net, inputTax, { account: VAT_INPUT_ACCOUNT });
    }
  }
  return out;
}
