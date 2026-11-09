import type {
  Datenbank,
  MailAdresslisteTable,
  MailAnhangTable,
  MailKampagneTable,
  MailKontoTable,
  MailZustellungTable,
} from "@stammbuch/db";
import { sql, type Selectable } from "kysely";
import type { MailErrorCode } from "./net-guard.js";
import type {
  AccountRepository,
  AddressListRepository,
  AttachmentRepository,
  CampaignRepository,
  DeliveryResult,
  MailRepositories,
} from "./repositories.js";
import type {
  AddressList,
  AttachmentMeta,
  Campaign,
  Delivery,
  DeliveryCounts,
  DeliveryStatus,
  MailAccount,
  Recipient,
} from "./types.js";

/**
 * PostgreSQL-Umsetzung der Mail-Repositories (API und Worker teilen so denselben Stand).
 * Alle mandantengebundenen Methoden laufen in `withKunde` (RLS) und filtern zusätzlich auf `kunde_id`.
 * Die internen Worker-Methoden (`getById`, `listDue`, `claim`, `finish`, `countSentSince`) rufen nur die schmalen
 * SECURITY-DEFINER-Funktionen der Rolle `stammbuch_worker` auf; mit der Verbindung der API scheitern sie an den
 * Rechten (fail secure). Der Worker nutzt `createPostgresWorkerRepositories`: Konto und Anhang für den Versand
 * lesen ebenfalls über Funktionen, denn die Rolle `stammbuch_worker` hat keine Tabellenrechte.
 */
