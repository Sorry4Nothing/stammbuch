import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";
import type { Database as Db } from "@stammbuch/db";
import type { Datenbank } from "@stammbuch/db";
import type {
  AuditEvent,
  AuditRepo,
  InvitationRepo,
  PasswordResetRepo,
  Session,
  SessionRepo,
  ThrottleRepo,
  ThrottleState,
  User,
  UserRepo,
} from "./types.js";

/**
 * PostgreSQL-Implementierungen der Auth-Ports (Kysely, Mandantentrennung per RLS).
 *
 * - Alles mit bekanntem Mandanten läuft in `Datenbank.withKunde` (Mandant aus Sitzung bzw. Benutzer,
 *   nie aus dem Request, SR-13). Ohne Mandanten (Anmeldung, Sperrzähler, Ereignisse) gehen nur die
 *   schmalen SECURITY-DEFINER-Funktionen aus packages/db/migrations.
 * - `atomic(tenantId, fn)` fasst mehrere Repo-Aufrufe (Aktion + Audit-Eintrag) in EINE Transaktion.
 *   Die Repos erkennen sie über AsyncLocalStorage und laufen darin mit; ausserhalb öffnet jede
 *   Operation ihre eigene Transaktion. Ein Mandantenwechsel innerhalb einer Transaktion wirft.
 */

