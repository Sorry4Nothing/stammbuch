import { sql } from "kysely";
import type { Datenbank } from "@stammbuch/db";
import {
  pgRotationSource,
  readRotationState,
  recordRotationStateAsChef,
  rotateAll,
} from "@stammbuch/mail";
import type { SecretBox } from "@stammbuch/mail";
import { conflict } from "../lib/http-error.js";
import { SlugTakenError } from "./helpers.js";
import type {
  AuditEntry,
  AuditFilter,
  AuditRepository,
  ChefAccount,
  ChefAccountRepository,
  Invitation,
  InvitationRepository,
  InvitationSender,
  LogoStore,
  Organisation,
  OrganisationRepository,
  Page,
  PageRequest,
  Platform,
  PrincipalResolver,
  RotationControl,
  RotationKind,
  RotationStatus,
  Tenant,
  TenantRepository,
  TenantStatus,
  TenantUser,
  UserRepository,
} from "./types.js";

/**
 * PostgreSQL-Implementierung der Platform-Schnittstellen (Kysely, Rolle stammbuch_app, RLS aktiv).
 *
 * - Alles, was einem Kunden gehört (Benutzer, Organisation, Logo, Einladungen, Kundenprotokoll), läuft in
 *   `Datenbank.withKunde(tenantId)`. Der Mandant kommt aus der Sitzung (SR-13), RLS trennt zusätzlich zur WHERE-Klausel.
 * - Kundenübergreifende Vorgänge des Chef-Admins (Kunden auflisten, anlegen, ändern, Plattformprotokoll schreiben,
 *   eigenes Konto) gehen nur über SECURITY-DEFINER-Funktionen, die den Akteur als aktiven `chief_admin` in der
 *   Datenbank prüfen (Migration 202611041802). Die Anwendungsrolle kann Status und Lizenz eines Kunden nicht selbst ändern.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;
const iso = (d: Date) => d.toISOString();
const isCode = (err: unknown, code: string) =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;

/** Suchmuster «enthält» für ILIKE. `%`, `_` und `\` aus der Eingabe bleiben wörtlich (kein Wildcard-Missbrauch). */
const contains = (s: string) => `%${s.replace(/[\\%_]/g, "\\$&")}%`;

/** UNIQUE auf `kunde.slug` (Constraint `kunde_slug_key`) als Fehler der Schnittstelle. */
const slugTaken = (err: unknown): never => {
  throw isCode(err, "23505") && (err as { constraint?: unknown }).constraint === "kunde_slug_key"
    ? new SlugTakenError()
    : err;
};

// --- Kunden ------------------------------------------------------------------------------

type TenantRow = {
  id: string;
  name: string;
  slug: string | null;
  status: TenantStatus;
  lizenz_gueltig_bis: string;
  erstellt_am: Date;
  beendet_am: Date | null;
};
const toTenant = (r: TenantRow): Tenant => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  status: r.status,
  licenceValidUntil: r.lizenz_gueltig_bis,
  createdAt: iso(r.erstellt_am),
  endedAt: r.beendet_am && iso(r.beendet_am),
});

class PostgresTenants implements TenantRepository {
  constructor(private readonly db: Datenbank) {}

  async create(actorId: string, t: Tenant) {
    await sql`SELECT kunde_anlegen(${actorId}::uuid, ${t.id}::uuid, ${t.name}, ${t.licenceValidUntil}::date, ${t.createdAt}::timestamptz, ${t.slug}::text)`
      .execute(this.db.kysely)
      .catch(slugTaken);
  }

  /** Vertragsdaten des eigenen Kunden unter RLS: Der Mandant ist die gesuchte ID selbst. */
  async get(id: string) {
    if (!UUID.test(id)) return undefined;
    const row = await this.db.withKunde(id, (trx) =>
      trx
        .selectFrom("kunde")
        .select(["id", "name", "slug", "status", "lizenz_gueltig_bis", "erstellt_am", "beendet_am"])
        .where("id", "=", id)
        .executeTakeFirst(),
    );
    return row && toTenant(row);
  }

