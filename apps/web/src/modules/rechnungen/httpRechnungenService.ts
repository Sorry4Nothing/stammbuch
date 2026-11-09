import type { FirmaDto, MemberDto } from "@stammbuch/shared";
import { buildHistory } from "./history";
import {
  toRow,
  todayIso,
  type Address,
  type BillingSettings,
  type DunningLevel,
  type Invoice,
  type InvoiceRow,
  type Recipient,
  type Reminder,
} from "./model";
import { UnavailableError, type CreditInput, type RechnungenService } from "./service";

/** Fehlerantwort der API; `message` ist der für den Nutzer bestimmte Satz des Servers (feste Texte, SR-51). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const PAGE = 200;
const PARALLEL = 6;

type Json = Record<string, unknown>;

type SharedAddress = NonNullable<MemberDto["adresse"]>;

function toAddress(name: string, a: SharedAddress | null | undefined): Address {
  return {
    name,
    street: a?.strasse,
    buildingNumber: a?.hausnr,
    postalCode: a?.plz ?? "",
    town: a?.ort ?? "",
    country: a?.land ?? "CH",
  };
}

const memberRecipient = (m: MemberDto): Recipient => {
  const name = `${m.vorname} ${m.nachname}`.trim();
  return { id: m.id, name, address: toAddress(name, m.adresse), email: m.email };
};

const firmaRecipient = (f: FirmaDto): Recipient => ({
  id: f.id,
  name: f.name,
  address: toAddress(f.name, f.adresse),
  email: f.email,
});

/**
 * Teilgutschrift als eine Position. Der Betrag im Dialog ist der Bruttobetrag; er wird mit dem Satz der ersten
 * Position auf netto zurückgerechnet (shortcut: bei gemischten Sätzen kann der Server um einen Rappen abweichen).
 */
function partialLine(input: CreditInput, inv: Invoice) {
  const rate = inv.vatMode === "none" ? 0 : (inv.lines[0]?.vatRateBp ?? 0);
  return {
    description: input.reason,
    quantityMilli: 1000,
    unitCents: Math.round((input.amountCents * 10_000) / (10_000 + rate)),
    vatRateBp: rate,
  };
}

/** Führt `fn` für alle Elemente mit höchstens `PARALLEL` gleichzeitigen Anfragen aus. */
async function mapLimited<T, R>(items: readonly T[], fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
  return out;
}

/**
 * `RechnungenService` gegen die Routen unter `/invoices` (Cookie-Sitzung, gleiche Origin). Das CSRF-Token
 * für Schreibzugriffe holt der Dienst bei Bedarf per `GET /auth/me`; es lebt nur im Speicher.
 *
 * Lücken im Server (siehe PR «Fehlende API»): E-Mail-Versand, Storno-Grund und -Benachrichtigung,
 * Excel-Export, Beiträge je Gruppe (Sammelrechnung), Mitgliedsnummern, Buchungsnummern im Verlauf.
 */