type Exec = Kysely<Db>;

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createPgAuth(db: Datenbank) {
  const scope = new AsyncLocalStorage<{ tenantId: string; trx: Transaction<Db> }>();

  const atomic = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> => {
    const cur = scope.getStore();
    if (cur) {
      if (cur.tenantId !== tenantId)
        throw new Error("Mandantenwechsel innerhalb einer Transaktion");
      return fn();
    }
    return db.withKunde(tenantId, (trx) => scope.run({ tenantId, trx }, fn));
  };

  /** Im Mandanten ausführen: in der laufenden Transaktion oder in einer eigenen. */
  const inTenant = <T>(tenantId: string, fn: (e: Exec) => Promise<T>): Promise<T> => {
    const cur = scope.getStore();
    if (!cur) return db.withKunde(tenantId, fn);
    if (cur.tenantId !== tenantId) throw new Error("Mandantenwechsel innerhalb einer Transaktion");
    return fn(cur.trx);
  };

  /** Für Funktionen ohne Mandanten: in der laufenden Transaktion mitlaufen, sonst einzeln. */
  const anyTenant = (): Exec => scope.getStore()?.trx ?? db.kysely;

  // ------------------------------------------------------------------ Benutzer

  async function loadUser(e: Exec, id: string): Promise<User | null> {
    const row = await e.selectFrom("benutzer").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) return null;
    const codes = await e
      .selectFrom("wiederherstellungscode")
      .select("code_hmac")
      .where("benutzer_id", "=", id)
      .execute();
    return {
      id: row.id,
      tenantId: row.kunde_id,
      email: row.email,
      name: row.name,
      role: row.rolle,
      passwordHash: row.passwort_hash,
      totpSecretEnc: row.totp_secret_enc,
      totpLastCounter: row.totp_letzter_zaehler === null ? null : Number(row.totp_letzter_zaehler),
      recoveryCodeHashes: codes.map((c) => c.code_hmac),
      lastLoginAt: row.letzte_anmeldung_am,
      passwordChangedAt: row.passwort_geaendert_am,
      totpSince: row.totp_eingerichtet_am,
      disabled: !row.aktiv,
      createdAt: row.erstellt_am,
    };
  }

  const insertCodes = (e: Exec, tenantId: string, userId: string, hashes: string[]) =>
    hashes.length === 0
      ? Promise.resolve()
      : e
          .insertInto("wiederherstellungscode")
          .values(hashes.map((h) => ({ kunde_id: tenantId, benutzer_id: userId, code_hmac: h })))
          .execute();

  const users: UserRepo = {
    async findByEmail(email) {
      const hit = await db.findeBenutzerFuerAnmeldung(email);
      return hit ? inTenant(hit.kunde_id, (e) => loadUser(e, hit.id)) : null;
    },
    findById: (tenantId, id) =>
      UUID.test(id) ? inTenant(tenantId, (e) => loadUser(e, id)) : Promise.resolve(null),
    async findForMfaReset(actorId, targetId) {
      if (!UUID.test(actorId) || !UUID.test(targetId)) return null;
      const hit = await db.findeBenutzerFuerMfaReset(actorId, targetId);
      return hit ? inTenant(hit.kunde_id, (e) => loadUser(e, hit.id)) : null;
    },
    async setPasswordHash(tenantId, id, hash) {
      await inTenant(tenantId, (e) =>
        e
          .updateTable("benutzer")
          .set({ passwort_hash: hash, passwort_geaendert_am: new Date() })
          .where("id", "=", id)
          .execute(),
      );
    },
    async recordLogin(tenantId, id, at) {
      await inTenant(tenantId, (e) =>
        e.updateTable("benutzer").set({ letzte_anmeldung_am: at }).where("id", "=", id).execute(),
      );
    },
    replaceTotp: (tenantId, id, expectedSecretEnc, secretEnc, counter) =>
      inTenant(tenantId, async (e) => {
        // Compare-and-swap auf das bisherige Geheimnis: zwei gleichzeitige Bestätigungen, genau eine gewinnt.
        const r = await e
          .updateTable("benutzer")
          .set({
            totp_secret_enc: secretEnc,
            totp_letzter_zaehler: String(counter),
            totp_eingerichtet_am: new Date(),
          })
          .where("id", "=", id)
          .where("totp_secret_enc", "=", expectedSecretEnc)
          .executeTakeFirst();
        return r.numUpdatedRows > 0n;
      }),
    async setName(tenantId, id, name) {
      await inTenant(tenantId, (e) =>
        e.updateTable("benutzer").set({ name }).where("id", "=", id).execute(),
      );
    },
    enrollTotp: (tenantId, id, secretEnc, counter, recoveryHashes) =>
      inTenant(tenantId, async (e) => {
        // Nur wenn noch kein Geheimnis gesetzt ist: zwei gleichzeitige Einrichtungen, genau eine gewinnt.
        const r = await e
          .updateTable("benutzer")
          .set({
            totp_secret_enc: secretEnc,
            totp_letzter_zaehler: String(counter),
            totp_eingerichtet_am: new Date(),
          })
          .where("id", "=", id)
          .where("totp_secret_enc", "is", null)
          .executeTakeFirst();
        if (r.numUpdatedRows === 0n) return false;
        await e.deleteFrom("wiederherstellungscode").where("benutzer_id", "=", id).execute();
        await insertCodes(e, tenantId, id, recoveryHashes);
        return true;
      }),
    clearTotp: (tenantId, id) =>
      inTenant(tenantId, async (e) => {
        await e
          .updateTable("benutzer")
          .set({ totp_secret_enc: null, totp_letzter_zaehler: null, totp_eingerichtet_am: null })
          .where("id", "=", id)
          .execute();
        await e.deleteFrom("wiederherstellungscode").where("benutzer_id", "=", id).execute();
      }),
    advanceTotpCounter: (tenantId, id, counter) =>
      inTenant(tenantId, async (e) => {
        // Ein einziges bedingtes UPDATE: bei gleichzeitigen Anfragen mit demselben Code gewinnt genau eine.
        const r = await e
          .updateTable("benutzer")
          .set({ totp_letzter_zaehler: String(counter) })
          .where("id", "=", id)
          .where("totp_letzter_zaehler", "<", String(counter))
          .executeTakeFirst();
        return r.numUpdatedRows > 0n;
      }),
    consumeRecoveryCode: (tenantId, id, hash) =>
      inTenant(tenantId, async (e) => {
        const r = await e
          .deleteFrom("wiederherstellungscode")
          .where("benutzer_id", "=", id)
          .where("code_hmac", "=", hash)
          .executeTakeFirst();
        return r.numDeletedRows > 0n;
      }),
    replaceRecoveryCodes: (tenantId, id, hashes) =>
      inTenant(tenantId, async (e) => {
        await e.deleteFrom("wiederherstellungscode").where("benutzer_id", "=", id).execute();
        await insertCodes(e, tenantId, id, hashes);
      }),
  };

  // ------------------------------------------------------------------ Sitzungen

  /** Die Sitzungs-ID der Domäne ist der SHA-256 des Tokens (hex), in der Tabelle `token_hash` (bytea). */
  const tokenHash = (id: string) => Buffer.from(id, "hex");

  const sessions: SessionRepo = {
    create: (s: Session) =>
      inTenant(s.tenantId, async (e) => {
        await e
          .insertInto("sitzung")
          .values({
            kunde_id: s.tenantId,
            benutzer_id: s.userId,
            token_hash: tokenHash(s.id),
            erstellt_am: s.createdAt,
            laeuft_ab_am: s.expiresAt,
            phase: s.stage,
            csrf_token: s.csrfToken,
            zuletzt_gesehen_am: s.lastSeenAt,
            totp_pending_enc: s.pendingTotpSecretEnc,
          })
          .execute();
      }),
    async findById(id) {
      if (!HEX64.test(id)) return null;
      // Schritt 1 ohne Mandant (nur gültige Sitzungen), Schritt 2 unter RLS im Mandanten der Sitzung.
      const hit = await db.loeseSitzungAuf(tokenHash(id));
      if (!hit) return null;
      return inTenant(hit.kunde_id, async (e) => {
        const r = await e
          .selectFrom("sitzung")
          .selectAll()
          .where("token_hash", "=", tokenHash(id))
          .executeTakeFirst();
        return r
          ? {
              id,
              tenantId: r.kunde_id,
              userId: r.benutzer_id,
              stage: r.phase,
              csrfToken: r.csrf_token,
              createdAt: r.erstellt_am,
              lastSeenAt: r.zuletzt_gesehen_am,
              expiresAt: r.laeuft_ab_am,
              pendingTotpSecretEnc: r.totp_pending_enc,
              failedMfaAttempts: r.mfa_fehlversuche,
            }
          : null;
      });
    },
    async touch(tenantId, id, lastSeenAt) {
      await inTenant(tenantId, (e) =>
        e
          .updateTable("sitzung")
          .set({ zuletzt_gesehen_am: lastSeenAt })
          .where("token_hash", "=", tokenHash(id))
          .execute(),
      );
    },
    async setPendingTotp(tenantId, id, secretEnc: string | null) {
      await inTenant(tenantId, (e) =>
        e
          .updateTable("sitzung")
          .set({ totp_pending_enc: secretEnc })
          .where("token_hash", "=", tokenHash(id))
          .execute(),
      );
    },
    recordMfaFailure: (tenantId, id) =>
      inTenant(tenantId, async (e) => {
        // Zählen im UPDATE selbst (nicht lesen, erhöhen, schreiben): gleichzeitige Fehlversuche gehen nicht verloren.
        const r = await e
          .updateTable("sitzung")
          .set({ mfa_fehlversuche: sql`mfa_fehlversuche + 1` })
          .where("token_hash", "=", tokenHash(id))
          .returning("mfa_fehlversuche")
          .executeTakeFirst();
        // Unbekannte Sitzung: wie "verbraucht" behandeln.
        return r?.mfa_fehlversuche ?? Number.MAX_SAFE_INTEGER;
      }),
    async revoke(tenantId, id) {
      await inTenant(tenantId, (e) =>
        e
          .updateTable("sitzung")
          .set({ widerrufen_am: sql`now()` })
          .where("token_hash", "=", tokenHash(id))
          .where("widerrufen_am", "is", null)
          .execute(),
      );
    },
    async revokeAllForUser(tenantId, userId, exceptId) {
      await inTenant(tenantId, (e) => {
        let q = e
          .updateTable("sitzung")
          .set({ widerrufen_am: sql`now()` })
          .where("benutzer_id", "=", userId)
          .where("widerrufen_am", "is", null);
        if (exceptId) q = q.where("token_hash", "!=", tokenHash(exceptId));
        return q.execute();
      });
    },
    async deleteExpired(now) {
      return (await db.raeumeAuthAuf(now)).sitzungen;
    },
  };

  // ------------------------------------------------------------------ Einladungen

  /** Das Token führt erst zum Kunden: nur die zwei Funktionen der Migration 202611050900, in der laufenden Transaktion oder einzeln. */
  const invitations: InvitationRepo = {
    async peek(tokenHash, now) {
      if (!HEX64.test(tokenHash)) return null;
      const { rows } = await sql<{ email: string; kunde_id: string }>`
        SELECT * FROM einladung_pruefen(${Buffer.from(tokenHash, "hex")}::bytea, ${now}::timestamptz)`.execute(
        anyTenant(),
      );
      return rows[0] ? { email: rows[0].email, tenantId: rows[0].kunde_id } : null;
    },
    async redeem(tokenHash, passwordHash, now) {
      if (!HEX64.test(tokenHash)) return null;
      const { rows } = await sql<{
        benutzer_id: string;
        kunde_id: string;
        rolle: "admin" | "user";
      }>`
        SELECT * FROM einladung_annehmen(${Buffer.from(tokenHash, "hex")}::bytea, ${now}::timestamptz, ${passwordHash})`.execute(
        anyTenant(),
      );
      const r = rows[0];
      return r ? { userId: r.benutzer_id, tenantId: r.kunde_id, role: r.rolle } : null;
    },
    async recordFailure(tokenHash) {
      if (!HEX64.test(tokenHash)) return;
      await sql`SELECT einladung_fehlversuch(${Buffer.from(tokenHash, "hex")}::bytea)`.execute(
        anyTenant(),
      );
    },
  };

  // ------------------------------------------------------------------ Passwort zurücksetzen

  /** Wie die Einladungen: Adresse bzw. Token führen erst zum Kunden, deshalb nur die Funktionen der Migration 202611051110. */
  const passwordReset: PasswordResetRepo = {
    async create(email, tokenHash, now, expiresAt) {
      if (!HEX64.test(tokenHash)) return null;
      const { rows } = await sql<{ benutzer_id: string; kunde_id: string }>`
        SELECT * FROM passwort_reset_anlegen(${email}, ${Buffer.from(tokenHash, "hex")}::bytea,
                                              ${now}::timestamptz, ${expiresAt}::timestamptz)`.execute(
        anyTenant(),
      );
      return rows[0] ? { userId: rows[0].benutzer_id, tenantId: rows[0].kunde_id } : null;
    },
    async peek(tokenHash, now) {
      if (!HEX64.test(tokenHash)) return null;
      const { rows } = await sql<{ benutzer_id: string; kunde_id: string; email: string }>`
        SELECT * FROM passwort_reset_pruefen(${Buffer.from(tokenHash, "hex")}::bytea, ${now}::timestamptz)`.execute(
        anyTenant(),
      );
      const r = rows[0];
      return r ? { userId: r.benutzer_id, tenantId: r.kunde_id, email: r.email } : null;
    },
    async consume(tokenHash, now) {
      if (!HEX64.test(tokenHash)) return null;
      const { rows } = await sql<{ benutzer_id: string; kunde_id: string }>`
        SELECT * FROM passwort_reset_einloesen(${Buffer.from(tokenHash, "hex")}::bytea, ${now}::timestamptz)`.execute(
        anyTenant(),
      );
      return rows[0] ? { userId: rows[0].benutzer_id, tenantId: rows[0].kunde_id } : null;
    },
  };

  // ------------------------------------------------------------------ Sperrzähler

  type SperreRow = { fehlversuche: number; letzter_fehler: Date; gesperrt_bis: Date | null };
  const toState = (r: SperreRow): ThrottleState => ({
    failures: r.fehlversuche,
    lastFailureAt: r.letzter_fehler,
    lockedUntil: r.gesperrt_bis,
  });

  const throttle: ThrottleRepo = {
    async get(key) {
      const { rows } = await sql<SperreRow>`SELECT * FROM auth_sperre_lesen(${key})`.execute(
        anyTenant(),
      );
      return rows[0] ? toState(rows[0]) : null;
    },
    update(key, fn) {
      // Zeile anlegen und sperren, ändern, schreiben: gleichzeitige Fehlversuche zählen alle.
      const run = async (e: Exec) => {
        const { rows } = await sql<SperreRow>`SELECT * FROM auth_sperre_sichern(${key})`.execute(e);
        const row = rows[0]!;
        const next = fn(row.fehlversuche === 0 ? null : toState(row));
        await sql`SELECT auth_sperre_setzen(${key}, ${next.failures}, ${next.lastFailureAt}::timestamptz, ${next.lockedUntil}::timestamptz)`.execute(
          e,
        );
        return next;
      };
      const cur = scope.getStore();
      return cur ? run(cur.trx) : db.kysely.transaction().execute(run);
    },
    async clear(key) {
      await sql`SELECT auth_sperre_loeschen(${key})`.execute(anyTenant());
    },
  };

  // ------------------------------------------------------------------ Audit

  const audit: AuditRepo = {
    async append(ev: AuditEvent) {
      const details = JSON.stringify({
        ergebnis: ev.outcome,
        ip: ev.ip,
        ...(ev.actorUserId ? { akteur: ev.actorUserId } : {}),
        ...(ev.targetUserId ? { ziel: ev.targetUserId } : {}),
        ...ev.detail,
      });
      if (ev.tenantId === null) {
        // Mandant unbekannt: Tabelle ohne Mandantenbezug (nur über die Funktion erreichbar).
        await sql`SELECT auth_ereignis_anhaengen(${ev.at}::timestamptz, ${ev.type}, ${ev.outcome}, ${ev.ip}, ${ev.actorUserId}::uuid, ${details}::jsonb)`.execute(
          anyTenant(),
        );
        return;
      }
      await inTenant(ev.tenantId, async (e) => {
        // benutzer_id nur, wenn der Akteur in diesem Mandanten liegt (RLS blendet fremde aus); ein
        // Chef-Admin aus einem anderen Mandanten steht dann nur in `details.akteur`.
        await sql`
          INSERT INTO audit_log (kunde_id, benutzer_id, zeitpunkt, aktion, objekt_typ, objekt_id, details)
          VALUES (${ev.tenantId}::uuid, (SELECT id FROM benutzer WHERE id = ${ev.actorUserId}::uuid),
                  ${ev.at}::timestamptz, ${ev.type}, ${ev.targetUserId ? "benutzer" : null},
                  ${ev.targetUserId}, ${details}::jsonb)`.execute(e);
      });
    },
    async list(filter = {}) {
      const { tenantId, userId, limit = 100 } = filter;
      if (!tenantId) throw new Error("Protokoll nur pro Mandant lesbar");
      const rows = await inTenant(tenantId, (e) => {
        let q = e.selectFrom("audit_log").selectAll().orderBy("id", "desc").limit(limit);
        if (userId) {
          q = q.where((eb) =>
            eb.or([eb("benutzer_id", "=", userId), eb("objekt_id", "=", userId)]),
          );
        }
        return q.execute();
      });
      return rows.map((r) => {
        const { ergebnis, ip, akteur, ziel, ...detail } = r.details as Record<string, unknown>;
        return {
          at: r.zeitpunkt,
          tenantId: r.kunde_id,
          type: r.aktion as AuditEvent["type"],
          outcome: ergebnis === "success" ? "success" : "failure",
          actorUserId: typeof akteur === "string" ? akteur : r.benutzer_id,
          targetUserId: typeof ziel === "string" ? ziel : r.objekt_id,
          ip: typeof ip === "string" ? ip : "",
          detail: detail as AuditEvent["detail"],
        };
      });
    },
  };

  return { users, sessions, throttle, audit, invitations, passwordReset, atomic };
}
