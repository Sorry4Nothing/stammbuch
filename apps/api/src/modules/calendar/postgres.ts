import type { Datenbank, KalenderEinladung, KalenderEvent } from "@stammbuch/db";
import type { CalendarEvent, EventResponse, Invitation } from "./domain.js";
import type { CalendarRepository } from "./ports.js";

const toEvent = (r: KalenderEvent): CalendarEvent => ({
  id: r.id,
  tenantId: r.kunde_id,
  title: r.titel,
  description: r.beschreibung,
  location: r.ort,
  startsAt: r.beginnt_am,
  endsAt: r.endet_am,
  registrationDeadline: r.anmeldeschluss_am,
  maxGuests: r.max_begleiter,
  createdBy: r.erstellt_von,
  createdAt: r.erstellt_am,
  updatedAt: r.geaendert_am,
});

const toInvitation = (r: Omit<KalenderEinladung, "token_hash">, tokenHash: string): Invitation => ({
  id: r.id,
  tenantId: r.kunde_id,
  eventId: r.event_id,
  email: r.email,
  name: r.name,
  tokenHash,
  createdAt: r.erstellt_am,
});

/**
 * PostgreSQL-Implementierung. Jede Abfrage läuft in `withKunde(tenantId)`: Der Mandant kommt aus der
 * Sitzung (SR-13), Row-Level-Security trennt die Kunden zusätzlich zur WHERE-Klausel (SR-11).
 * Das Token-Hash ist in der Domäne hex (SHA-256), in der Datenbank 32 Byte.
 */
export class PostgresCalendarRepository implements CalendarRepository {
  constructor(private readonly db: Datenbank) {}

  async insertEvent(e: CalendarEvent) {
    await this.db.withKunde(e.tenantId, (t) =>
      t
        .insertInto("kalender_event")
        .values({
          id: e.id,
          kunde_id: e.tenantId,
          titel: e.title,
          beschreibung: e.description,
          ort: e.location,
          beginnt_am: e.startsAt,
          endet_am: e.endsAt,
          anmeldeschluss_am: e.registrationDeadline,
          max_begleiter: e.maxGuests,
          erstellt_von: e.createdBy,
          erstellt_am: e.createdAt,
          geaendert_am: e.updatedAt,
        })
        .execute(),
    );
  }

  async updateEvent(e: CalendarEvent) {
    const res = await this.db.withKunde(e.tenantId, (t) =>
      t
        .updateTable("kalender_event")
        .set({
          titel: e.title,
          beschreibung: e.description,
          ort: e.location,
          beginnt_am: e.startsAt,
          endet_am: e.endsAt,
          anmeldeschluss_am: e.registrationDeadline,
          max_begleiter: e.maxGuests,
          geaendert_am: e.updatedAt,
        })
        .where("id", "=", e.id)
        .where("kunde_id", "=", e.tenantId)
        .executeTakeFirst(),
    );
    if (res.numUpdatedRows === 0n) throw new Error("Event existiert nicht");
  }

  async getEvent(tenantId: string, id: string) {
    const row = await this.db.withKunde(tenantId, (t) =>
      t
        .selectFrom("kalender_event")
        .selectAll()
        .where("id", "=", id)
        .where("kunde_id", "=", tenantId)
        .executeTakeFirst(),
    );
    return row ? toEvent(row) : null;
  }

  async listEvents(tenantId: string, { from, to, limit }: { from: Date; to: Date; limit: number }) {
    const rows = await this.db.withKunde(tenantId, (t) =>
      t
        .selectFrom("kalender_event")
        .selectAll()
        .where("kunde_id", "=", tenantId)
        .where("beginnt_am", ">=", from)
        .where("beginnt_am", "<", to)
        .orderBy("beginnt_am")
        .orderBy("id")
        .limit(limit)
        .execute(),
    );
    return rows.map(toEvent);
  }

  async insertInvitation(i: Invitation) {
    await this.db.withKunde(i.tenantId, (t) =>
      t
        .insertInto("kalender_einladung")
        .values({
          id: i.id,
          kunde_id: i.tenantId,
          event_id: i.eventId,
          email: i.email,
          name: i.name,
          token_hash: Buffer.from(i.tokenHash, "hex"),
          erstellt_am: i.createdAt,
        })
        .execute(),
    );
  }

  async deleteInvitation(tenantId: string, id: string) {
    await this.db.withKunde(tenantId, (t) =>
      t
        .deleteFrom("kalender_einladung")
        .where("id", "=", id)
        .where("kunde_id", "=", tenantId)
        .execute(),
    );
  }

  /** Öffentliche Route, Mandant noch unbekannt: schmale SECURITY-DEFINER-Funktion statt Tabellenzugriff. */
  async getInvitationByTokenHash(tokenHash: string) {
    const row = await this.db.loeseKalenderEinladungAuf(Buffer.from(tokenHash, "hex"));
    return row ? toInvitation(row, tokenHash) : null;
  }

  async listInvitations(tenantId: string, eventId: string) {
    const rows = await this.db.withKunde(tenantId, (t) =>
      t
        .selectFrom("kalender_einladung")
        .selectAll()
        .where("kunde_id", "=", tenantId)
        .where("event_id", "=", eventId)
        .orderBy("erstellt_am")
        .orderBy("id")
        .execute(),
    );
    return rows.map((r) => toInvitation(r, r.token_hash.toString("hex")));
  }

  async upsertResponse(r: EventResponse) {
    await this.db.withKunde(r.tenantId, (t) =>
      t
        .insertInto("kalender_antwort")
        .values({
          id: r.id,
          kunde_id: r.tenantId,
          event_id: r.eventId,
          einladung_id: r.invitationId,
          status: r.status,
          begleiter: r.guests,
          notiz: r.note,
          geantwortet_am: r.respondedAt,
        })
        .onConflict((oc) =>
          oc.column("einladung_id").doUpdateSet((eb) => ({
            status: eb.ref("excluded.status"),
            begleiter: eb.ref("excluded.begleiter"),
            notiz: eb.ref("excluded.notiz"),
            geantwortet_am: eb.ref("excluded.geantwortet_am"),
          })),
        )
        .execute(),
    );
  }

  async listResponses(tenantId: string, eventId: string) {
    const rows = await this.db.withKunde(tenantId, (t) =>
      t
        .selectFrom("kalender_antwort")
        .selectAll()
        .where("kunde_id", "=", tenantId)
        .where("event_id", "=", eventId)
        .execute(),
    );
    return rows.map((r): EventResponse => ({
      id: r.id,
      tenantId: r.kunde_id,
      eventId: r.event_id,
      invitationId: r.einladung_id,
      status: r.status,
      guests: r.begleiter,
      note: r.notiz,
      respondedAt: r.geantwortet_am,
    }));
  }
}