  async list(
    actorId: string,
    filter: { status?: TenantStatus | undefined; q?: string | undefined },
    { limit, offset }: PageRequest,
  ): Promise<Page<Tenant>> {
    // Eine leere Seite liefert eine Zeile ohne Kunde (nur `gesamt`).
    const { rows } = await sql<
      (TenantRow | { id: null }) & { gesamt: string }
    >`SELECT * FROM kunden_auflisten(${actorId}::uuid, ${filter.status ?? null}::text, ${filter.q ? contains(filter.q) : null}::text, ${limit}::integer, ${offset}::integer)`.execute(
      this.db.kysely,
    );
    return {
      items: rows.flatMap((r) => (r.id === null ? [] : [toTenant(r)])),
      total: Number(rows[0]?.gesamt ?? 0),
    };
  }

  async update(actorId: string, id: string, patch: Partial<Omit<Tenant, "id" | "createdAt">>) {
    if (!UUID.test(id)) return undefined;
    // NULL heisst in der Funktion «unverändert».
    const { rows } = await sql<TenantRow>`
      SELECT * FROM kunde_aendern(${actorId}::uuid, ${id}::uuid, ${patch.name ?? null}::text, ${patch.status ?? null}::text,
                                  ${patch.licenceValidUntil ?? null}::date, ${patch.endedAt ?? null}::timestamptz,
                                  ${patch.slug ?? null}::text)`
      .execute(this.db.kysely)
      .catch(slugTaken);
    return rows[0] && toTenant(rows[0]);
  }
}

// --- Einladungen -------------------------------------------------------------------------

type InvitationRow = {
  id: string;
  kunde_id: string;
  email: string;
  rolle: Invitation["role"];
  benutzer_id: string | null;
  name?: string | null;
  erstellt_am: Date;
  laeuft_ab_am: Date;
  eingeloest_am: Date | null;
};
const toInvitation = (r: InvitationRow, tokenHash: string): Invitation => ({
  id: r.id,
  tenantId: r.kunde_id,
  email: r.email,
  role: r.rolle,
  userId: r.benutzer_id,
  name: r.name ?? null,
  tokenHash,
  createdAt: iso(r.erstellt_am),
  expiresAt: iso(r.laeuft_ab_am),
  consumedAt: r.eingeloest_am && iso(r.eingeloest_am),
});

class PostgresInvitations implements InvitationRepository {
  constructor(private readonly db: Datenbank) {}

  async create(i: Invitation) {
    await this.db.withKunde(i.tenantId, (trx) =>
      trx
        .insertInto("einladung")
        .values({
          id: i.id,
          kunde_id: i.tenantId,
          email: i.email,
          rolle: i.role,
          benutzer_id: i.userId,
          name: i.name ?? null,
          token_hash: Buffer.from(i.tokenHash, "hex"),
          erstellt_am: new Date(i.createdAt),
          laeuft_ab_am: new Date(i.expiresAt),
        })
        .execute(),
    );
  }

  async consume(tokenHash: string, now: Date) {
    if (!HEX64.test(tokenHash)) return undefined;
    // Das Token führt erst zum Kunden, daher die Funktion. Sie löst atomar ein (ein Token gilt einmal).
    const { rows } = await sql<InvitationRow>`
      SELECT * FROM einladung_einloesen(${Buffer.from(tokenHash, "hex")}::bytea, ${now}::timestamptz)`.execute(
      this.db.kysely,
    );
    return rows[0] && toInvitation(rows[0], tokenHash);
  }

  async latestForTenant(tenantId: string) {
    if (!UUID.test(tenantId)) return undefined;
    const row = await this.db.withKunde(tenantId, (trx) =>
      trx
        .selectFrom("einladung")
        .selectAll()
        .orderBy("erstellt_am", "desc")
        .orderBy("id", "desc")
        .limit(1)
        .executeTakeFirst(),
    );
    return row && toInvitation(row, row.token_hash.toString("hex"));
  }
}

// --- Benutzer ----------------------------------------------------------------------------

/** Platzhalter für Eingeladene: kein gültiger Hash, bis die Einladung eingelöst und ein Passwort gesetzt ist. */
const NO_PASSWORD = "!";

const userColumns = [
  "id",
  "kunde_id",
  "email",
  "name",
  "kunden_rolle",
  "status",
  "erstellt_am",
] as const;
const toUser = (r: {
  id: string;
  kunde_id: string;
  email: string;
  name: string;
  kunden_rolle: TenantUser["role"];
  status: TenantUser["status"];
  erstellt_am: Date;
}): TenantUser => ({
  id: r.id,
  tenantId: r.kunde_id,
  email: r.email,
  name: r.name,
  role: r.kunden_rolle,
  status: r.status,
  createdAt: iso(r.erstellt_am),
});