export function createHttpRechnungenService(
  fetchFn: typeof fetch = (...args) => fetch(...args),
  now: () => number = Date.now,
): RechnungenService {
  let csrf: string | null = null;

  async function token(): Promise<string> {
    if (csrf) return csrf;
    const res = await fetchFn("/auth/me", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const body = (await res.json().catch(() => null)) as Json | null;
    if (!res.ok || typeof body?.["csrfToken"] !== "string") throw new ApiError(res.status, "");
    csrf = body["csrfToken"];
    return csrf;
  }

  async function send(method: string, path: string, payload?: object): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (payload) headers["Content-Type"] = "application/json";
    if (method !== "GET") headers["X-CSRF-Token"] = await token();
    const res = await fetchFn(path, {
      method,
      headers,
      credentials: "same-origin",
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    if (res.status === 403) csrf = null; // abgelaufenes Token: beim nächsten Schreibzugriff neu holen
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: unknown } } | null;
      const message = body?.error?.message;
      throw new ApiError(res.status, typeof message === "string" ? message : "");
    }
    return res;
  }

  async function call<T>(method: string, path: string, payload?: object): Promise<T> {
    const res = await send(method, path, payload);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  const today = () => todayIso(now());

  async function listAll(kind: "invoice" | "credit_note"): Promise<Invoice[]> {
    const out: Invoice[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await call<{ items: Invoice[]; total: number }>(
        "GET",
        `/invoices?kind=${kind}&limit=${PAGE}&offset=${offset}`,
      );
      out.push(...page.items);
      if (offset + PAGE >= page.total) return out;
    }
  }

  const remindersOf = async (id: string) =>
    (await call<{ items: Reminder[] }>("GET", `/invoices/${id}/reminders`)).items;

  async function rows(): Promise<InvoiceRow[]> {
    const day = today();
    const invoices = await listAll("invoice");
    // Mahnungen gibt es nur zu versendeten, nicht bezahlten Rechnungen nach Ablauf der Frist.
    const withReminders = new Map<string, Reminder[]>();
    const candidates = invoices.filter((i) => i.status === "sent" && i.dueDate < day);
    await mapLimited(candidates, async (i) => withReminders.set(i.id, await remindersOf(i.id)));
    return invoices.map((i) => toRow(i, withReminders.get(i.id) ?? [], day));
  }

  async function contactEmail(customerId: string | null): Promise<string | null> {
    if (!customerId) return null;
    for (const path of [`/api/mitglieder/${customerId}`, `/api/firmen/${customerId}`]) {
      try {
        const body = await call<{ email: string | null }>("GET", path);
        return body.email;
      } catch {
        // nicht gefunden oder keine Berechtigung: nächste Quelle
      }
    }
    return null;
  }

  async function dueLevels(): Promise<Record<string, DunningLevel>> {
    const { items } = await call<{ items: { invoiceId: string; nextLevel: DunningLevel }[] }>(
      "GET",
      "/invoices/dunning/due",
    );
    return Object.fromEntries(items.map((i) => [i.invoiceId, i.nextLevel]));
  }

  const getSettings = () => call<BillingSettings>("GET", "/invoices/settings");

  return {
    today,
    listInvoices: rows,

    async getInvoice(id) {
      const day = today();
      const invoice = await call<Invoice>("GET", `/invoices/${id}`);
      const overdue = invoice.status === "sent" && invoice.dueDate < day;
      const [reminders, email, due, creditNotes] = await Promise.all([
        invoice.status === "draft" ? [] : remindersOf(id),
        contactEmail(invoice.customerId),
        overdue ? dueLevels() : Promise.resolve<Record<string, DunningLevel>>({}),
        invoice.creditedCents > 0 ? listAll("credit_note") : Promise.resolve<Invoice[]>([]),
      ]);
      const dueLevel = due[id];
      const last = reminders.reduce<Reminder | null>(
        (m, r) => (m && m.level >= r.level ? m : r),
        null,
      );
      return {
        invoice,
        reminders,
        email,
        level: last?.level ?? 0,
        levelTitle: last?.title ?? null,
        dueLevel,
        history: buildHistory({
          invoice,
          reminders,
          creditNotes: creditNotes.filter((c) => c.creditNoteOf === id),
          dueLevel,
          today: day,
        }),
      };
    },

    getSettings,

    async searchRecipients(query) {
      const q = encodeURIComponent(query.trim());
      const [members, firms] = await Promise.all([
        call<{ items: MemberDto[] }>("GET", `/api/mitglieder?limit=8&q=${q}`),
        call<{ items: FirmaDto[] }>("GET", `/api/firmen?limit=8&status=freigegeben&q=${q}`),
      ]);
      return [...firms.items.map(firmaRecipient), ...members.items.map(memberRecipient)];
    },

    async saveDraft(input, existing) {
      const body = {
        customerId: input.recipient.id,
        debtor: input.recipient.address,
        currency: "CHF",
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        subject: input.subject,
        notes: input.notes,
        lines: input.lines.map((l) => ({
          description: l.description,
          quantityMilli: l.quantityMilli,
          unitCents: l.unitCents,
          vatRateBp: l.vatRateBp,
        })),
      };
      return existing
        ? call<Invoice>("PUT", `/invoices/${existing.id}`, { ...body, version: existing.version })
        : call<Invoice>("POST", "/invoices", body);
    },

    // Der Server bucht und vergibt die Nummer; einen E-Mail-Versand gibt es dort noch nicht.
    async sendInvoice(id) {
      return { invoice: await call<Invoice>("POST", `/invoices/${id}/send`, {}), delivered: false };
    },

    // Grund, Bemerkung und Benachrichtigung nimmt die Route nicht an.
    cancelInvoice: (id) => call<Invoice>("POST", `/invoices/${id}/cancel`, {}),

    async creditInvoice(id, input) {
      const inv = await call<Invoice>("GET", `/invoices/${id}`);
      const lines =
        input.scope === "full"
          ? inv.lines.map((l) => ({
              description: l.description,
              quantityMilli: l.quantityMilli,
              unitCents: l.unitCents,
              vatRateBp: l.vatRateBp,
            }))
          : [partialLine(input, inv)];
      return call<Invoice>("POST", `/invoices/${id}/credit-notes`, {
        lines,
        subject: input.reason,
      });
    },

    async dunningOverview() {
      const [list, due, settings] = await Promise.all([rows(), dueLevels(), getSettings()]);
      return {
        today: today(),
        rows: list.filter((r) => r.overdueDays !== null),
        due,
        levels: settings.dunning.levels,
      };
    },

    issueReminder: (invoiceId) => call<Reminder>("POST", `/invoices/${invoiceId}/reminders`, {}),

    async downloadPdf(invoiceId, level) {
      const path =
        level === undefined
          ? `/invoices/${invoiceId}/pdf`
          : `/invoices/${invoiceId}/reminders/${level}/pdf`;
      const res = await send("GET", path);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download =
        /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ??
        "rechnung.pdf";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },

    // Beiträge je Gruppe gibt es im Server nicht: die Sammelrechnung hat keine Datengrundlage.
    collectiveSetup: () => Promise.reject(new UnavailableError("Beiträge je Gruppe")),
    collectivePreview: () => Promise.reject(new UnavailableError("Beiträge je Gruppe")),
    runCollective: () => Promise.reject(new UnavailableError("Beiträge je Gruppe")),
  };
}