export function createPostgresMailRepositories(db: Datenbank): MailRepositories {
  return {
    accounts: new PgAccounts(db),
    attachments: new PgAttachments(db),
    lists: new PgLists(db),
    campaigns: new PgCampaigns(db),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** IDs kommen vom Client als freier Text; was keine UUID ist, existiert nicht (statt eines Datenbankfehlers). */
const isUuid = (v: string) => UUID.test(v);

const BATCH = 500;

// ------------------------------------------------------------------ Konten

type KontoRow = Selectable<MailKontoTable>;

function toAccount(r: KontoRow): MailAccount {
  return {
    id: r.id,
    tenantId: r.kunde_id,
    ownerUserId: r.benutzer_id,
    label: r.bezeichnung,
    fromAddress: r.absender_adresse,
    fromName: r.absender_name ?? undefined,
    username: r.benutzername,
    secretEnc: r.geheimnis_enc,
    smtp: { host: r.smtp_host, port: r.smtp_port, security: r.smtp_sicherheit },
    imap:
      r.imap_host !== null && r.imap_port !== null && r.imap_sicherheit !== null
        ? { host: r.imap_host, port: r.imap_port, security: r.imap_sicherheit }
        : undefined,
    createdAt: r.erstellt_am,
  };
}

const kontoValues = (a: MailAccount) => ({
  bezeichnung: a.label,
  absender_adresse: a.fromAddress,
  absender_name: a.fromName ?? null,
  benutzername: a.username,
  geheimnis_enc: a.secretEnc,
  smtp_host: a.smtp.host,
  smtp_port: a.smtp.port,
  smtp_sicherheit: a.smtp.security,
  imap_host: a.imap?.host ?? null,
  imap_port: a.imap?.port ?? null,
  imap_sicherheit: a.imap?.security ?? null,
});

class PgAccounts implements AccountRepository {
  constructor(protected readonly db: Datenbank) {}

  insert(a: MailAccount) {
    return this.db.withKunde(a.tenantId, async (trx) => {
      await trx
        .insertInto("mail_konto")
        .values({
          id: a.id,
          kunde_id: a.tenantId,
          benutzer_id: a.ownerUserId,
          erstellt_am: a.createdAt,
          ...kontoValues(a),
        })
        .execute();
    });
  }

  async get(tenantId: string, id: string) {
    if (!isUuid(id)) return null;
    const row = await this.db.withKunde(tenantId, (trx) =>
      trx
        .selectFrom("mail_konto")
        .selectAll()
        .where("kunde_id", "=", tenantId)
        .where("id", "=", id)
        .executeTakeFirst(),
    );
    return row ? toAccount(row) : null;
  }

  async listByOwner(tenantId: string, ownerUserId: string) {
    const rows = await this.db.withKunde(tenantId, (trx) =>
      trx
        .selectFrom("mail_konto")
        .selectAll()
        .where("kunde_id", "=", tenantId)
        .where("benutzer_id", "=", ownerUserId)
        .orderBy("erstellt_am")
        .orderBy("id")
        .execute(),
    );
    return rows.map(toAccount);
  }

  update(a: MailAccount) {
    return this.db.withKunde(a.tenantId, async (trx) => {
      await trx
        .updateTable("mail_konto")
        .set(kontoValues(a))
        .where("kunde_id", "=", a.tenantId)
        .where("id", "=", a.id)
        .execute();
    });
  }

  delete(tenantId: string, id: string) {
    if (!isUuid(id)) return Promise.resolve(false);
    return this.db.withKunde(tenantId, async (trx) => {
      const r = await trx
        .deleteFrom("mail_konto")
        .where("kunde_id", "=", tenantId)
        .where("id", "=", id)
        .executeTakeFirst();
      return r.numDeletedRows > 0n;
    });
  }

  /** Über Funktionen der Rolle `stammbuch_worker`; mit der Verbindung der API scheitern sie an den Rechten (fail secure). */
  async listForRotation(currentKeyId: string, after: string | null, limit: number) {
    const { rows } = await sql<KontoRow>`SELECT * FROM mail_konten_zur_rotation(
      ${currentKeyId}, ${after}::uuid, ${limit}::integer)`.execute(this.db.kysely);
    return rows.map(toAccount);
  }

  async replaceSecret(tenantId: string, id: string, expectedEnc: string, newEnc: string) {
    const { rows } = await sql<{ ok: boolean }>`SELECT mail_konto_geheimnis_ersetzen(
      ${tenantId}::uuid, ${id}::uuid, ${expectedEnc}, ${newEnc}) AS ok`.execute(this.db.kysely);
    return rows[0]?.ok === true;
  }
}

// ------------------------------------------------------------------ Anhänge

function toAttachmentMeta(r: Omit<Selectable<MailAnhangTable>, "inhalt">): AttachmentMeta {
  return {
    id: r.id,
    tenantId: r.kunde_id,
    ownerUserId: r.benutzer_id,
    filename: r.dateiname,
    contentType: r.inhaltstyp,
    size: r.groesse,
    sha256: r.sha256,
    createdAt: r.erstellt_am,
  };
}

class PgAttachments implements AttachmentRepository {
  constructor(protected readonly db: Datenbank) {}

  insert(meta: AttachmentMeta, bytes: Buffer) {
    return this.db.withKunde(meta.tenantId, async (trx) => {
      await trx
        .insertInto("mail_anhang")
        .values({
          id: meta.id,
          kunde_id: meta.tenantId,
          benutzer_id: meta.ownerUserId,
          dateiname: meta.filename,
          inhaltstyp: meta.contentType,
          groesse: meta.size,
          sha256: meta.sha256,
          inhalt: bytes,
          erstellt_am: meta.createdAt,
        })
        .execute();
    });
  }

  async get(tenantId: string, id: string) {
    if (!isUuid(id)) return null;
    const row = await this.db.withKunde(tenantId, (trx) =>
      trx
        .selectFrom("mail_anhang")
        .selectAll()
        .where("kunde_id", "=", tenantId)
        .where("id", "=", id)
        .executeTakeFirst(),
    );
    return row ? { meta: toAttachmentMeta(row), bytes: Buffer.from(row.inhalt) } : null;
  }
}

// ------------------------------------------------------------------ Adresslisten

function toList(r: Selectable<MailAdresslisteTable>): AddressList {
  return {
    id: r.id,
    tenantId: r.kunde_id,
    ownerUserId: r.benutzer_id,
    name: r.name,
    description: r.beschreibung,
    manual: r.manuell as Recipient[],
    groupIds: r.gruppen_ids,
    personIds: r.personen_ids,
    createdAt: r.erstellt_am,
    lastUsedAt: r.zuletzt_verwendet_am ?? undefined,
  };
}

class PgLists implements AddressListRepository {
  constructor(private readonly db: Datenbank) {}

  insert(l: AddressList) {
    return this.db.withKunde(l.tenantId, async (trx) => {
      await trx
        .insertInto("mail_adressliste")
        .values({
          id: l.id,
          kunde_id: l.tenantId,
          benutzer_id: l.ownerUserId,
          name: l.name,
          beschreibung: l.description,
          manuell: JSON.stringify(l.manual),
          gruppen_ids: l.groupIds,
          personen_ids: l.personIds,
          erstellt_am: l.createdAt,
        })
        .execute();
    });
  }

  async get(tenantId: string, id: string) {
    if (!isUuid(id)) return null;
    const row = await this.db.withKunde(tenantId, (trx) =>
      trx
        .selectFrom("mail_adressliste")
        .selectAll()
        .where("kunde_id", "=", tenantId)
        .where("id", "=", id)
        .executeTakeFirst(),
    );
    return row ? toList(row) : null;
  }

  async list(tenantId: string, ownerUserId: string) {
    const rows = await this.db.withKunde(tenantId, (trx) =>
      trx
        .selectFrom("mail_adressliste")
        .selectAll()
        .where("kunde_id", "=", tenantId)
        .where("benutzer_id", "=", ownerUserId)
        .orderBy("erstellt_am")
        .orderBy("id")
        .execute(),
    );
    return rows.map(toList);
  }

  update(l: AddressList) {
    return this.db.withKunde(l.tenantId, async (trx) => {
      await trx
        .updateTable("mail_adressliste")
        .set({
          name: l.name,
          beschreibung: l.description,
          manuell: JSON.stringify(l.manual),
          gruppen_ids: l.groupIds,
          personen_ids: l.personIds,
        })
        .where("kunde_id", "=", l.tenantId)
        .where("id", "=", l.id)
        .execute();
    });
  }

  markUsed(tenantId: string, ids: string[], at: Date) {
    const valid = ids.filter(isUuid);
    if (valid.length === 0) return Promise.resolve();
    return this.db.withKunde(tenantId, async (trx) => {
      await trx
        .updateTable("mail_adressliste")
        .set({ zuletzt_verwendet_am: at })
        .where("kunde_id", "=", tenantId)
        .where("id", "in", valid)
        .execute();
    });
  }

  delete(tenantId: string, id: string) {
    if (!isUuid(id)) return Promise.resolve(false);
    return this.db.withKunde(tenantId, async (trx) => {
      const r = await trx
        .deleteFrom("mail_adressliste")
        .where("kunde_id", "=", tenantId)
        .where("id", "=", id)
        .executeTakeFirst();
      return r.numDeletedRows > 0n;
    });
  }
}

// ------------------------------------------------------------------ Kampagnen und Zustellungen

/** Die Worker-Funktion liefert weder Bestätigungs-Token noch Listenname und «Bestätigt von». */
type OptionalKampagneColumn =
  "bestaetigung_hash" | "bestaetigung_laeuft_ab_am" | "listenname" | "bestaetigt_von";
type KampagneRow = Omit<Selectable<MailKampagneTable>, OptionalKampagneColumn> &
  Partial<Pick<Selectable<MailKampagneTable>, OptionalKampagneColumn>>;

function toCampaign(r: KampagneRow): Campaign {
  return {
    id: r.id,
    tenantId: r.kunde_id,
    ownerUserId: r.benutzer_id,
    accountId: r.konto_id,
    kind: r.art,
    subject: r.betreff,
    bodyHtml: r.inhalt_html,
    attachmentIds: r.anhang_ids,
    scheduledAt: r.geplant_am,
    state: r.status,
    confirmation:
      r.bestaetigung_hash && r.bestaetigung_laeuft_ab_am
        ? { tokenHash: r.bestaetigung_hash, expiresAt: r.bestaetigung_laeuft_ab_am }
        : undefined,
    recipientCount: r.empfaenger_anzahl,
    createdAt: r.erstellt_am,
    confirmedAt: r.bestaetigt_am ?? undefined,
    listName: r.listenname ?? undefined,
    confirmedBy: r.bestaetigt_von ?? undefined,
  };
}

function toDelivery(r: Selectable<MailZustellungTable>): Delivery {
  return {
    id: r.id,
    tenantId: r.kunde_id,
    campaignId: r.kampagne_id,
    recipient: r.empfaenger as Recipient,
    status: r.status,
    attempts: r.versuche,
    nextAttemptAt: r.naechster_versuch_am,
    leaseUntil: r.lease_bis ?? undefined,
    lastError: (r.letzter_fehler as MailErrorCode | null) ?? undefined,
    sentAt: r.gesendet_am ?? undefined,
    messageId: r.nachrichten_id ?? undefined,
  };
}

class PgCampaigns implements CampaignRepository {
  constructor(private readonly db: Datenbank) {}

  create(c: Campaign, deliveries: Delivery[]) {
    return this.db.withKunde(c.tenantId, async (trx) => {
      await trx
        .insertInto("mail_kampagne")
        .values({
          id: c.id,
          kunde_id: c.tenantId,
          benutzer_id: c.ownerUserId,
          konto_id: c.accountId,
          art: c.kind,
          betreff: c.subject,
          inhalt_html: c.bodyHtml,
          anhang_ids: c.attachmentIds,
          geplant_am: c.scheduledAt,
          status: c.state,
          bestaetigung_hash: c.confirmation?.tokenHash ?? null,
          bestaetigung_laeuft_ab_am: c.confirmation?.expiresAt ?? null,
          empfaenger_anzahl: c.recipientCount,
          erstellt_am: c.createdAt,
          bestaetigt_am: c.confirmedAt ?? null,
          listenname: c.listName ?? null,
          bestaetigt_von: c.confirmedBy ?? null,
        })
        .execute();
      // In Blöcken: eine Kampagne kann Tausende Empfänger haben (Parametergrenze von PostgreSQL).
      for (let i = 0; i < deliveries.length; i += BATCH) {
        await trx
          .insertInto("mail_zustellung")
          .values(
            deliveries.slice(i, i + BATCH).map((d) => ({
              id: d.id,
              kunde_id: d.tenantId,
              kampagne_id: d.campaignId,
              empfaenger: JSON.stringify(d.recipient),
              status: d.status,
              versuche: d.attempts,
              naechster_versuch_am: d.nextAttemptAt,
              lease_bis: d.leaseUntil ?? null,
              letzter_fehler: d.lastError ?? null,
              gesendet_am: d.sentAt ?? null,
              nachrichten_id: d.messageId ?? null,
            })),
          )
          .execute();
      }
    });
  }

  async get(tenantId: string, id: string) {
    if (!isUuid(id)) return null;
    const row = await this.db.withKunde(tenantId, (trx) =>
      trx
        .selectFrom("mail_kampagne")
        .selectAll()
        .where("kunde_id", "=", tenantId)
        .where("id", "=", id)
        .executeTakeFirst(),
    );
    return row ? toCampaign(row) : null;
  }

  async list(tenantId: string, ownerUserId: string, limit: number) {
    const rows = await this.db.withKunde(tenantId, (trx) =>
      trx
        .selectFrom("mail_kampagne")
        .selectAll()
        .where("kunde_id", "=", tenantId)
        .where("benutzer_id", "=", ownerUserId)
        .orderBy("erstellt_am", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute(),
    );
    return rows.map(toCampaign);
  }

  /** Eine Transaktion: Kampagne und Zustellungen wechseln gemeinsam. Der bedingte UPDATE entscheidet das Rennen. */
  confirm(tenantId: string, id: string, now: Date, confirmedBy?: string) {
    if (!isUuid(id)) return Promise.resolve(false);
    return this.db.withKunde(tenantId, async (trx) => {
      const changed = await trx
        .updateTable("mail_kampagne")
        .set({
          status: "confirmed",
          bestaetigt_am: now,
          bestaetigt_von: confirmedBy ?? null,
          bestaetigung_hash: null,
          bestaetigung_laeuft_ab_am: null,
        })
        .where("kunde_id", "=", tenantId)
        .where("id", "=", id)
        .where("status", "=", "awaiting_confirmation")
        .returning("id")
        .executeTakeFirst();
      if (!changed) return false;
      await trx
        .updateTable("mail_zustellung")
        .set({ status: "queued" })
        .where("kunde_id", "=", tenantId)
        .where("kampagne_id", "=", id)
        .where("status", "=", "held")
        .execute();
      return true;
    });
  }

  cancel(tenantId: string, id: string) {
    if (!isUuid(id)) return Promise.resolve(false);
    return this.db.withKunde(tenantId, async (trx) => {
      const changed = await trx
        .updateTable("mail_kampagne")
        .set({ status: "cancelled", bestaetigung_hash: null, bestaetigung_laeuft_ab_am: null })
        .where("kunde_id", "=", tenantId)
        .where("id", "=", id)
        .where("status", "<>", "cancelled")
        .returning("id")
        .executeTakeFirst();
      if (!changed) return false;
      await trx
        .updateTable("mail_zustellung")
        .set({ status: "cancelled" })
        .where("kunde_id", "=", tenantId)
        .where("kampagne_id", "=", id)
        .where("status", "in", ["held", "queued"])
        .execute();
      return true;
    });
  }

  /** Eine Transaktion; der bedingte UPDATE auf `confirmed` entscheidet gegen ein gleichzeitiges Abbrechen. */
  pause(tenantId: string, id: string) {
    if (!isUuid(id)) return Promise.resolve(false);
    return this.db.withKunde(tenantId, async (trx) => {
      const changed = await trx
        .updateTable("mail_kampagne")
        .set({ status: "paused" })
        .where("kunde_id", "=", tenantId)
        .where("id", "=", id)
        .where("status", "=", "confirmed")
        .returning("id")
        .executeTakeFirst();
      if (!changed) return false;
      await trx
        .updateTable("mail_zustellung")
        .set({ status: "held" })
        .where("kunde_id", "=", tenantId)
        .where("kampagne_id", "=", id)
        .where("status", "=", "queued")
        .execute();
      return true;
    });
  }

  reschedule(tenantId: string, id: string, at: Date) {
    if (!isUuid(id)) return Promise.resolve(false);
    return this.db.withKunde(tenantId, async (trx) => {
      const before = await trx
        .selectFrom("mail_kampagne")
        .select("status")
        .where("kunde_id", "=", tenantId)
        .where("id", "=", id)
        .where("status", "in", ["awaiting_confirmation", "confirmed", "paused"])
        .forUpdate()
        .executeTakeFirst();
      if (!before) return false;
      const resume = before.status === "paused";
      await trx
        .updateTable("mail_kampagne")
        .set({ geplant_am: at, ...(resume ? { status: "confirmed" as const } : {}) })
        .where("kunde_id", "=", tenantId)
        .where("id", "=", id)
        .execute();
      await trx
        .updateTable("mail_zustellung")
        .set({ naechster_versuch_am: at, ...(resume ? { status: "queued" as const } : {}) })
        .where("kunde_id", "=", tenantId)
        .where("kampagne_id", "=", id)
        .where("status", "in", ["held", "queued"])
        .execute();
      return true;
    });
  }

  async counts(tenantId: string, id: string) {
    const counts: DeliveryCounts = {
      held: 0,
      queued: 0,
      sending: 0,
      sent: 0,
      failed: 0,
      cancelled: 0,
    };
    if (!isUuid(id)) return counts;
    const rows = await this.db.withKunde(tenantId, (trx) =>
      trx
        .selectFrom("mail_zustellung")
        .select(["status", (eb) => eb.fn.countAll<string>().as("n")])
        .where("kunde_id", "=", tenantId)
        .where("kampagne_id", "=", id)
        .groupBy("status")
        .execute(),
    );
    for (const r of rows) counts[r.status as DeliveryStatus] = Number(r.n);
    return counts;
  }

  async countsFor(tenantId: string, ids: string[]) {
    const out = new Map<string, DeliveryCounts>(
      ids.map((id) => [id, { held: 0, queued: 0, sending: 0, sent: 0, failed: 0, cancelled: 0 }]),
    );
    const valid = ids.filter(isUuid);
    if (valid.length === 0) return out;
    const rows = await this.db.withKunde(tenantId, (trx) =>
      trx
        .selectFrom("mail_zustellung")
        .select(["kampagne_id", "status", (eb) => eb.fn.countAll<string>().as("n")])
        .where("kunde_id", "=", tenantId)
        .where("kampagne_id", "in", valid)
        .groupBy(["kampagne_id", "status"])
        .execute(),
    );
    for (const r of rows) {
      const counts = out.get(r.kampagne_id);
      if (counts) counts[r.status as DeliveryStatus] = Number(r.n);
    }
    return out;
  }

  async listDeliveries(tenantId: string, id: string, offset: number, limit: number) {
    if (!isUuid(id)) return [];
    const rows = await this.db.withKunde(tenantId, (trx) =>
      trx
        .selectFrom("mail_zustellung")
        .selectAll()
        .where("kunde_id", "=", tenantId)
        .where("kampagne_id", "=", id)
        .orderBy("lfd")
        .offset(offset)
        .limit(limit)
        .execute(),
    );
    return rows.map(toDelivery);
  }

  // ---------------------------------------------------- Worker (Funktionen, ohne Tabellenrechte)

  async getById(id: string) {
    const { rows } =
      await sql<KampagneRow>`SELECT * FROM mail_kampagne_fuer_worker(${id}::uuid)`.execute(
        this.db.kysely,
      );
    return rows[0] ? toCampaign(rows[0]) : null;
  }

  async listDue(now: Date, limit: number) {
    const { rows } = await sql<
      Selectable<MailZustellungTable>
    >`SELECT * FROM mail_zustellungen_faellig(${now}, ${limit})`.execute(this.db.kysely);
    return rows.map(toDelivery);
  }

  async claim(id: string, now: Date, leaseUntil: Date) {
    const { rows } = await sql<
      Selectable<MailZustellungTable>
    >`SELECT * FROM mail_zustellung_uebernehmen(${id}::uuid, ${now}, ${leaseUntil})`.execute(
      this.db.kysely,
    );
    return rows[0] ? toDelivery(rows[0]) : null;
  }

  async finish(id: string, r: DeliveryResult) {
    await sql`SELECT mail_zustellung_abschliessen(
      ${id}::uuid, ${r.status}, ${r.sentAt ?? null}, ${r.messageId ?? null},
      ${r.lastError ?? null}, ${r.nextAttemptAt ?? null})`.execute(this.db.kysely);
  }

  async countSentSince(tenantId: string, since: Date) {
    const { rows } = await sql<{
      n: string;
    }>`SELECT mail_gesendet_seit(${tenantId}::uuid, ${since}) AS n`.execute(this.db.kysely);
    return Number(rows[0]?.n ?? 0);
  }
}

/** Konto für den Versand im Worker: über die Funktion ohne Tabellenrechte, sonst wie `PgAccounts`. */
class PgWorkerAccounts extends PgAccounts {
  override async get(tenantId: string, id: string) {
    if (!isUuid(id) || !isUuid(tenantId)) return null;
    const { rows } =
      await sql<KontoRow>`SELECT * FROM mail_konto_fuer_worker(${tenantId}::uuid, ${id}::uuid)`.execute(
        this.db.kysely,
      );
    return rows[0] ? toAccount(rows[0]) : null;
  }
}

class PgWorkerAttachments extends PgAttachments {
  override async get(tenantId: string, id: string) {
    if (!isUuid(id) || !isUuid(tenantId)) return null;
    const { rows } = await sql<
      Selectable<MailAnhangTable>
    >`SELECT * FROM mail_anhang_fuer_worker(${tenantId}::uuid, ${id}::uuid)`.execute(
      this.db.kysely,
    );
    const row = rows[0];
    return row ? { meta: toAttachmentMeta(row), bytes: Buffer.from(row.inhalt) } : null;
  }
}

/** Repositories für den Worker (Rolle `stammbuch_worker`): Konto und Anhang für den Versand ohne Tabellenrechte. */
export function createPostgresWorkerRepositories(db: Datenbank): MailRepositories {
  return {
    ...createPostgresMailRepositories(db),
    accounts: new PgWorkerAccounts(db),
    attachments: new PgWorkerAttachments(db),
  };
}