class PostgresUsers implements UserRepository {
  constructor(private readonly db: Datenbank) {}

  async list(tenantId: string) {
    const rows = await this.db.withKunde(tenantId, (trx) =>
      trx
        .selectFrom("benutzer")
        .select(userColumns)
        // Chef-Admins sind Anbieterkonten und gehören nie zur Benutzerliste eines Kunden.
        .where("rolle", "=", "user")
        .orderBy(sql`lower(name)`)
        .orderBy("id")
        .execute(),
    );
    return rows.map(toUser);
  }

  async get(tenantId: string, id: string) {
    if (!UUID.test(id)) return undefined;
    const row = await this.db.withKunde(tenantId, (trx) =>
      trx
        .selectFrom("benutzer")
        .select(userColumns)
        .where("id", "=", id)
        .where("rolle", "=", "user")
        .executeTakeFirst(),
    );
    return row && toUser(row);
  }

  /** Über alle Kunden, weil die Anmeldung per E-Mail läuft: dieselbe Funktion wie die Anmeldung. */
  async emailExists(email: string) {
    return (await this.db.findeBenutzerFuerAnmeldung(email)) !== undefined;
  }

  async add(user: TenantUser) {
    try {
      await this.db.withKunde(user.tenantId, (trx) =>
        trx
          .insertInto("benutzer")
          .values({
            id: user.id,
            kunde_id: user.tenantId,
            email: user.email,
            name: user.name,
            passwort_hash: NO_PASSWORD,
            // Eingeladene können sich erst anmelden, wenn die Einladung eingelöst ist.
            aktiv: user.status === "active",
            kunden_rolle: user.role,
            status: user.status,
          })
          .execute(),
      );
    } catch (err) {
      // Gleichzeitig angelegte E-Mail: dieselbe Antwort wie bei der Vorabprüfung (keine Kontoprüfung von aussen).
      if (isCode(err, "23505")) throw conflict("Benutzer kann nicht hinzugefügt werden.");
      throw err;
    }
  }

  async setRole(tenantId: string, id: string, role: TenantUser["role"]) {
    if (!UUID.test(id)) return undefined;
    const row = await this.db.withKunde(tenantId, (trx) =>
      trx
        .updateTable("benutzer")
        .set({ kunden_rolle: role })
        .where("id", "=", id)
        .where("rolle", "=", "user")
        .returning(userColumns)
        .executeTakeFirst(),
    );
    return row && toUser(row);
  }

  async remove(tenantId: string, id: string) {
    if (!UUID.test(id)) return false;
    try {
      const r = await this.db.withKunde(tenantId, (trx) =>
        trx
          .deleteFrom("benutzer")
          .where("id", "=", id)
          .where("rolle", "=", "user")
          .executeTakeFirst(),
      );
      return r.numDeletedRows > 0n;
    } catch (err) {
      // Der Benutzer hat Kalendereinträge oder Zahlungszuordnungen angelegt: sie bleiben erhalten, er auch.
      if (isCode(err, "23503"))
        throw conflict("Der Benutzer hat Daten angelegt und bleibt erhalten.");
      throw err;
    }
  }

  /** Nur aktive Admins zählen: Der letzte Admin, der sich anmelden kann, bleibt Admin. */
  async countAdmins(tenantId: string) {
    const row = await this.db.withKunde(tenantId, (trx) =>
      trx
        .selectFrom("benutzer")
        .select(sql<string>`count(*)`.as("n"))
        .where("rolle", "=", "user")
        .where("kunden_rolle", "=", "admin")
        .where("aktiv", "=", true)
        .executeTakeFirstOrThrow(),
    );
    return Number(row.n);
  }
}

// --- Organisation und Logo ---------------------------------------------------------------

class PostgresOrganisations implements OrganisationRepository {
  constructor(private readonly db: Datenbank) {}

  async get(tenantId: string) {
    const row = await this.db.withKunde(tenantId, (trx) =>
      trx
        .selectFrom("organisation")
        .select("daten")
        .where("kunde_id", "=", tenantId)
        .executeTakeFirst(),
    );
    // Geschrieben wird nur, was die Route gegen die Schemas geprüft hat.
    return row && (row.daten as unknown as Organisation);
  }

