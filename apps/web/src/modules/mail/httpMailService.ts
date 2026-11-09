import { htmlToText, parseAddress, placeholdersToApi, textToHtml } from "./format";
import {
  MailServiceError,
  type AddressListDetail,
  type AddressListSummary,
  type BulkInput,
  type CampaignState,
  type CampaignStatus,
  type CampaignSummary,
  type Delivery,
  type DeliveryCounts,
  type ListEntry,
  type MailFolder,
  type MailService,
  type MailErrorKind,
  type PersonHit,
  type SaveListInput,
} from "./mailService";

const IMAP_FOLDER: Record<MailFolder, string> = {
  inbox: "INBOX",
  drafts: "Drafts",
  sent: "Sent",
  trash: "Trash",
};

const ANREDE: Record<string, string> = { frau: "Frau", herr: "Herr", divers: "" };

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => (typeof v === "object" && v !== null ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function kindOf(status: number): MailErrorKind {
  if (status === 400 || status === 422) return "validation";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404) return "notFound";
  if (status === 409) return "conflict";
  if (status === 413) return "tooLarge";
  if (status === 502) return "mailServer";
  return "unavailable";
}

const unsupported = (): Promise<never> => Promise.reject(new MailServiceError("unsupported"));

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Anzeigename einer Person, Vorname vor Nachname. */
const fullName = (vorname: string, nachname: string) => `${vorname} ${nachname}`.trim();

/**
 * `MailService` gegen die API: `/mail/*` (Modul `apps/api/src/modules/mail`) sowie `/api/gruppen` und
 * `/api/mitglieder` des Personenmoduls. Wie `createHttpAuthService`: gleiche Origin, Sitzung im
 * HttpOnly-Cookie, bei Schreibzugriffen der Header `X-CSRF-Token`. Das Token holt der Dienst bei
 * Bedarf mit `GET /auth/me` (dieselbe Sitzung) und hält es nur im Speicher.
 */
