import { Datenbank } from "@stammbuch/db";
import { createTestDatabase, withCredentials } from "@stammbuch/db/testing";
import { sql } from "kysely";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { SecretBox, totpBoxFromEnv } from "./crypto.js";
import { createPostgresMailRepositories } from "./postgres.js";
import {
  pgRotationSource,
  readRotationState,
  recordRotationState,
  recordRotationStateAsChef,
  rotateAll,
} from "./rotation.js";
import type { RotationKind } from "./rotation.js";
import { accountWith } from "./test-helpers.js";

/**
 * Schlüsselrotation der TOTP-Geheimnisse (Worker) und Auslösen durch den Chef-Admin (API) gegen echtes PostgreSQL.
 * Die Mail-Rotation durch den Worker deckt postgres.pg.test.ts ab.
 */

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const P = "33333333-3333-4333-8333-333333333333"; // Anbieter
const chefId = "cccccccc-0000-4000-8000-000000000001";
const userA = "aaaaaaaa-0000-4000-8000-000000000001";
const userB = "bbbbbbbb-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-05T10:00:00.000Z");
const DAY = 24 * 3_600_000;

const k = (n: number) => Buffer.alloc(32, n);
const main = k(1);
const envFor = (keys?: string, id?: string) => ({
  AUTH_TOTP_KEY: main.toString("base64"),
  ...(keys ? { AUTH_TOTP_KEYS: keys } : {}),
  ...(id ? { AUTH_TOTP_KEY_ID: id } : {}),
});
/** Ring nach der Rotation: k1 (alt) und k2 (aktuell); Altformat bleibt mit dem Hauptschlüssel lesbar. */
const ringBox = totpBoxFromEnv(
  envFor(`k1:${k(5).toString("base64")},k2:${k(2).toString("base64")}`),
);
const k1Box = totpBoxFromEnv(envFor(`k1:${k(5).toString("base64")}`));
/** Ein Ring ohne Hauptschlüssel-Ableitung: Geheimnisse aus k9 lassen sich hier nicht lesen. */
const otherBox = new SecretBox({ keys: { k9: k(9).toString("base64") }, currentKeyId: "k9" });
const secret = (n: number) => Buffer.alloc(20, n);

/** Altformat vor dem Schlüsselring: `v1.<iv>.<tag>.<ct>` mit dem Hauptschlüssel. */
function legacyToken(aad: string, plain: Buffer) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", main, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return ["v1", iv, c.getAuthTag(), ct]
    .map((p) => (Buffer.isBuffer(p) ? p.toString("base64url") : p))
    .join(".");
}