  async save(tenantId: string, organisation: Organisation) {
    const daten = JSON.stringify(organisation);
    await this.db.withKunde(tenantId, (trx) =>
      trx
        .insertInto("organisation")
        .values({ kunde_id: tenantId, daten, aktualisiert_am: new Date() })
        .onConflict((oc) =>
          oc.column("kunde_id").doUpdateSet({ daten, aktualisiert_am: new Date() }),
        )
        .execute(),
    );
  }
}

class PostgresLogos implements LogoStore {
  constructor(private readonly db: Datenbank) {}

  async put(tenantId: string, logo: { bytes: Buffer; mime: string }, now: Date) {
    const values = { mime: logo.mime as "image/png" | "image/jpeg", bytes: logo.bytes };
    await this.db.withKunde(tenantId, (trx) =>
      trx
        .insertInto("logo")
        .values({ kunde_id: tenantId, ...values, aktualisiert_am: now })
        .onConflict((oc) => oc.column("kunde_id").doUpdateSet({ ...values, aktualisiert_am: now }))
        .execute(),
    );
  }

  async get(tenantId: string) {
    const row = await this.db.withKunde(tenantId, (trx) =>
      trx
        .selectFrom("logo")
        .select(["mime", "bytes", "aktualisiert_am"])
        .where("kunde_id", "=", tenantId)
        .executeTakeFirst(),
    );
    return (
      row && {
        mime: row.mime,
        bytes: row.bytes,
        size: row.bytes.length,
        updatedAt: iso(row.aktualisiert_am),
      }
    );
  }

  async remove(tenantId: string) {
    const r = await this.db.withKunde(tenantId, (trx) =>
      trx.deleteFrom("logo").where("kunde_id", "=", tenantId).executeTakeFirst(),
    );
    return r.numDeletedRows > 0n;
  }
}

// --- Protokoll ---------------------------------------------------------------------------

/**
 * Protokoll eines Kunden in `audit_log` (nur anhängen, RLS). Akteur und Ziel stehen zusätzlich als Text in
 * `details`, damit der Eintrag auch nach dem Entfernen des Benutzers lesbar bleibt. Die Eintrags-ID vergibt die
 * Datenbank (fortlaufend); die ID des Aufrufers wird nicht übernommen.
 */
class PostgresAudit implements AuditRepository {
  constructor(private readonly db: Datenbank) {}

  async append(scope: string, e: AuditEntry) {
    const details = JSON.stringify({ akteur_email: e.actor, ziel_text: e.target });
    await this.db.withKunde(scope, (trx) =>
      sql`
        INSERT INTO audit_log (kunde_id, benutzer_id, zeitpunkt, aktion, details)
        VALUES (${scope}::uuid, (SELECT b.id FROM benutzer b WHERE b.id = ${e.actorId}::uuid),
                ${e.at}::timestamptz, ${e.action}, ${details}::jsonb)`.execute(trx),
    );
  }

  async query(scope: string, f: AuditFilter, { limit, offset }: PageRequest) {
    const actor = sql`coalesce(a.details->>'akteur_email', b.email, '')`;
    const target = sql`coalesce(a.details->>'ziel_text', '')`;
    const conditions = [
      sql`a.kunde_id = ${scope}::uuid`,
      ...(f.from ? [sql`a.zeitpunkt >= ${f.from}::timestamptz`] : []),
      ...(f.to ? [sql`a.zeitpunkt <= ${f.to}::timestamptz`] : []),
      ...(f.actor ? [sql`${actor} ILIKE ${contains(f.actor)}`] : []),
      ...(f.action ? [sql`a.aktion = ${f.action}`] : []),
      ...(f.q
        ? [sql`(a.aktion || ' ' || ${target} || ' ' || ${actor}) ILIKE ${contains(f.q)}`]
        : []),
    ];
    const from = sql`FROM audit_log a LEFT JOIN benutzer b ON b.id = a.benutzer_id AND b.kunde_id = a.kunde_id
                     WHERE ${sql.join(conditions, sql` AND `)}`;
    return this.db.withKunde(scope, async (trx) => {
      const { rows } = await sql<{
        id: string;
        zeitpunkt: Date;
        benutzer_id: string | null;
        aktion: string;
        actor: string;
        target: string;
      }>`SELECT a.id::text AS id, a.zeitpunkt, a.benutzer_id, a.aktion, ${actor} AS actor, ${target} AS target
         ${from} ORDER BY a.zeitpunkt DESC, a.id DESC LIMIT ${limit} OFFSET ${offset}`.execute(trx);
      const total = await sql<{ n: string }>`SELECT count(*) AS n ${from}`.execute(trx);
      return {
        items: rows.map((r) => ({
          id: r.id,
          at: iso(r.zeitpunkt),
          actorId: r.benutzer_id ?? "",
          actor: r.actor,
          action: r.aktion,
          target: r.target,
        })),
        total: Number(total.rows[0]?.n ?? 0),
      };
    });
  }
}

