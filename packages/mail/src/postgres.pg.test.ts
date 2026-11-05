import { Datenbank } from "@stammbuch/db";
import { createTestDatabase, withCredentials } from "@stammbuch/db/testing";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPostgresMailRepositories, createPostgresWorkerRepositories } from "./postgres.js";
import { processDueDeliveries } from "./processor.js";
import type { ConnectionFactory } from "./ports.js";
import type { MailRepositories } from "./repositories.js";
import { MailService } from "./service.js";
import { accountWith, endpoint, fakeConnections, newBox, rotationBoxes } from "./test-helpers.js";
import type { AddressList, Campaign, Delivery, MailAccount, MailContext } from "./types.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const userA = "aaaaaaaa-0000-4000-8000-000000000001";
const userA2 = "aaaaaaaa-0000-4000-8000-000000000002";
const userB = "bbbbbbbb-0000-4000-8000-000000000001";
const ctxA: MailContext = { tenantId: A, userId: userA, email: "a@example.test" };
const NOW = new Date("2026-11-04T10:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

describe("Mail-Repositories gegen PostgreSQL (API: stammbuch_app, Worker: stammbuch_worker)", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let owner: pg.Client;
  let appDb: Datenbank;
  let workerDb: Datenbank;
  let api: MailRepositories;
  let worker: MailRepositories;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject("adminUrl"), inject("templateDb"));
    owner = new pg.Client({ connectionString: testDb.adminUrl });
    await owner.connect();
    await owner.query(`INSERT INTO kunde (id, name) VALUES ('${A}', 'A'), ('${B}', 'B')`);
    await owner.query(
      `INSERT INTO benutzer (id, kunde_id, email, name, passwort_hash) VALUES
        ('${userA}', '${A}', 'a@example.test', 'A', 'h'),
        ('${userA2}', '${A}', 'a2@example.test', 'A2', 'h'),
        ('${userB}', '${B}', 'b@example.test', 'B', 'h')`,
    );
    appDb = new Datenbank(
      withCredentials(testDb.adminUrl, "stammbuch_app", inject("appPassword")),
      {
        max: 6,
      },
    );
    workerDb = new Datenbank(
      withCredentials(testDb.adminUrl, "stammbuch_worker", inject("workerPassword")),
      { max: 4 },
    );
    api = createPostgresMailRepositories(appDb);
    worker = createPostgresWorkerRepositories(workerDb);
  });

  afterAll(async () => {
    await appDb?.close();
    await workerDb?.close();
    await owner?.end();
    await testDb?.drop();
  });

  const account = (over: Partial<MailAccount> = {}): MailAccount => ({
    id: randomUUID(),
    tenantId: A,
    ownerUserId: userA,
    label: "Verein",
    fromAddress: "verein@example.test",
    fromName: "Verein Muster",
    username: "user",
    secretEnc: "k1:geheim",
    smtp: endpoint,
    imap: { host: "imap.example.test", port: 993, security: "tls" },
    createdAt: NOW,
    ...over,
  });

  const campaign = (acc: MailAccount, over: Partial<Campaign> = {}): Campaign => ({
    id: randomUUID(),
    tenantId: acc.tenantId,
    ownerUserId: acc.ownerUserId,
    accountId: acc.id,
    kind: "campaign",
    subject: "Hallo",
    bodyHtml: "<p>Hallo</p>",
    attachmentIds: [],
    scheduledAt: NOW,
    state: "confirmed",
    recipientCount: 1,
    createdAt: NOW,
    confirmedAt: NOW,
    ...over,
  });

  const delivery = (c: Campaign, over: Partial<Delivery> = {}): Delivery => ({
    id: randomUUID(),
    tenantId: c.tenantId,
    campaignId: c.id,
    recipient: { email: `${randomUUID()}@example.test`, vorname: "Anna" },
    status: "queued",
    attempts: 0,
    nextAttemptAt: NOW,
    ...over,
  });

  /** Konto, bestätigte Kampagne und n fällige Zustellungen über die API-Verbindung angelegt. */
  async function queued(n = 1) {
    const acc = account();
    await api.accounts.insert(acc);
    const c = campaign(acc, { recipientCount: n });
    const ds = Array.from({ length: n }, () => delivery(c));
    await api.campaigns.create(c, ds);
    return { acc, c, ds };
  }

  describe("Konten, Anhänge, Adresslisten", () => {
    it("Konto: Roundtrip, Änderung, Löschen; IMAP bleibt optional", async () => {
      const acc = account();
      const plain = account({ imap: undefined, fromName: undefined, label: "Ohne IMAP" });
      await api.accounts.insert(acc);
      await api.accounts.insert(plain);
      expect(await api.accounts.get(A, acc.id)).toEqual(acc);
      expect(await api.accounts.get(A, plain.id)).toEqual(plain);

      await api.accounts.update({ ...acc, label: "Neu", secretEnc: "k2:rotiert" });
      expect(await api.accounts.get(A, acc.id)).toMatchObject({
        label: "Neu",
        secretEnc: "k2:rotiert",
      });
      expect((await api.accounts.listByOwner(A, userA)).map((a) => a.id)).toContain(acc.id);
      expect(await api.accounts.listByOwner(A, userA2)).toEqual([]);

      expect(await api.accounts.delete(A, acc.id)).toBe(true);
      expect(await api.accounts.delete(A, acc.id)).toBe(false);
      expect(await api.accounts.get(A, acc.id)).toBeNull();
    });

    it("Anhang: Bytes bleiben gleich, auch über den Worker-Weg", async () => {
      const bytes = Buffer.from([0, 1, 2, 250, 255, 37, 80, 68, 70]);
      const meta = {
        id: randomUUID(),
        tenantId: A,
        ownerUserId: userA,
        filename: "a.pdf",
        contentType: "application/pdf",
        size: bytes.length,
        sha256: "a".repeat(64),
        createdAt: NOW,
      };
      await api.attachments.insert(meta, bytes);
      for (const repos of [api, worker]) {
        const got = await repos.attachments.get(A, meta.id);
        expect(got?.meta).toEqual(meta);
        expect(got?.bytes.equals(bytes)).toBe(true);
        expect(await repos.attachments.get(B, meta.id)).toBeNull();
      }
    });

    it("Adressliste: Empfänger als JSON, Gruppen-IDs als Text, Änderung und Löschen", async () => {
      const list: AddressList = {
        id: randomUUID(),
        tenantId: A,
        ownerUserId: userA,
        name: "Vorstand",
        manual: [{ email: "x@example.test", vorname: "Xaver", antwortlink: "https://x.example/a" }],
        groupIds: ["g1", "g2"],
        createdAt: NOW,
      };
      await api.lists.insert(list);
      expect(await api.lists.get(A, list.id)).toEqual(list);
      await api.lists.update({ ...list, name: "Komitee", manual: [], groupIds: [] });
      expect(await api.lists.get(A, list.id)).toMatchObject({
        name: "Komitee",
        manual: [],
        groupIds: [],
      });
      expect((await api.lists.list(A, userA)).map((l) => l.id)).toContain(list.id);
      expect(await api.lists.delete(A, list.id)).toBe(true);
      expect(await api.lists.delete(A, list.id)).toBe(false);
    });
  });

  describe("Mandantentrennung und Eingaben", () => {
    it("ein anderer Mandant sieht und ändert nichts", async () => {
      const { acc, c } = await queued(2);
      expect(await api.accounts.get(B, acc.id)).toBeNull();
      expect(await api.accounts.delete(B, acc.id)).toBe(false);
      expect(await api.campaigns.get(B, c.id)).toBeNull();
      expect(await api.campaigns.counts(B, c.id)).toMatchObject({ queued: 0, sent: 0 });
      expect(await api.campaigns.listDeliveries(B, c.id, 0, 10)).toEqual([]);
      expect(await api.campaigns.cancel(B, c.id)).toBe(false);
      expect(await api.campaigns.confirm(B, c.id, NOW)).toBe(false);
      expect((await api.campaigns.counts(A, c.id)).queued).toBe(2);
    });

    it("Zeilen eines fremden Mandanten lassen sich nicht anlegen (RLS WITH CHECK)", async () => {
      // Mandant A schreibt eine Zeile mit kunde_id B an der Adapter-Logik vorbei: die Datenbank weist sie ab.
      await expect(
        appDb.withKunde(A, (trx) =>
          trx
            .insertInto("mail_konto")
            .values({
              id: randomUUID(),
              kunde_id: B,
              benutzer_id: userB,
              bezeichnung: "x",
              absender_adresse: "x@example.test",
              absender_name: null,
              benutzername: "u",
              geheimnis_enc: "k1:x",
              smtp_host: "h",
              smtp_port: 25,
              smtp_sicherheit: "tls",
              imap_host: null,
              imap_port: null,
              imap_sicherheit: null,
              erstellt_am: NOW,
            })
            .execute(),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("Kennungen, die keine UUID sind, ergeben «nicht gefunden» statt eines Fehlers", async () => {
      for (const id of ["abc", "../x", "", "1".repeat(64)]) {
        expect(await api.accounts.get(A, id)).toBeNull();
        expect(await api.attachments.get(A, id)).toBeNull();
        expect(await api.lists.get(A, id)).toBeNull();
        expect(await api.campaigns.get(A, id)).toBeNull();
        expect(await api.campaigns.confirm(A, id, NOW)).toBe(false);
        expect(await api.campaigns.cancel(A, id)).toBe(false);
        expect(await api.accounts.delete(A, id)).toBe(false);
        expect(await api.lists.delete(A, id)).toBe(false);
        expect((await api.campaigns.counts(A, id)).queued).toBe(0);
        expect(await worker.accounts.get(A, id)).toBeNull();
        expect(await worker.attachments.get(A, id)).toBeNull();
      }
    });
  });

  describe("Bestätigen und Abbrechen", () => {
    const held = async () => {
      const acc = account();
      await api.accounts.insert(acc);
      const c = campaign(acc, {
        state: "awaiting_confirmation",
        confirmedAt: undefined,
        recipientCount: 3,
        confirmation: { tokenHash: "b".repeat(64), expiresAt: later(60_000) },
      });
      await api.campaigns.create(
        c,
        [1, 2, 3].map(() => delivery(c, { status: "held" })),
      );
      return c;
    };

    it("confirm gibt die Zustellungen frei, verbraucht das Token und gelingt nur einmal", async () => {
      const c = await held();
      expect((await api.campaigns.counts(A, c.id)).held).toBe(3);
      expect(await worker.campaigns.listDue(later(1000), 50)).not.toContainEqual(
        expect.objectContaining({ campaignId: c.id }),
      );

      const results = await Promise.all([
        api.campaigns.confirm(A, c.id, later(5)),
        api.campaigns.confirm(A, c.id, later(5)),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);

      const got = await api.campaigns.get(A, c.id);
      expect(got).toMatchObject({ state: "confirmed", confirmedAt: later(5) });
      expect(got?.confirmation).toBeUndefined();
      expect(await api.campaigns.counts(A, c.id)).toMatchObject({ held: 0, queued: 3 });
    });

    it("cancel bricht held und queued ab, lässt Laufendes und Fertiges stehen", async () => {
      const { c, ds } = await queued(3);
      await worker.campaigns.claim(ds[0]!.id, NOW, later(60_000));
      expect(await api.campaigns.cancel(A, c.id)).toBe(true);
      expect(await api.campaigns.counts(A, c.id)).toMatchObject({
        sending: 1,
        cancelled: 2,
        queued: 0,
      });
      expect((await api.campaigns.get(A, c.id))?.state).toBe("cancelled");
      expect(await api.campaigns.cancel(A, c.id)).toBe(false);
      // Abgebrochene Zustellungen werden nicht mehr übernommen.
      expect(await worker.campaigns.claim(ds[1]!.id, later(10), later(60_000))).toBeNull();
    });

    it("die Datenbank verbietet ein stehengebliebenes Token nach der Bestätigung", async () => {
      const c = await held();
      await expect(
        appDb.withKunde(A, (trx) =>
          trx
            .updateTable("mail_kampagne")
            .set({ status: "confirmed" })
            .where("id", "=", c.id)
            .execute(),
        ),
      ).rejects.toThrow(/check constraint/);
    });
  });

  describe("Versandqueue (Worker)", () => {
    it("listDue liefert fällige queued-Zustellungen, nicht zukünftige, in Reihenfolge", async () => {
      const acc = account();
      await api.accounts.insert(acc);
      const c = campaign(acc, { recipientCount: 3 });
      const soon = delivery(c, { nextAttemptAt: later(-2000) });
      const first = delivery(c, { nextAttemptAt: later(-5000) });
      const future = delivery(c, { nextAttemptAt: later(3_600_000) });
      await api.campaigns.create(c, [soon, future, first]);

      const due = (await worker.campaigns.listDue(NOW, 100)).filter((d) => d.campaignId === c.id);
      expect(due.map((d) => d.id)).toEqual([first.id, soon.id]);
      expect(due[0]).toMatchObject({ tenantId: A, status: "queued", attempts: 0 });
      expect(await worker.campaigns.listDue(NOW, 0)).toEqual([]);
    });

    it("claim ist atomar: bei gleichzeitigem Zugriff gewinnt genau einer", async () => {
      const { ds } = await queued(1);
      const id = ds[0]!.id;
      const results = await Promise.all(
        [1, 2, 3, 4].map(() => worker.campaigns.claim(id, NOW, later(60_000))),
      );
      const won = results.filter((r) => r !== null);
      expect(won).toHaveLength(1);
      expect(won[0]).toMatchObject({ status: "sending", attempts: 1, leaseUntil: later(60_000) });
    });

    it("eine verwaiste Sperre wird nach Ablauf neu aufgenommen, vorher nicht", async () => {
      const { ds } = await queued(1);
      const id = ds[0]!.id;
      await worker.campaigns.claim(id, NOW, later(60_000));
      expect(await worker.campaigns.claim(id, later(30_000), later(90_000))).toBeNull();
      const again = await worker.campaigns.claim(id, later(61_000), later(121_000));
      expect(again).toMatchObject({ status: "sending", attempts: 2 });
      expect((await worker.campaigns.listDue(later(61_500), 100)).map((d) => d.id)).not.toContain(
        id,
      );
    });

    it("finish: Erfolg, Wiederholung mit Fehlercode und Endgültig; wirkt nur auf Übernommenes", async () => {
      const { c, ds } = await queued(3);
      const [ok, retry, bad] = ds as [Delivery, Delivery, Delivery];
      for (const d of ds) await worker.campaigns.claim(d.id, NOW, later(60_000));

      await worker.campaigns.finish(ok.id, {
        status: "sent",
        sentAt: later(500),
        messageId: "<m1@test>",
      });
      await worker.campaigns.finish(retry.id, {
        status: "queued",
        lastError: "CONNECT",
        nextAttemptAt: later(120_000),
      });
      await worker.campaigns.finish(bad.id, { status: "failed", lastError: "AUTH" });
      // Ein zweites finish auf schon Abgeschlossenes ändert nichts.
      await worker.campaigns.finish(ok.id, { status: "failed", lastError: "INTERNAL" });

      const rows = await api.campaigns.listDeliveries(A, c.id, 0, 10);
      const by = (id: string) => rows.find((r) => r.id === id);
      expect(by(ok.id)).toMatchObject({
        status: "sent",
        sentAt: later(500),
        messageId: "<m1@test>",
        leaseUntil: undefined,
        lastError: undefined,
      });
      expect(by(retry.id)).toMatchObject({
        status: "queued",
        lastError: "CONNECT",
        nextAttemptAt: later(120_000),
        attempts: 1,
      });
      expect(by(bad.id)).toMatchObject({ status: "failed", lastError: "AUTH" });
      expect(await api.campaigns.counts(A, c.id)).toMatchObject({ sent: 1, queued: 1, failed: 1 });
    });

    it("countSentSince zählt je Mandant und Zeitfenster", async () => {
      const far = new Date("2030-01-01T00:00:00Z");
      const acc = account();
      await api.accounts.insert(acc);
      const c = campaign(acc, { recipientCount: 2 });
      const [d1, d2] = [delivery(c), delivery(c)] as [Delivery, Delivery];
      await api.campaigns.create(c, [d1, d2]);
      for (const d of [d1, d2]) await worker.campaigns.claim(d.id, NOW, later(60_000));
      await worker.campaigns.finish(d1.id, {
        status: "sent",
        sentAt: new Date(far.getTime() + 1000),
      });
      await worker.campaigns.finish(d2.id, {
        status: "sent",
        sentAt: new Date(far.getTime() - 120_000),
      });

      expect(await worker.campaigns.countSentSince(A, new Date(far.getTime() - 60_000))).toBe(1);
      expect(await worker.campaigns.countSentSince(A, new Date(far.getTime() - 300_000))).toBe(2);
      expect(await worker.campaigns.countSentSince(B, new Date(far.getTime() - 300_000))).toBe(0);
    });

    it("getById liefert die Kampagne ohne Bestätigungs-Token; Konto nur mit passendem Mandanten", async () => {
      const acc = account();
      await api.accounts.insert(acc);
      const c = campaign(acc, {
        state: "awaiting_confirmation",
        confirmedAt: undefined,
        confirmation: { tokenHash: "c".repeat(64), expiresAt: later(1000) },
      });
      await api.campaigns.create(c, [delivery(c, { status: "held" })]);

      const got = await worker.campaigns.getById(c.id);
      expect(got).toMatchObject({
        id: c.id,
        tenantId: A,
        accountId: acc.id,
        state: "awaiting_confirmation",
      });
      expect(got?.confirmation).toBeUndefined();
      expect(await worker.campaigns.getById(randomUUID())).toBeNull();

      expect(await worker.accounts.get(A, acc.id)).toEqual(acc);
      expect(await worker.accounts.get(B, acc.id)).toBeNull();
    });

    it("eine grosse Kampagne wird in Blöcken angelegt", async () => {
      const acc = account();
      await api.accounts.insert(acc);
      const c = campaign(acc, { recipientCount: 1203 });
      await api.campaigns.create(
        c,
        Array.from({ length: 1203 }, () => delivery(c)),
      );
      expect((await api.campaigns.counts(A, c.id)).queued).toBe(1203);
      expect(await api.campaigns.listDeliveries(A, c.id, 1200, 10)).toHaveLength(3);
    });
  });

  describe("Rechte", () => {
    it("die API-Rolle kann die Worker-Funktionen nicht aufrufen", async () => {
      await expect(api.campaigns.listDue(NOW, 10)).rejects.toThrow(/permission denied/);
      await expect(api.campaigns.claim(randomUUID(), NOW, NOW)).rejects.toThrow(
        /permission denied/,
      );
      await expect(api.campaigns.getById(randomUUID())).rejects.toThrow(/permission denied/);
      await expect(api.campaigns.countSentSince(A, NOW)).rejects.toThrow(/permission denied/);
    });

    it("die Worker-Rolle hat keine Tabellenrechte und kann Tabellen weder lesen noch ändern", async () => {
      for (const table of ["mail_konto", "mail_anhang", "mail_kampagne", "mail_zustellung"]) {
        await expect(
          workerDb.withKunde(A, (trx) =>
            trx
              .selectFrom(table as "mail_konto")
              .selectAll()
              .execute(),
          ),
        ).rejects.toThrow(/permission denied/);
      }
    });

    it("die API ändert an einer Zustellung nur den Status und löscht keine Kampagnen", async () => {
      const { c, ds } = await queued(1);
      await expect(
        appDb.withKunde(A, (trx) =>
          trx
            .updateTable("mail_zustellung")
            .set({ empfaenger: JSON.stringify({ email: "boese@example.test" }) })
            .where("id", "=", ds[0]!.id)
            .execute(),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        appDb.withKunde(A, (trx) =>
          trx.deleteFrom("mail_kampagne").where("id", "=", c.id).execute(),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it("die Schlüsselrotation über alle Mandanten ist der API verwehrt (nur Worker)", async () => {
      await expect(api.accounts.listForRotation("k2", null, 10)).rejects.toThrow(
        /permission denied/,
      );
      await expect(api.accounts.replaceSecret(A, randomUUID(), "x", "y")).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        sql`SELECT plattform_protokoll_vom_worker(gen_random_uuid(), now(), 'mail.rotate-secrets', '')`.execute(
          appDb.kysely,
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe("API und Worker teilen den Stand", () => {
    const password = "app-passwort";
    const box = newBox();

    // Der Worker arbeitet die ganze Queue ab: Reste der Tests oben (Konten mit Fantasie-Chiffretext) würden stören.
    beforeAll(async () => {
      await owner.query("DELETE FROM mail_kampagne");
    });

    /** Die Verbindung sieht das entschlüsselte Passwort, so wie der echte SMTP-Aufbau. */
    function recordingConnections() {
      const fake = fakeConnections();
      const seen: string[] = [];
      const factory: ConnectionFactory = {
        ...fake.factory,
        smtp: async (acc, pw) => {
          seen.push(pw);
          return fake.factory.smtp(acc, pw);
        },
      };
      return { factory, state: fake.state, seen };
    }

    const newService = (connections: ConnectionFactory) =>
      new MailService({ repos: api, box, connections, now: () => NOW });

    it("Einzelmail: die API legt sie an, der Worker stellt sie zu, die API sieht das Ergebnis", async () => {
      const conn = recordingConnections();
      const service = newService(conn.factory);
      const acc = await service.addAccount(ctxA, {
        label: "Verein",
        fromAddress: "verein@example.test",
        username: "user",
        password,
        smtp: endpoint,
      });

      const { campaignId } = await service.sendTransactional(ctxA, {
        accountId: acc.id,
        to: { email: "anna@example.test", vorname: "Anna" },
        subject: "Hallo {{vorname}}",
        bodyHtml: "<p>Guten Tag {{vorname}}</p>",
      });
      expect((await service.getCampaignStatus(ctxA, campaignId)).counts.queued).toBe(1);

      const result = await processDueDeliveries(
        { repos: worker, box, connections: conn.factory, now: () => NOW },
        undefined,
      );
      expect(result).toMatchObject({ sent: 1, failed: 0, retried: 0 });
      expect(conn.seen).toEqual([password]);
      expect(conn.state.sent[0]).toMatchObject({
        subject: "Hallo Anna",
        to: [{ address: "anna@example.test" }],
      });

      const status = await service.getCampaignStatus(ctxA, campaignId);
      expect(status.counts).toMatchObject({ sent: 1, queued: 0, failed: 0 });
      const [d] = await service.listDeliveries(ctxA, campaignId, 0, 10);
      expect(d).toMatchObject({ status: "sent", attempts: 1, lastError: null });
      expect(d?.sentAt).toEqual(NOW);
    });

    it("Kampagne: ohne Bestätigung geht nichts raus, danach alles; ein Fehler wird wiederholt", async () => {
      const conn = recordingConnections();
      const service = newService(conn.factory);
      const acc = await service.addAccount(ctxA, {
        label: "Verein",
        fromAddress: "verein@example.test",
        username: "user",
        password,
        smtp: endpoint,
      });
      const prepared = await service.prepareCampaign(ctxA, {
        accountId: acc.id,
        subject: "Rundbrief",
        bodyHtml: "<p>Hallo {{vorname}}</p>",
        manual: ["a", "b", "c"].map((n) => ({ email: `${n}@example.test`, vorname: n })),
      });
      const deps = { repos: worker, box, connections: conn.factory };

      const idle = await processDueDeliveries({ ...deps, now: () => NOW });
      expect(idle).toMatchObject({ sent: 0, retried: 0, failed: 0 });
      expect(conn.state.sent).toHaveLength(0);

      await service.confirmCampaign(ctxA, prepared.campaignId, prepared.confirmationToken!);
      // Zweites Bestätigen mit demselben Token scheitert (Token ist einmalig).
      await expect(
        service.confirmCampaign(ctxA, prepared.campaignId, prepared.confirmationToken!),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      conn.state.smtpFailures.push(Object.assign(new Error("421"), { responseCode: 421 }));
      const run = await processDueDeliveries({ ...deps, now: () => NOW, random: () => 0.5 });
      expect(run).toMatchObject({ sent: 2, retried: 1, failed: 0 });

      // Nach dem Backoff geht auch die dritte Mail raus.
      const retry = await processDueDeliveries({
        ...deps,
        now: () => later(24 * 3_600_000),
        random: () => 0.5,
      });
      expect(retry).toMatchObject({ sent: 1, retried: 0 });
      expect((await service.getCampaignStatus(ctxA, prepared.campaignId)).counts.sent).toBe(3);
    });
  });

  describe("Schlüsselrotation über alle Mandanten (Worker)", () => {
    const { oldBox, ringBox, otherBox } = rotationBoxes();
    const service = () =>
      new MailService({ repos: worker, box: ringBox, connections: fakeConnections().factory });
    const mine = (n: number, tenantId: string, ownerUserId: string, box = oldBox) =>
      accountWith(box, { id: randomUUID(), tenantId, ownerUserId }, `pw-${n}`);
    const stored = async (a: MailAccount) => {
      const s = (await api.accounts.get(a.tenantId, a.id))!;
      return [s.secretEnc.split(".")[1], ringBox.decrypt(s.secretEnc, a.id)];
    };

    // Reste der anderen Tests (Fantasie-Chiffretext) würden als Fehler zählen.
    beforeAll(async () => {
      await owner.query("DELETE FROM mail_kampagne");
      await owner.query("DELETE FROM mail_konto");
    });

    it("schlüsselt Konten mehrerer Mandanten um, einmalig, Mandant und Daten bleiben", async () => {
      const accounts = [
        mine(1, A, userA),
        mine(2, B, userB),
        mine(3, A, userA2),
        mine(4, B, userB),
      ];
      for (const a of accounts) await api.accounts.insert(a);
      expect(await service().rotateSecrets()).toEqual({ rotated: 4, failed: [], aborted: false });
      for (const [i, a] of accounts.entries()) {
        expect(await stored(a)).toEqual(["k2", `pw-${i + 1}`]);
        // Mandant und Eigentümer unverändert; fremder Mandant sieht das Konto weiterhin nicht.
        expect(await api.accounts.get(a.tenantId, a.id)).toMatchObject({
          tenantId: a.tenantId,
          ownerUserId: a.ownerUserId,
        });
        expect(await api.accounts.get(a.tenantId === A ? B : A, a.id)).toBeNull();
      }
      expect(await service().rotateSecrets()).toEqual({ rotated: 0, failed: [], aborted: false });
    });

    it("Abbruch mitten im Lauf: nichts geht verloren, der nächste Lauf setzt fort", async () => {
      const accounts = [1, 2, 3, 4, 5].map((n) => mine(n, n % 2 ? A : B, n % 2 ? userA : userB));
      for (const a of accounts) await api.accounts.insert(a);
      const controller = new AbortController();
      const abortAfterFirst: MailRepositories = {
        ...worker,
        accounts: Object.assign(Object.create(worker.accounts) as MailRepositories["accounts"], {
          replaceSecret: async (
            ...args: Parameters<MailRepositories["accounts"]["replaceSecret"]>
          ) => {
            const ok = await worker.accounts.replaceSecret(...args);
            controller.abort();
            return ok;
          },
        }),
      };
      const partial = await new MailService({
        repos: abortAfterFirst,
        box: ringBox,
        connections: fakeConnections().factory,
      }).rotateSecrets(controller.signal);
      expect(partial).toEqual({ rotated: 1, failed: [], aborted: true });
      const mixed = await Promise.all(accounts.map(stored));
      expect(mixed.map(([, pw]) => pw)).toEqual(["pw-1", "pw-2", "pw-3", "pw-4", "pw-5"]);
      expect(mixed.filter(([k]) => k === "k2")).toHaveLength(1);

      expect((await service().rotateSecrets()).rotated).toBe(4);
      expect((await Promise.all(accounts.map(stored))).map(([k]) => k)).toEqual(
        Array(5).fill("k2"),
      );
    });

    it("ein unlesbares Konto steht nur als ID in der Antwort und hält die anderen nicht auf", async () => {
      const ok = mine(6, A, userA);
      const lost = mine(7, B, userB, otherBox);
      await api.accounts.insert(ok);
      await api.accounts.insert(lost);
      const result = await service().rotateSecrets();
      expect(result).toEqual({ rotated: 1, failed: [lost.id], aborted: false });
      expect(JSON.stringify(result)).not.toContain("pw-7");
      expect((await api.accounts.get(B, lost.id))?.secretEnc).toBe(lost.secretEnc);
      await owner.query("DELETE FROM mail_konto WHERE id = $1", [lost.id]);
    });

    it("überschreibt keine gleichzeitige Änderung des Benutzers (Compare-and-swap)", async () => {
      const a = mine(8, A, userA);
      await api.accounts.insert(a);
      const read = (await worker.accounts.listForRotation("k2", null, 10)).find(
        (x) => x.id === a.id,
      )!;
      // Der Benutzer ändert das Passwort, nachdem der Worker gelesen hat.
      await api.accounts.update({ ...read, secretEnc: ringBox.encrypt("neu", a.id) });
      expect(
        await worker.accounts.replaceSecret(
          A,
          a.id,
          read.secretEnc,
          ringBox.rotate(read.secretEnc, a.id),
        ),
      ).toBe(false);
      expect(ringBox.decrypt((await api.accounts.get(A, a.id))!.secretEnc, a.id)).toBe("neu");
      // Falscher Mandant ersetzt nichts.
      expect(await worker.accounts.replaceSecret(B, a.id, "x", "y")).toBe(false);
    });

    it("der Worker schreibt einen Eintrag ins Plattformprotokoll, aber nur diese Aktion", async () => {
      await workerDb.protokolliereSchluesselrotation(NOW, "umgeschlüsselt 4, fehlgeschlagen 0");
      const { rows } = await owner.query(
        "SELECT akteur, aktion, ziel FROM plattform_protokoll WHERE aktion = 'mail.rotate-secrets'",
      );
      expect(rows).toEqual([
        {
          akteur: "worker",
          aktion: "mail.rotate-secrets",
          ziel: "umgeschlüsselt 4, fehlgeschlagen 0",
        },
      ]);
      await expect(
        sql`SELECT plattform_protokoll_vom_worker(gen_random_uuid(), now(), 'customer.create', 'X')`.execute(
          workerDb.kysely,
        ),
      ).rejects.toThrow(/darf diese Aktion nicht/);
    });
  });
});
