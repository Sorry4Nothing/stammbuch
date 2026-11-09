import { createHash, randomBytes } from "node:crypto";

/** Alle Zeiten des Kalenders werden in dieser Zone dargestellt und eingegeben. */
export const TIME_ZONE = "Europe/Zurich";
/** Frist nach Event-Ende, nach der Kalendereintrag und Rückmeldungen gelöscht werden. */
export const RETENTION_MS = 24 * 60 * 60 * 1000;

export type ResponseStatus = "accepted" | "declined";

export interface CalendarEvent {
  id: string;
  tenantId: string;
  title: string;
  description: string;
  location: string;
  startsAt: Date;
  endsAt: Date;
  /** Null: Rückmeldungen sind bis zum Beginn des Events möglich. */
  registrationDeadline: Date | null;
  /** Wie viele Begleitpersonen pro Zusage erlaubt sind (0 = keine). */
  maxGuests: number;
  /** Adressliste («Einladung an»): Gruppe der Personenverwaltung. Null: keine festgelegt. */
  inviteGroupId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Invitation {
  id: string;
  tenantId: string;
  eventId: string;
  email: string;
  name: string;
  /** Mitglied, an das die Einladung ging. Null bei freien Adressen. */
  memberId: string | null;
  /** SHA-256 des Tokens. Das Token selbst steht nur in der Mail. */
  tokenHash: string;
  createdAt: Date;
}

export interface EventResponse {
  id: string;
  tenantId: string;
  eventId: string;
  invitationId: string;
  status: ResponseStatus;
  guests: number;
  note: string;
  respondedAt: Date;
}

/** 256 Bit aus dem CSPRNG, URL-sicher (43 Zeichen). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Das Token hat 256 Bit Entropie, ein schneller Hash genügt (kein Passwort). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// --- Zeitzone -------------------------------------------------------------------------------

const partsFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** Lokale Wandzeit in Europe/Zurich als `YYYY-MM-DDTHH:mm`. */
export function toLocalString(date: Date): string {
  const p = Object.fromEntries(partsFormat.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p["year"]}-${p["month"]}-${p["day"]}T${p["hour"]}:${p["minute"]}`;
}

/** Anzeigeformat für Mails und Excel: `01.12.2026 18:00`. */
export function formatLocal(date: Date): string {
  const [d = "", t = ""] = toLocalString(date).split("T");
  const [y, m, day] = d.split("-");
  return `${day}.${m}.${y} ${t}`;
}

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * Wandzeit `YYYY-MM-DDTHH:mm` in Europe/Zurich nach UTC. Gibt null zurück, wenn die Zeit
 * nicht existiert (Sprung auf Sommerzeit) oder kein gültiges Datum ist.
 * Bei der doppelten Stunde im Herbst gilt die erste (Sommerzeit).
 */
export function localToDate(local: string): Date | null {
  const m = LOCAL_PATTERN.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  // Zürich liegt bei UTC+1 oder UTC+2: beide Kandidaten prüfen, den früheren zuerst.
  for (const offsetH of [2, 1]) {
    const candidate = new Date(wall - offsetH * 3_600_000);
    if (toLocalString(candidate) === local) return candidate;
  }
  return null;
}