describe("Schlüsselrotation: TOTP (Worker) und Chef-Admin (API) gegen PostgreSQL", () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let owner: pg.Client;
  let appDb: Datenbank;
  let workerDb: Datenbank;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject("adminUrl"), inject("templateDb"));
    owner = new pg.Client({ connectionString: testDb.adminUrl });
    await owner.connect();
    await owner.query(
      `INSERT INTO kunde (id, name) VALUES ('${A}', 'A'), ('${B}', 'B'), ('${P}', 'Anbieter')`,
    );
    await owner.query(
      `INSERT INTO benutzer (id, kunde_id, email, name, passwort_hash, rolle) VALUES
        ('${userA}', '${A}', 'a@example.test', 'A', 'h', 'user'),
        ('${userB}', '${B}', 'b@example.test', 'B', 'h', 'user'),
        ('${chefId}', '${P}', 'chef@example.test', 'Chef', 'h', 'chief_admin')`,
    );
    appDb = new Datenbank(
      withCredentials(testDb.adminUrl, "stammbuch_app", inject("appPassword")),
      {
        max: 4,
      },
    );
    workerDb = new Datenbank(
      withCredentials(testDb.adminUrl, "stammbuch_worker", inject("workerPassword")),
      { max: 4 },
    );
  });

  afterAll(async () => {
    await appDb?.close();
    await workerDb?.close();
    await owner?.end();
    await testDb?.drop();
  });

  /** Benutzer mit eingerichtetem TOTP; `enc` ist der gespeicherte Chiffretext. */
  async function totpUser(tenant: string, enc: (id: string) => string) {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO benutzer (id, kunde_id, email, name, passwort_hash, totp_secret_enc, totp_letzter_zaehler, totp_eingerichtet_am)
       VALUES ($1, $2, $3, 'T', 'h', $4, 0, now())`,
      [id, tenant, `${id}@example.test`, enc(id)],
    );
    return id;
  }
  const stored = async (id: string) =>
    (
      await owner.query<{ totp_secret_enc: string }>(
        "SELECT totp_secret_enc FROM benutzer WHERE id = $1",
        [id],
      )
    ).rows[0]!.totp_secret_enc;
  const keyOf = async (id: string) => (await stored(id)).split(".")[1];

  beforeEach(async () => {
    await owner.query("DELETE FROM benutzer WHERE totp_secret_enc IS NOT NULL");
    await owner.query("DELETE FROM mail_konto");
    await owner.query("DELETE FROM schluesselrotation_stand");
    await owner.query("DELETE FROM plattform_protokoll");
  });

  describe("Worker: TOTP-Geheimnisse aller Mandanten", () => {
    const worker = () => pgRotationSource(workerDb, "totp", null);

    it("schlüsselt Altformat und alten Schlüssel um, einmalig, Geheimnis, Mandant und Zähler bleiben", async () => {
      const ids = [
        await totpUser(A, (id) => legacyToken(id, secret(1))),
        await totpUser(B, (id) => ringBox.encryptBytes(secret(2), id)),
        await totpUser(A, (id) => k1Box.encryptBytes(secret(3), id)),
        await totpUser(B, (id) => legacyToken(id, secret(4))),
      ];
      expect(await rotateAll(ringBox, worker())).toEqual({
        rotated: 3,
        failed: [],
        aborted: false,
      });
      for (const [i, id] of ids.entries()) {
        expect(await keyOf(id)).toBe("k2");
        expect(ringBox.decryptBytes(await stored(id), id).equals(secret(i + 1))).toBe(true);
      }
      const { rows } = await owner.query(
        "SELECT kunde_id, totp_letzter_zaehler FROM benutzer WHERE id = $1",
        [ids[1]],
      );
      expect(rows).toEqual([{ kunde_id: B, totp_letzter_zaehler: "0" }]);
      expect(await rotateAll(ringBox, worker())).toEqual({
        rotated: 0,
        failed: [],
        aborted: false,
      });
    });

    it("liest Altformat und neuen Schlüssel auch bei mehr als einer Seite", async () => {
      for (let i = 0; i < 205; i++)
        await totpUser(i % 2 ? A : B, (id) => legacyToken(id, secret(7)));
      expect((await rotateAll(ringBox, worker())).rotated).toBe(205);
      const { rows } = await owner.query(
        "SELECT count(*)::int AS n FROM benutzer WHERE totp_secret_enc LIKE 'v1.k2.%'",
      );
      expect(rows[0].n).toBe(205);
    });

    it("Abbruch mitten im Lauf: nichts geht verloren, der nächste Lauf setzt fort", async () => {
      const ids: string[] = [];
      for (let i = 1; i <= 5; i++)
        ids.push(await totpUser(i % 2 ? A : B, (id) => legacyToken(id, secret(i))));
      const controller = new AbortController();
      const src = worker();
      const abortAfterFirst = {
        ...src,
        replace: async (...args: Parameters<typeof src.replace>) => {
          const ok = await src.replace(...args);
          controller.abort();
          return ok;
        },
      };
      expect(await rotateAll(ringBox, abortAfterFirst, controller.signal)).toEqual({
        rotated: 1,
        failed: [],
        aborted: true,
      });
      const mixed = await Promise.all(
        ids.map(async (id) => ringBox.decryptBytes(await stored(id), id)),
      );
      expect(mixed.map((b) => b[0])).toEqual([1, 2, 3, 4, 5]);
      expect((await Promise.all(ids.map(keyOf))).filter((x) => x === "k2")).toHaveLength(1);
      expect((await rotateAll(ringBox, worker())).rotated).toBe(4);
      expect(await Promise.all(ids.map(keyOf))).toEqual(Array(5).fill("k2"));
    });

    it("ein unlesbares Geheimnis steht nur als ID in der Antwort und hält die anderen nicht auf", async () => {
      const ok = await totpUser(A, (id) => legacyToken(id, secret(1)));
      const lost = await totpUser(B, (id) => otherBox.encryptBytes(secret(2), id));
      const result = await rotateAll(ringBox, worker());
      expect(result).toEqual({ rotated: 1, failed: [lost], aborted: false });
      expect(JSON.stringify(result)).not.toContain(secret(2).toString("base64"));
      expect(await keyOf(ok)).toBe("k2");
      expect(await keyOf(lost)).toBe("k9");
    });

    it("überschreibt keine gleichzeitige Neueinrichtung (Compare-and-swap) und prüft den Mandanten", async () => {
      const id = await totpUser(A, (u) => legacyToken(u, secret(1)));
      const read = (await worker().list("k2", null, 10)).find((r) => r.id === id)!;
      // Der Benutzer richtet TOTP neu ein, nachdem der Worker gelesen hat.
      const neu = ringBox.encryptBytes(secret(9), id);
      await owner.query("UPDATE benutzer SET totp_secret_enc = $2 WHERE id = $1", [id, neu]);
      expect(await worker().replace(A, id, read.enc, ringBox.rotate(read.enc, id))).toBe(false);
      expect(await stored(id)).toBe(neu);
      // Falscher Mandant ersetzt nichts.
      expect(await worker().replace(B, id, neu, "x")).toBe(false);
    });

    it("kennt kein TOTP-Geheimnis ohne Einrichtung und lässt Pending-Geheimnisse der Sitzung in Ruhe", async () => {
      await owner.query(
        `INSERT INTO benutzer (id, kunde_id, email, name, passwort_hash) VALUES ($1, $2, 'x@example.test', 'X', 'h')`,
        [randomUUID(), A],
      );
      expect(await worker().list("k2", null, 10)).toEqual([]);
    });
  });

  describe("Stand ohne Dopplung", () => {
    const u1 = randomUUID();
    const u2 = randomUUID();

    it("meldet nur bei geänderter Menge oder einmal täglich, die Behebung einmal", async () => {
      const record = (at: Date, ids: string[]) => recordRotationState(workerDb, "totp", at, ids);
      expect(await record(NOW, [])).toBe(false); // nichts unlesbar, nichts zu melden
      expect(await record(NOW, [u1])).toBe(true); // neu
      expect(await record(new Date(NOW.getTime() + 3_600_000), [u1])).toBe(false); // stündliche Wiederholung
      expect(await record(new Date(NOW.getTime() + 23 * 3_600_000), [u1])).toBe(false);
      expect(await record(new Date(NOW.getTime() + DAY), [u1])).toBe(true); // einmal täglich
      expect(await record(new Date(NOW.getTime() + DAY + 3_600_000), [u1])).toBe(false);
      expect(await record(new Date(NOW.getTime() + DAY + 7_200_000), [u2, u1])).toBe(true); // Menge geändert
      expect(await record(new Date(NOW.getTime() + DAY + 8_000_000), [u1, u2, u1])).toBe(false); // Reihenfolge, Duplikate egal
      expect(await record(new Date(NOW.getTime() + 2 * DAY), [])).toBe(true); // behoben
      expect(await record(new Date(NOW.getTime() + 2 * DAY + 3_600_000), [])).toBe(false);
    });

    it("trennt die Arten", async () => {
      expect(await recordRotationState(workerDb, "mail", NOW, [u1])).toBe(true);
      expect(await recordRotationState(workerDb, "totp", NOW, [u1])).toBe(true);
      expect(await recordRotationState(workerDb, "mail", NOW, [u1])).toBe(false);
    });

    it("lehnt unbekannte Arten ab", async () => {
      await expect(
        recordRotationState(workerDb, "passwort" as RotationKind, NOW, []),
      ).rejects.toThrow(/schluesselrotation_stand_art_check|check constraint/i);
    });
  });

  describe("Chef-Admin: Rotation über die API-Rolle", () => {
    const chefSource = (kind: RotationKind, actor: string = chefId) =>
      pgRotationSource(appDb, kind, actor);
    const mail = (n: number, tenant: string, owner_: string) =>
      accountWith(
        legacyMailBox,
        { id: randomUUID(), tenantId: tenant, ownerUserId: owner_ },
        `pw-${n}`,
      );
    const legacyMailBox = new SecretBox({
      keys: { k1: k(1).toString("base64") },
      currentKeyId: "k1",
    });
    const mailRing = new SecretBox({
      keys: { k1: k(1).toString("base64"), k2: k(2).toString("base64") },
      currentKeyId: "k2",
    });

    it("rotiert Mail-Zugangsdaten und TOTP-Geheimnisse mehrerer Mandanten, der Chef-Admin sieht keinen Klartext", async () => {
      const repos = createPostgresMailRepositories(appDb);
      const accounts = [mail(1, A, userA), mail(2, B, userB)];
      for (const a of accounts) await repos.accounts.insert(a);
      const totp = [
        await totpUser(A, (id) => legacyToken(id, secret(1))),
        await totpUser(B, (id) => legacyToken(id, secret(2))),
      ];
      const mailResult = await rotateAll(mailRing, chefSource("mail"));
      const totpResult = await rotateAll(ringBox, chefSource("totp"));
      expect(mailResult).toEqual({ rotated: 2, failed: [], aborted: false });
      expect(totpResult).toEqual({ rotated: 2, failed: [], aborted: false });
      expect(JSON.stringify([mailResult, totpResult])).not.toMatch(/pw-|base64/);
      for (const [i, a] of accounts.entries()) {
        const s = (await repos.accounts.get(a.tenantId, a.id))!;
        expect(mailRing.decrypt(s.secretEnc, a.id)).toBe(`pw-${i + 1}`);
        expect(s.secretEnc.split(".")[1]).toBe("k2");
      }
      for (const [i, id] of totp.entries()) {
        expect(ringBox.decryptBytes(await stored(id), id).equals(secret(i + 1))).toBe(true);
      }
      // Zweiter Lauf: nichts mehr zu tun.
      expect((await rotateAll(ringBox, chefSource("totp"))).rotated).toBe(0);
    });

    it("hält Stand fest und zeigt unlesbare Objekte nur dem Chef-Admin", async () => {
      const lost = await totpUser(B, (id) => otherBox.encryptBytes(secret(2), id));
      const result = await rotateAll(ringBox, chefSource("totp"));
      expect(result.failed).toEqual([lost]);
      await recordRotationStateAsChef(appDb, chefId, "totp", NOW, result.failed);
      expect(await readRotationState(appDb, chefId)).toEqual([
        { kind: "totp", ranAt: NOW, unreadable: [lost] },
      ]);
      // Ein Kundenbenutzer (oder eine unbekannte ID) als Akteur: keine Zeilen, Schreiben verweigert.
      for (const actor of [userA, randomUUID()]) {
        expect(await readRotationState(appDb, actor)).toEqual([]);
        await expect(recordRotationStateAsChef(appDb, actor, "totp", NOW, [])).rejects.toThrow(
          /Nur der Chef-Admin/,
        );
      }
    });

    it("ohne Chef-Admin als Akteur gibt es weder Daten noch Schreibrechte", async () => {
      const id = await totpUser(A, (u) => legacyToken(u, secret(1)));
      const acc = mail(1, A, userA);
      await createPostgresMailRepositories(appDb).accounts.insert(acc);
      for (const actor of [userA, randomUUID(), "00000000-0000-0000-0000-000000000000"]) {
        for (const kind of ["mail", "totp"] as const) {
          const src = chefSource(kind, actor);
          expect(await src.list("k2", null, 10)).toEqual([]);
          await expect(src.replace(A, kind === "mail" ? acc.id : id, "x", "y")).rejects.toThrow(
            /Nur der Chef-Admin/,
          );
        }
      }
      expect(await keyOf(id)).not.toBe("k2");
    });

    it("die Chef-Funktionen sind dem Worker verwehrt, die Worker-Funktionen der API", async () => {
      const denied = /permission denied/;
      await expect(pgRotationSource(workerDb, "totp", chefId).list("k2", null, 10)).rejects.toThrow(
        denied,
      );
      await expect(pgRotationSource(workerDb, "mail", chefId).list("k2", null, 10)).rejects.toThrow(
        denied,
      );
      await expect(recordRotationStateAsChef(workerDb, chefId, "totp", NOW, [])).rejects.toThrow(
        denied,
      );
      await expect(readRotationState(workerDb, chefId)).rejects.toThrow(denied);
      await expect(pgRotationSource(appDb, "totp", null).list("k2", null, 10)).rejects.toThrow(
        denied,
      );
      await expect(
        pgRotationSource(appDb, "totp", null).replace(A, userA, "x", "y"),
      ).rejects.toThrow(denied);
      await expect(recordRotationState(appDb, "totp", NOW, [])).rejects.toThrow(denied);
    });

    it("die Stand-Tabelle ist für beide Rollen gesperrt", async () => {
      for (const db of [appDb, workerDb]) {
        await expect(
          sql`SELECT * FROM schluesselrotation_stand`.execute(db.kysely),
        ).rejects.toThrow(/permission denied/);
        await expect(
          sql`INSERT INTO schluesselrotation_stand (art, gelaufen_am) VALUES ('mail', now())`.execute(
            db.kysely,
          ),
        ).rejects.toThrow(/permission denied/);
      }
    });
  });

  describe("Plattformprotokoll des Workers", () => {
    it("erlaubt die TOTP-Rotation als feste Aktion, andere weiterhin nicht", async () => {
      await workerDb.protokolliereSchluesselrotation(
        NOW,
        "umgeschlüsselt 2, fehlgeschlagen 0",
        "auth.rotate-totp",
      );
      const { rows } = await owner.query("SELECT akteur, aktion, ziel FROM plattform_protokoll");
      expect(rows).toEqual([
        {
          akteur: "worker",
          aktion: "auth.rotate-totp",
          ziel: "umgeschlüsselt 2, fehlgeschlagen 0",
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
