import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../lib/errors.js";
import type { Member } from "../people/domain.js";
import { createMemoryStore as createPeople } from "../people/memory.js";
import { createPersonDirectory } from "./directory.js";
import { type Actor, PERMISSIONS, type Permission, createInvoicesModule } from "./index.js";
import type { InvoiceMail, InvoiceMailPort } from "./mail-port.js";
import {
  MemoryInvoiceRepository,
  MemoryReminderRepository,
  MemorySettingsRepository,
} from "./memory.js";
import { RESEND_BATCH_MAX } from "./schemas.js";
import { OTHER_TENANT, TENANT, invoiceInput, settingsInput } from "./test-fixtures.js";

// Routen aus #132: Sammelversand «Rechnungen erneut senden» und Storno mit Benachrichtigung. Anmeldung, Rechte,
// Mandantentrennung, Eingaben und Ablauf über HTTP; CSRF und Origin prüft `app.authenticateRequest` zentral (app.ts).
function authenticate(req: { headers: Record<string, unknown> }): Promise<Actor | null> {
  const h = req.headers["x-test-actor"];
  if (typeof h !== "string") return Promise.resolve(null);
  const [tenantId, perms] = h.split("|");
  const permissions = new Set(
    (perms === "*" ? [...PERMISSIONS] : (perms ?? "").split(",")) as Permission[],
  );
  return Promise.resolve({ userId: "u1", tenantId: tenantId ?? "", permissions });
}

const as = (tenant: string, perms = "*") => ({ "x-test-actor": `${tenant}|${perms}` });
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = new Date("2026-11-04T10:00:00Z");

const member = (n: number, over: Partial<Member> = {}): Member => ({
  id: ID(100 + n),
  kundeId: TENANT,
  typ: "einzel",
  status: "aktiv",
  anrede: null,
  vorname: `Vor${n}`,
  nachname: `Nach${n}`,
  email: `m${n}@example.test`,
  telefon: null,
  mobil: null,
  adresse: { strasse: "Dorfstrasse", hausnr: "3", plz: "3000", ort: "Bern", land: "CH" },
  notiz: null,
  mitgliedsnr: "",
  geburtsdatum: null,
  eintritt: null,
  kanal: null,
  gruppeSeit: null,
  funktion: null,
  firmaId: null,
  gruppeId: null,
  erstelltAm: NOW,
  geaendertAm: NOW,
  ...over,
});

async function makeApp(options: { withMail?: boolean } = {}) {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  const sent: InvoiceMail[] = [];
  const mail: InvoiceMailPort = {
    send: async (_from, m) => {
      sent.push(m);
    },
  };
  const people = createPeople();
  const mod = createInvoicesModule({
    invoices: new MemoryInvoiceRepository(),
    reminders: new MemoryReminderRepository(),
    settings: new MemorySettingsRepository(),
    people: createPersonDirectory(people),
    ...(options.withMail === false ? {} : { mail }),
    authenticate,
    now: () => NOW,
  });
  await app.register(async (scope) => mod.register(scope));
  const settings = await app.inject({
    method: "PUT",
    url: "/invoices/settings",
    headers: as(TENANT),
    payload: settingsInput(),
  });
  expect(settings.statusCode).toBe(200);

  const sentInvoiceTo = async (m: Member) => {
    const stored = await people.members.insert(m);
    const d = (
      await app.inject({
        method: "POST",
        url: "/invoices",
        headers: as(TENANT),
        payload: invoiceInput({ customerId: stored.id }),
      })
    ).json();
    expect(d.memberNumber).toBe(stored.mitgliedsnr);
    return (
      await app.inject({ method: "POST", url: `/invoices/${d.id}/send`, headers: as(TENANT) })
    ).json();
  };
  return { app, sent, sentInvoiceTo };
}

const BATCH = "/invoices/email-batch";