/** Plattformprotokoll des Chef-Admins: nur über Funktionen erreichbar, Schreiben prüft den Akteur in der Datenbank. */
class PostgresPlatformAudit implements AuditRepository {
  constructor(private readonly db: Datenbank) {}

  async append(scope: string, e: AuditEntry) {
    if (scope !== "platform") throw new Error("Unbekannter Protokollbereich");
    await sql`SELECT plattform_protokoll_anhaengen(${e.actorId}::uuid, ${e.id}::uuid, ${e.at}::timestamptz, ${e.actor}, ${e.action}, ${e.target})`.execute(
      this.db.kysely,
    );
  }

  async query(scope: string, f: AuditFilter, { limit, offset }: PageRequest) {
    if (scope !== "platform") throw new Error("Unbekannter Protokollbereich");
    const { rows } = await sql<{
      id: string | null; // NULL: leere Seite, die Zeile trägt nur `gesamt`
      zeitpunkt: Date;
      akteur_id: string;
      akteur: string;
      aktion: string;
      ziel: string;
      gesamt: string;
    }>`SELECT * FROM plattform_protokoll_lesen(${f.from ?? null}::timestamptz, ${f.to ?? null}::timestamptz,
         ${f.actor ? contains(f.actor) : null}::text, ${f.action ?? null}::text, ${f.q ? contains(f.q) : null}::text,
         ${limit}::integer, ${offset}::integer)`.execute(this.db.kysely);
    return {
      items: rows
        .filter((r) => r.id !== null)
        .map((r) => ({
          id: r.id as string,
          at: iso(r.zeitpunkt),
          actorId: r.akteur_id,
          actor: r.akteur,
          action: r.aktion,
          target: r.ziel,
        })),
      total: Number(rows[0]?.gesamt ?? 0),
    };
  }
}

// --- Konto des Chef-Admins ---------------------------------------------------------------

class PostgresChefs implements ChefAccountRepository {
  constructor(private readonly db: Datenbank) {}

  async get(id: string) {
    if (!UUID.test(id)) return undefined;
    const { rows } = await sql<ChefRow>`SELECT * FROM chef_konto(${id}::uuid)`.execute(
      this.db.kysely,
    );
    return rows[0] && toChef(rows[0]);
  }

  async update(id: string, patch: { displayName: string }) {
    if (!UUID.test(id)) return undefined;
    const { rows } = await sql<ChefRow>`
      SELECT * FROM chef_konto_aendern(${id}::uuid, ${patch.displayName})`.execute(this.db.kysely);
    return rows[0] && toChef(rows[0]);
  }
}
type ChefRow = { id: string; email: string; name: string };
const toChef = (r: ChefRow): ChefAccount => ({ id: r.id, email: r.email, displayName: r.name });

// --- Schlüsselrotation -------------------------------------------------------------------

const ROTATION_KINDS: RotationKind[] = ["mail", "totp"];

/**
 * Rotation durch den Chef-Admin über die Funktionen `…_chef` (Rolle stammbuch_app): die Datenbank prüft den Akteur
 * bei jedem Schritt. Der Lauf ist derselbe wie im Worker (`rotateAll`, wiederaufnehmbar, Compare-and-swap).
 * Läuft dieselbe Art in dieser Instanz schon, ist ein zweiter Aufruf ein Konflikt (409).
 */
class PostgresRotation implements RotationControl {
  private readonly running = new Set<RotationKind>();
  constructor(
    private readonly db: Datenbank,
    private readonly boxes: Partial<Record<RotationKind, SecretBox>>,
    private readonly clock: () => Date,
  ) {}