export function createHttpMailService(
  fetchFn: typeof fetch = (...args) => fetch(...args),
  now: () => number = Date.now,
): MailService {
  let csrf: string | null = null;

  async function csrfToken(): Promise<string> {
    if (csrf) return csrf;
    const res = await fetchFn("/auth/me", {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    }).catch(() => null);
    const body: unknown = res ? await res.json().catch(() => null) : null;
    const token = rec(body)["csrfToken"];
    if (!res || !res.ok || typeof token !== "string") {
      throw new MailServiceError(res ? kindOf(res.status) : "unavailable", res?.status);
    }
    csrf = token;
    return token;
  }

  async function request(
    method: "GET" | "POST" | "PUT",
    path: string,
    payload?: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (payload) headers["Content-Type"] = "application/json";
    if (method !== "GET") headers["X-CSRF-Token"] = await csrfToken();
    let res: Response;
    try {
      res = await fetchFn(path, {
        method,
        headers,
        credentials: "same-origin",
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new MailServiceError("unavailable");
    }
    if (res.status === 403 && method !== "GET") csrf = null; // Token abgelaufen: beim nächsten Versuch neu holen
    if (!res.ok) throw new MailServiceError(kindOf(res.status), res.status);
    return res.status === 204 ? null : await res.json().catch(() => null);
  }

  const get = (path: string, signal?: AbortSignal) => request("GET", path, undefined, signal);
  const post = (path: string, payload: object = {}) => request("POST", path, payload);
  const q = encodeURIComponent;

  const groupsRaw = async (signal?: AbortSignal) =>
    arr(rec(await get("/api/gruppen", signal))["items"]).map((g) => ({
      id: str(rec(g)["id"]),
      name: str(rec(g)["name"]),
      persons: num(rec(g)["mitglieder"]),
    }));

  const entryOf = (r: unknown): ListEntry => {
    const o = rec(r);
    const vorname = str(o["vorname"]);
    const nachname = str(o["nachname"]);
    const email = strOrNull(o["email"]);
    return {
      key: email ?? str(o["name"]),
      name: str(o["name"]) || fullName(vorname, nachname) || (email ?? ""),
      email,
      group: null,
      ...(strOrNull(o["anrede"]) ? { anrede: str(o["anrede"]) } : {}),
      ...(vorname ? { vorname } : {}),
      ...(nachname ? { nachname } : {}),
    };
  };

  function summaryOf(raw: unknown, groups: Map<string, { name: string; persons: number }>) {
    const o = rec(raw);
    const manual = arr(o["manual"]);
    const groupIds = arr(o["groupIds"]).map(str);
    const kind =
      manual.length > 0 || groupIds.length === 0
        ? "manual"
        : groupIds.length === 1
          ? "group"
          : "groups";
    const names = groupIds.map((id) => groups.get(id)?.name ?? "–");
    const fromGroups = groupIds.reduce((n, id) => n + (groups.get(id)?.persons ?? 0), 0);
    const source =
      kind === "manual"
        ? "Manuell gepflegt"
        : kind === "group"
          ? names[0]!
          : `${names[0]} und ${names.length - 1} weitere`;
    // Die Adressen der Gruppen zählt die API nicht: ohne Gruppen sind die Zahlen genau, sonst unbekannt.
    const exact = groupIds.length === 0;
    return {
      id: str(o["id"]),
      name: str(o["name"]),
      kind,
      source,
      persons: manual.length + fromGroups,
      withoutEmail: exact ? 0 : null,
      recipients: exact ? manual.length : null,
      lastUsedAt: null,
      description: "",
      entries: manual.map(entryOf),
      groupIds,
    } satisfies AddressListDetail;
  }

  const groupMap = async (signal?: AbortSignal) => {
    const list = await groupsRaw(signal).catch((e: unknown) => {
      if (signal?.aborted) throw e;
      return [];
    });
    return new Map(list.map((g) => [g.id, g]));
  };

  const countsOf = (raw: unknown): DeliveryCounts => {
    const c = rec(raw);
    return {
      held: num(c["held"]),
      queued: num(c["queued"]),
      sending: num(c["sending"]),
      sent: num(c["sent"]),
      failed: num(c["failed"]),
      cancelled: num(c["cancelled"]),
    };
  };

  function campaignOf(raw: unknown, counts?: DeliveryCounts): CampaignSummary {
    const o = rec(raw);
    const scheduledAt = str(o["scheduledAt"]);
    const apiState = str(o["state"]);
    let state: CampaignState;
    if (apiState === "cancelled") state = "cancelled";
    else if (apiState === "awaiting_confirmation") state = "draft";
    else if (new Date(scheduledAt).getTime() > now()) state = "planned";
    else if (counts) {
      state = counts.held + counts.queued + counts.sending > 0 ? "sending" : "sent";
    } else {
      // Die Liste kennt keine Zähler: ein bestätigter, fälliger Versand gilt als versendet.
      state = "sent";
    }
    return {
      id: str(o["id"]),
      subject: str(o["subject"]),
      listName: null,
      recipientCount: num(o["recipientCount"]),
      scheduledAt,
      state,
      attachmentCount: arr(o["attachmentIds"]).length,
      confirmedAt: strOrNull(o["confirmedAt"]),
      confirmedBy: null,
    };
  }

  const statusOf = (raw: unknown): CampaignStatus => {
    const o = rec(raw);
    const counts = countsOf(o["counts"]);
    return { campaign: campaignOf(o["campaign"], counts), counts };
  };

  const compose = (i: BulkInput) => ({
    accountId: i.accountId,
    subject: placeholdersToApi(i.subject),
    bodyHtml: textToHtml(placeholdersToApi(i.body)),
    attachmentIds: i.attachmentIds,
    listIds: [i.listId],
    ...(i.sendAt ? { sendAt: i.sendAt } : {}),
  });

  const service: MailService = {
    async accounts(signal) {
      return arr(await get("/mail/accounts", signal)).map((a) => ({
        id: str(rec(a)["id"]),
        label: str(rec(a)["label"]),
        fromAddress: str(rec(a)["fromAddress"]),
        fromName: strOrNull(rec(a)["fromName"]),
      }));
    },

    async counts(signal) {
      const [lists, campaigns] = await Promise.allSettled([
        get("/mail/address-lists", signal),
        get("/mail/campaigns", signal),
      ]);
      const out: Record<string, number> = {};
      if (lists.status === "fulfilled") out["lists"] = arr(lists.value).length;
      if (campaigns.status === "fulfilled") {
        out["plan"] = arr(campaigns.value)
          .map((c) => campaignOf(c))
          .filter((c) => c.state === "draft" || c.state === "planned").length;
      }
      return out;
    },

    async inbox(accountId, folder, page, pageSize, signal) {
      const body = rec(
        await get(
          `/mail/accounts/${q(accountId)}/inbox?folder=${q(IMAP_FOLDER[folder])}&page=${page}&pageSize=${pageSize}`,
          signal,
        ),
      );
      const messages = arr(body["messages"]).map((m) => {
        const o = rec(m);
        return {
          uid: num(o["uid"]),
          from: str(o["from"]),
          subject: str(o["subject"]),
          receivedAt: strOrNull(o["date"]),
          seen: o["seen"] === true,
          // Die API liefert weder «beantwortet» noch die Zahl der Anhänge in der Liste.
          answered: false,
          attachments: 0,
        };
      });
      return { total: num(body["total"]), unread: null, messages };
    },

    async read(accountId, folder, uid, signal) {
      const o = rec(
        await get(
          `/mail/accounts/${q(accountId)}/messages/${uid}?folder=${q(IMAP_FOLDER[folder])}`,
          signal,
        ),
      );
      const address = (a: unknown) => ({
        name: strOrNull(rec(a)["name"]),
        address: str(rec(a)["address"]),
      });
      const html = strOrNull(o["html"]);
      return {
        uid: num(o["uid"]),
        from: address(o["from"]),
        to: arr(o["to"]).map(address),
        subject: str(o["subject"]),
        receivedAt: strOrNull(o["date"]),
        sizeBytes: null,
        text: strOrNull(o["text"]) ?? (html ? htmlToText(html) : ""),
        attachments: arr(o["attachments"]).map((a) => ({
          filename: str(rec(a)["filename"]),
          contentType: str(rec(a)["contentType"]),
          size: num(rec(a)["size"]),
        })),
      };
    },

    markRead: unsupported,
    deleteMessages: unsupported,
    saveDraft: unsupported,
    reschedule: unsupported,
    sendNow: unsupported,
    pause: unsupported,

    async reply(accountId, folder, uid, body, attachmentIds) {
      // Die Antwort-Route kennt keine Anhänge.
      if (attachmentIds.length > 0) return unsupported();
      await post(
        `/mail/accounts/${q(accountId)}/messages/${uid}/reply?folder=${q(IMAP_FOLDER[folder])}`,
        { bodyHtml: textToHtml(body) },
      );
    },

    async send(mail) {
      const to = parseAddress(mail.to);
      if (!to) throw new MailServiceError("validation");
      await post("/mail/campaigns", {
        accountId: mail.accountId,
        subject: mail.subject,
        bodyHtml: textToHtml(mail.body),
        attachmentIds: mail.attachmentIds,
        manual: [{ email: to.email, ...(to.name ? { name: to.name } : {}) }],
      });
    },

    async uploadAttachment(file) {
      const o = rec(
        await post("/mail/attachments", {
          filename: file.name,
          contentBase64: await toBase64(file),
        }),
      );
      return { id: str(o["id"]), filename: str(o["filename"]), size: num(o["size"]) };
    },

    async lists(signal) {
      const [raw, groups] = await Promise.all([
        get("/mail/address-lists", signal),
        groupMap(signal),
      ]);
      return arr(raw).map((l): AddressListSummary => {
        const d = summaryOf(l, groups);
        return {
          id: d.id,
          name: d.name,
          kind: d.kind,
          source: d.source,
          persons: d.persons,
          withoutEmail: d.withoutEmail,
          recipients: d.recipients,
          lastUsedAt: d.lastUsedAt,
        };
      });
    },

    async list(id, signal) {
      const [raw, groups] = await Promise.all([
        get(`/mail/address-lists/${q(id)}`, signal),
        groupMap(signal),
      ]);
      return summaryOf(raw, groups);
    },

    async saveList(input: SaveListInput) {
      // Beschreibung und Personen ohne Adresse kennt die API nicht.
      if (input.description.trim() !== "") return unsupported();
      const body = {
        name: input.name,
        groupIds: input.groupIds,
        manual: input.entries
          .filter((e) => e.email)
          .map((e) => ({
            email: e.email!,
            ...(e.anrede ? { anrede: e.anrede } : {}),
            ...(e.vorname ? { vorname: e.vorname } : {}),
            ...(e.nachname ? { nachname: e.nachname } : {}),
          })),
      };
      const raw = input.id
        ? await request("PUT", `/mail/address-lists/${q(input.id)}`, body)
        : await post("/mail/address-lists", body);
      return summaryOf(raw, await groupMap());
    },

    async groups(signal) {
      return (await groupsRaw(signal)).map((g) => ({ ...g, withoutEmail: null }));
    },

    async searchPeople(query, signal) {
      const [raw, groups] = await Promise.all([
        get(`/api/mitglieder?q=${q(query)}&limit=8`, signal),
        groupMap(signal),
      ]);
      const hits: PersonHit[] = [];
      for (const m of arr(rec(raw)["items"])) {
        const o = rec(m);
        const email = strOrNull(o["email"]);
        if (!email) continue; // Ohne Adresse kann die API die Person nicht in einer Liste speichern.
        const vorname = str(o["vorname"]);
        const nachname = str(o["nachname"]);
        const anrede = ANREDE[str(o["anrede"])] ?? "";
        hits.push({
          key: str(o["id"]),
          name: fullName(vorname, nachname),
          email,
          group: groups.get(str(o["gruppeId"]))?.name ?? null,
          ...(anrede ? { anrede } : {}),
          vorname,
          nachname,
        });
      }
      return hits;
    },

    async previewRecipient(listId, signal) {
      return (await service.list(listId, signal)).entries[0] ?? null;
    },

    async testSend(input) {
      await post("/mail/test-send", compose(input));
      return { sentAt: new Date(now()).toISOString() };
    },

    async prepare(input) {
      const o = rec(await post("/mail/campaigns", compose(input)));
      const missing: Record<string, number> = {};
      for (const [k, v] of Object.entries(rec(o["missingValues"]))) missing[k] = num(v);
      return {
        campaignId: str(o["campaignId"]),
        recipientCount: num(o["recipientCount"]),
        missingValues: missing,
        confirmed: o["confirmed"] === true,
        confirmationToken: strOrNull(o["confirmationToken"]),
      };
    },

    async confirm(campaignId, token) {
      return statusOf(await post(`/mail/campaigns/${q(campaignId)}/confirm`, { token }));
    },

    async cancel(campaignId) {
      await post(`/mail/campaigns/${q(campaignId)}/cancel`);
    },

    async campaigns(signal) {
      return arr(await get("/mail/campaigns", signal)).map((c) => campaignOf(c));
    },

    async campaignStatus(campaignId, signal) {
      return statusOf(await get(`/mail/campaigns/${q(campaignId)}`, signal));
    },

    async deliveries(campaignId, offset, limit, signal) {
      return arr(
        await get(
          `/mail/campaigns/${q(campaignId)}/deliveries?offset=${offset}&limit=${limit}`,
          signal,
        ),
      ).map((d): Delivery => {
        const o = rec(d);
        const status = str(o["status"]);
        return {
          id: str(o["id"]),
          name: null,
          email: str(o["email"]),
          status: (["held", "queued", "sending", "sent", "failed", "cancelled"].includes(status)
            ? status
            : "queued") as Delivery["status"],
          at: strOrNull(o["sentAt"]),
          reason: strOrNull(o["lastError"]),
        };
      });
    },
  };
  return service;
}