describe("POST /invoices/email-batch", () => {
  it("verlangt Anmeldung (401) und das Recht zu buchen (403)", async () => {
    const { app } = await makeApp();
    expect((await app.inject({ method: "POST", url: BATCH })).statusCode).toBe(401);
    for (const perms of ["invoices:read", "invoices:write", "invoices:dunning"]) {
      const res = await app.inject({
        method: "POST",
        url: BATCH,
        headers: as(TENANT, perms),
        payload: { ids: [ID(1)] },
      });
      expect(res.statusCode, perms).toBe(403);
    }
  });

  it("lehnt ungültige Eingaben ab (400): leer, zu viele, keine UUID, unbekannte Felder", async () => {
    const { app } = await makeApp();
    const post = (payload: unknown) =>
      app.inject({ method: "POST", url: BATCH, headers: as(TENANT), payload: payload as object });
    expect((await post({ ids: [] })).statusCode).toBe(400);
    expect((await post({})).statusCode).toBe(400);
    expect((await post({ ids: ["x"] })).statusCode).toBe(400);
    expect((await post({ ids: [ID(1)], to: "x@example.test" })).statusCode).toBe(400);
    const many = Array.from({ length: RESEND_BATCH_MAX + 1 }, (_, i) => ID(i + 1));
    expect((await post({ ids: many })).statusCode).toBe(400);
  });

  it("sendet je Rechnung und meldet den Ausgang; die Antwort trägt keine Mandanten-ID", async () => {
    const { app, sent, sentInvoiceTo } = await makeApp();
    const a = await sentInvoiceTo(member(1));
    const b = await sentInvoiceTo(member(2, { email: null }));
    const res = await app.inject({
      method: "POST",
      url: BATCH,
      headers: as(TENANT),
      payload: { ids: [a.id, b.id, ID(999)] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        { id: a.id, number: "RE-2026-0001", outcome: "sent" },
        { id: b.id, number: "RE-2026-0002", outcome: "skipped", reason: "no-address" },
        { id: ID(999), number: null, outcome: "failed", reason: "not-found" },
      ],
    });
    expect(res.body).not.toContain(TENANT);
    expect(sent.map((m) => [m.to, m.attachment.filename])).toEqual([
      ["m1@example.test", "RE-2026-0001.pdf"],
    ]);
  });

  it("kennt Rechnungen anderer Mandanten nicht und sendet nichts", async () => {
    const { app, sent, sentInvoiceTo } = await makeApp();
    const a = await sentInvoiceTo(member(1));
    await app.inject({
      method: "PUT",
      url: "/invoices/settings",
      headers: as(OTHER_TENANT),
      payload: settingsInput(),
    });
    const res = await app.inject({
      method: "POST",
      url: BATCH,
      headers: as(OTHER_TENANT),
      payload: { ids: [a.id] },
    });
    expect(res.json().items).toEqual([
      { id: a.id, number: null, outcome: "failed", reason: "not-found" },
    ]);
    expect(sent).toHaveLength(0);
  });

  it("ohne Mail-Anbindung eine feste Meldung (422)", async () => {
    const { app, sentInvoiceTo } = await makeApp({ withMail: false });
    const a = await sentInvoiceTo(member(1));
    const res = await app.inject({
      method: "POST",
      url: BATCH,
      headers: as(TENANT),
      payload: { ids: [a.id] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toBe("Der E-Mail-Versand ist nicht eingerichtet.");
  });
});

describe("POST /invoices/:id/cancel mit notify", () => {
  it("benachrichtigt die Person mit der Gutschrift und nennt den Ausgang in «notification»", async () => {
    const { app, sent, sentInvoiceTo } = await makeApp();
    const a = await sentInvoiceTo(member(1));
    const res = await app.inject({
      method: "POST",
      url: `/invoices/${a.id}/cancel`,
      headers: as(TENANT),
      payload: { reason: "Doppelt erstellt", remark: "", notify: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "cancelled", notification: "sent" });
    expect(res.body).not.toContain(TENANT);
    expect(sent.map((m) => [m.to, m.attachment.filename])).toEqual([
      ["m1@example.test", "GS-2026-0001.pdf"],
    ]);
  });

  it("ohne notify keine Mail und kein Feld; notify muss ein Wahrheitswert sein", async () => {
    const { app, sent, sentInvoiceTo } = await makeApp();
    const a = await sentInvoiceTo(member(1));
    const bad = await app.inject({
      method: "POST",
      url: `/invoices/${a.id}/cancel`,
      headers: as(TENANT),
      payload: { notify: "ja" },
    });
    expect(bad.statusCode).toBe(400);
    const res = await app.inject({
      method: "POST",
      url: `/invoices/${a.id}/cancel`,
      headers: as(TENANT),
      payload: { reason: "x" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty("notification");
    expect(sent).toHaveLength(0);
  });

  it("ohne Mailkonto bleibt das Storno bestehen (200, «failed»)", async () => {
    const { app, sentInvoiceTo } = await makeApp({ withMail: false });
    const a = await sentInvoiceTo(member(1));
    const res = await app.inject({
      method: "POST",
      url: `/invoices/${a.id}/cancel`,
      headers: as(TENANT),
      payload: { notify: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "cancelled", notification: "failed" });
  });

  it("fremder Mandant: 404 und keine Mail", async () => {
    const { app, sent, sentInvoiceTo } = await makeApp();
    const a = await sentInvoiceTo(member(1));
    const res = await app.inject({
      method: "POST",
      url: `/invoices/${a.id}/cancel`,
      headers: as(OTHER_TENANT),
      payload: { notify: true },
    });
    expect(res.statusCode).toBe(404);
    expect(sent).toHaveLength(0);
  });
});

describe("Mitgliedsnummer in der Antwort", () => {
  it("liefert sie bei Liste und Detail", async () => {
    const { app, sentInvoiceTo } = await makeApp();
    const a = await sentInvoiceTo(member(1));
    const detail = await app.inject({
      method: "GET",
      url: `/invoices/${a.id}`,
      headers: as(TENANT, "invoices:read"),
    });
    expect(detail.json().memberNumber).toMatch(/^M-\d+$/);
    const list = await app.inject({
      method: "GET",
      url: "/invoices?kind=invoice",
      headers: as(TENANT, "invoices:read"),
    });
    expect(list.json().items[0].memberNumber).toBe(detail.json().memberNumber);
  });
});