  async run(actorId: string, kind: RotationKind) {
    const box = this.boxes[kind];
    if (!box) return undefined;
    if (!UUID.test(actorId)) throw new Error("Ungültiger Akteur");
    if (this.running.has(kind)) throw conflict("Die Rotation läuft bereits.");
    this.running.add(kind);
    try {
      const result = await rotateAll(box, pgRotationSource(this.db, kind, actorId));
      // Ein abgebrochener Lauf kennt die unlesbaren Objekte nur teilweise (hier nie: kein Signal), Stand nicht anfassen.
      if (!result.aborted) {
        await recordRotationStateAsChef(this.db, actorId, kind, this.clock(), result.failed);
      }
      return result;
    } finally {
      this.running.delete(kind);
    }
  }

  async status(actorId: string) {
    if (!UUID.test(actorId)) throw new Error("Ungültiger Akteur");
    const rows = await readRotationState(this.db, actorId);
    return Object.fromEntries(
      ROTATION_KINDS.map((kind) => {
        const row = rows.find((r) => r.kind === kind);
        return [
          kind,
          {
            configured: kind in this.boxes,
            lastRunAt: row ? iso(row.ranAt) : null,
            unreadable: row?.unreadable ?? [],
          },
        ];
      }),
    ) as Record<RotationKind, RotationStatus>;
  }
}

// --- Identität ---------------------------------------------------------------------------

/**
 * Bildet die Rolle der Anmeldung (`user`, `chief_admin`) auf die Platform ab. Die Sitzung (Auth-Modul) liefert
 * Kunde, Benutzer und Rolle; alles Weitere kommt aus der Datenbank, nie aus dem Request (SR-13).
 *
 * - `chief_admin` wird zum Chef-Admin, sofern das Konto in der Datenbank noch ein aktiver `chief_admin` ist.
 *   Er wird nie zum Kundenbenutzer: der Anbieter sieht keine Kundendaten.
 * - `user` wird zum Kundenbenutzer mit der Kundenrolle aus `benutzer.kunden_rolle` (`admin` oder `user`).
 *   Nur aktive Benutzer mit eingelöster Einladung. Die Kundenrolle gibt nie Anbieterrechte.
 * - Alles andere (keine Sitzung, unbekannter Benutzer, unbekannte Rolle) ergibt `null`, also 401 (SR-54).
 */
function principalResolver(db: Datenbank, chefs: ChefAccountRepository): PrincipalResolver {
  return async (request) => {
    const auth = await request.server.authenticateRequest(request);
    if (!auth) return null;
    if (auth.rolle === "chief_admin") {
      const account = await chefs.get(auth.userId);
      return account ? { kind: "chef", accountId: account.id, email: account.email } : null;
    }
    if (auth.rolle !== "user") return null;
    const row = await db.withKunde(auth.tenantId, (trx) =>
      trx
        .selectFrom("benutzer")
        .select(["email", "kunden_rolle", "aktiv", "status"])
        .where("id", "=", auth.userId)
        .where("rolle", "=", "user")
        .executeTakeFirst(),
    );
    if (!row?.aktiv || row.status !== "active") return null;
    return {
      kind: "customer",
      userId: auth.userId,
      tenantId: auth.tenantId,
      email: row.email,
      role: row.kunden_rolle,
    };
  };
}

/** Baut die Platform auf PostgreSQL. API und Worker teilen den Stand über dieselbe Datenbank. */
export function createPostgresPlatform(
  db: Datenbank,
  options: {
    invitationSender: InvitationSender;
    clock?: () => Date;
    /** Schlüsselringe der Geheimnisse, die der Chef-Admin rotieren darf. Fehlende Art: nicht konfiguriert. */
    rotationBoxes?: Partial<Record<RotationKind, SecretBox>>;
  },
): Platform {
  const chefs = new PostgresChefs(db);
  const clock = options.clock ?? (() => new Date());
  return {
    tenants: new PostgresTenants(db),
    invitations: new PostgresInvitations(db),
    invitationSender: options.invitationSender,
    users: new PostgresUsers(db),
    organisations: new PostgresOrganisations(db),
    logos: new PostgresLogos(db),
    audit: new PostgresAudit(db),
    platformAudit: new PostgresPlatformAudit(db),
    chefs,
    rotation: new PostgresRotation(db, options.rotationBoxes ?? {}, clock),
    principal: principalResolver(db, chefs),
    clock,
  };
}
