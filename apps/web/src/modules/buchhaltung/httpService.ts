import {
  ApiError,
  type AccountRow,
  type AccountType,
  type BuchhaltungService,
  type CamtPayment,
  type Entry,
  type ImportResult,
  type ImportSummary,
  type InvoiceInfo,
  type OpenInvoice,
  type PersonInfo,
  type PersonLedger,
  type ReminderInfo,
  type RestPage,
} from "./types";

interface Options {
  csrfToken: () => string | null;
  onUnauthorized: () => void;
  /** Name der angemeldeten Person für das Importprotokoll. */
  userName?: string;
  fetchFn?: typeof fetch;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

function query(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/**
 * `BuchhaltungService` gegen die API (`/accounting`, `/camt`, `/invoices`; gleiche Origin,
 * Cookie-Sitzung). Schreibende Anfragen tragen das CSRF-Token.
 */
export function createHttpBuchhaltungService(options: Options): BuchhaltungService {
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function send(
    method: "GET" | "POST" | "PATCH",
    path: string,
    payload?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const multipart = payload instanceof FormData;
    if (payload !== undefined && !multipart) headers["Content-Type"] = "application/json";
    const token = options.csrfToken();
    if (token && method !== "GET") headers["X-CSRF-Token"] = token;
    const res = await fetchFn(path, {
      method,
      headers,
      credentials: "same-origin",
      ...(payload === undefined ? {} : { body: multipart ? payload : JSON.stringify(payload) }),
    });
    const body: unknown = res.status === 204 ? null : await res.json().catch(() => null);
    if (res.status === 401) options.onUnauthorized();
    if (!res.ok) {
      const error = isRecord(body) && isRecord(body["error"]) ? body["error"] : {};
      // Fachfehler (409/422) tragen einen festen, für Nutzer bestimmten Text der API.
      const message = res.status === 409 || res.status === 422 ? str(error["message"]) : "";
      throw new ApiError(res.status, str(error["code"]) || undefined, message || undefined);
    }
    return body;
  }

  /** Lädt eine Datei der API (GET) und stösst den Download im Browser an. */
  async function download(path: string, fallbackName: string): Promise<void> {
    const res = await fetchFn(path, { method: "GET", credentials: "same-origin" });
    if (res.status === 401) options.onUnauthorized();
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      const error = isRecord(body) && isRecord(body["error"]) ? body["error"] : {};
      throw new ApiError(res.status, str(error["code"]) || undefined);
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download =
      /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? fallbackName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  const payment = (v: unknown): CamtPayment => v as CamtPayment;

  const invoiceOf = (v: unknown) => {
    const o = isRecord(v) ? v : {};
    const debtor = isRecord(o["debtor"]) ? o["debtor"] : {};
    return {
      id: str(o["id"]),
      number: typeof o["number"] === "string" ? o["number"] : null,
      debtorName: str(debtor["name"]),
      dueDate: str(o["dueDate"]),
      openRappen: num(o["openCents"]),
    };
  };

  return {
    async listAccounts() {
      const [accounts, trial] = await Promise.all([
        send("GET", "/accounting/accounts"),
        send("GET", "/accounting/trial-balance"),
      ]);
      const totals = new Map(
        arr(isRecord(trial) ? trial["rows"] : []).map((r) => [
          str((r as { code: string }).code),
          r,
        ]),
      );
      return arr(accounts).map((a): AccountRow => {
        const acc = a as { code: string; name: string; type: AccountType; active: boolean };
        const t = (totals.get(acc.code) ?? {}) as Record<string, unknown>;
        return {
          code: acc.code,
          name: acc.name,
          type: acc.type,
          active: acc.active,
          debit: num(t["debit"]),
          credit: num(t["credit"]),
          balance: num(t["balance"]),
          entryCount: num(t["entryCount"]),
        };
      });
    },

    async createAccount(input) {
      await send("POST", "/accounting/accounts", input);
    },
    async renameAccount(code, name) {
      await send("PATCH", `/accounting/accounts/${encodeURIComponent(code)}`, { name });
    },

    async listEntries(q) {
      const filter = { from: q.from, to: q.to, accountCode: q.accountCode };
      // Eine Zeile mehr anfordern: so weiss die Oberfläche auch ohne Gesamtzahl, ob eine Folgeseite kommt.
      const [body, count] = await Promise.all([
        send(
          "GET",
          `/accounting/entries${query({ ...filter, limit: q.limit + 1, offset: q.offset })}`,
        ),
        send("GET", `/accounting/entries/count${query(filter)}`),
      ]);
      const rows = arr(body).map((e): Entry => {
        const o = e as Record<string, unknown>;
        return {
          id: str(o["id"]),
          number: num(o["number"]),
          bookingDate: str(o["bookingDate"]),
          kind: o["kind"] as Entry["kind"],
          description: str(o["description"]),
          lines: arr(o["lines"]) as Entry["lines"],
          reversalOf: typeof o["reversalOf"] === "string" ? o["reversalOf"] : null,
          createdBy: str(o["createdBy"]),
          createdByName: typeof o["createdByName"] === "string" ? o["createdByName"] : null,
        };
      });
      return {
        items: rows.slice(0, q.limit),
        hasMore: rows.length > q.limit,
        total: num(isRecord(count) ? count["total"] : 0),
      };
    },

    async reverseEntry(id, input) {
      await send("POST", `/accounting/entries/${encodeURIComponent(id)}/reverse`, input);
    },

    async listOpenInvoices() {
      const out: OpenInvoice[] = [];
      for (let offset = 0; ; offset += 200) {
        const body = await send(
          "GET",
          `/invoices${query({ status: "sent", kind: "invoice", limit: 200, offset })}`,
        );
        const items = arr(isRecord(body) ? body["items"] : []).map(invoiceOf);
        out.push(...items.filter((i) => i.openRappen > 0));
        if (items.length < 200) return out;
      }
    },

    async listReminders(invoiceId) {
      const body = await send("GET", `/invoices/${encodeURIComponent(invoiceId)}/reminders`);
      return arr(isRecord(body) ? body["items"] : []).map((r): ReminderInfo => {
        const o = r as Record<string, unknown>;
        return { level: num(o["level"]), title: str(o["title"]) };
      });
    },

    async issueReminder(invoiceId) {
      await send("POST", `/invoices/${encodeURIComponent(invoiceId)}/reminders`, {});
    },

    async getInvoice(invoiceId): Promise<InvoiceInfo | null> {
      try {
        const i = invoiceOf(await send("GET", `/invoices/${encodeURIComponent(invoiceId)}`));
        return { number: i.number, debtorName: i.debtorName, openRappen: i.openRappen };
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },

    async listRest(): Promise<RestPage> {
      const body = await send("GET", "/camt/rest?limit=100");
      const o = isRecord(body) ? body : {};
      return { items: arr(o["items"]).map(payment), hasMore: typeof o["nextCursor"] === "string" };
    },

    async assignRest(paymentId, openItemId) {
      await send("POST", `/camt/rest/${encodeURIComponent(paymentId)}/zuordnen`, { openItemId });
    },
    async postponePayment(paymentId, postponed = true) {
      await send("POST", `/camt/rest/${encodeURIComponent(paymentId)}/zurueckstellen`, {
        postponed,
      });
    },

    async listImports() {
      const body = await send("GET", "/camt/imports?limit=100");
      return arr(isRecord(body) ? body["items"] : []).map((i): ImportSummary => {
        const o = i as Record<string, unknown>;
        return {
          importId: str(o["importId"]),
          kind: o["kind"] as ImportSummary["kind"],
          messageId: str(o["messageId"]),
          importedAt: Date.parse(str(o["importedAt"])),
          importedBy: typeof o["importedBy"] === "string" ? o["importedBy"] : null,
          counts: o["counts"] as ImportSummary["counts"],
        };
      });
    },

    async importFile(file, checksum): Promise<ImportResult> {
      const form = new FormData();
      form.append("file", file);
      const o = (await send("POST", "/camt/import", form)) as Record<string, unknown>;
      return {
        importId: str(o["importId"]),
        kind: o["kind"] as ImportResult["kind"],
        fileName: file.name,
        checksum,
        importedAt: Date.now(),
        importedBy: options.userName ?? "",
        counts: o["counts"] as ImportResult["counts"],
        matched: arr(o["matched"]).map(payment),
        rest: arr(o["rest"]).map(payment),
      };
    },

    async personLedger(personId): Promise<PersonLedger> {
      const o = (await send(
        "GET",
        `/accounting/persons/${encodeURIComponent(personId)}/ledger?limit=200`,
      )) as Record<string, unknown>;
      return {
        personId,
        balance: num(o["balance"]),
        debit: num(o["debit"]),
        credit: num(o["credit"]),
        openItems: arr(o["openItems"]).map((i) => {
          const r = i as Record<string, unknown>;
          return {
            id: str(r["id"]),
            reference: str(r["reference"]),
            dueDate: str(r["dueDate"]),
            remaining: num(r["remaining"]),
          };
        }),
        lines: arr(o["lines"]).map((l) => {
          const r = l as Record<string, unknown>;
          return {
            entryNumber: num(r["entryNumber"]),
            bookingDate: str(r["bookingDate"]),
            description: str(r["description"]),
            side: r["side"] as "debit" | "credit",
            amount: num(r["amount"]),
            balanceAfter: num(r["balanceAfter"]),
          };
        }),
      };
    },

    async getPerson(personId): Promise<PersonInfo | null> {
      try {
        const m = (await send("GET", `/api/mitglieder/${encodeURIComponent(personId)}`)) as Record<
          string,
          unknown
        >;
        let group: string | null = null;
        if (typeof m["gruppeId"] === "string") {
          const groups = await send("GET", "/api/gruppen");
          const hit = arr(isRecord(groups) ? groups["items"] : []).find(
            (g) => (g as { id?: string }).id === m["gruppeId"],
          );
          group = hit ? str((hit as { name?: unknown }).name) : null;
        }
        return {
          name: `${str(m["vorname"])} ${str(m["nachname"])}`.trim(),
          email: typeof m["email"] === "string" ? m["email"] : null,
          group,
        };
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },

    exportXlsx(what) {
      if (what === "accounts") return download("/accounting/export/accounts", "kontenplan.xlsx");
      // Offene Posten: Auswertung der Berichte, Stichtag heute (Europe/Zurich).
      const asOf = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(
        new Date(),
      );
      return download(
        `/reports/open-items/export${query({ format: "xlsx", asOf })}`,
        "offene-posten.xlsx",
      );
    },
    downloadStatement: (personId) =>
      download(`/accounting/persons/${encodeURIComponent(personId)}/statement`, "kontoauszug.pdf"),
  };
}
