import { z } from "zod";
import { type CalendarEvent, TIME_ZONE, localToDate, toLocalString } from "./domain.js";

/** Steuerzeichen sind in einzeiligen Feldern verboten (Header- und Log-Injektion). */
const noControl = (s: string) => !/\p{Cc}/u.test(s);
/** Mehrzeilig: Zeilenumbruch und Tab sind erlaubt, sonst keine Steuerzeichen. */
const noControlExceptWhitespace = (s: string) => !/[^\P{Cc}\n\r\t]/u.test(s);

const line = (max: number) => z.string().trim().max(max).refine(noControl);

/**
 * Zeit als lokale Wandzeit `YYYY-MM-DDTHH:mm` (gilt in Europe/Zurich) oder als ISO-8601 mit
 * Offset bzw. Z. Ergebnis ist immer ein `Date` (UTC-Zeitpunkt).
 */
export function parseTime(input: string): Date | null {
  const local = localToDate(input);
  if (local) return local;
  const iso = z.iso.datetime({ offset: true }).safeParse(input);
  return iso.success ? new Date(iso.data) : null;
}

const time = z
  .string()
  .max(40)
  .transform((s, ctx) => {
    const d = parseTime(s);
    if (!d) {
      ctx.addIssue({ code: "custom", message: "Ungültige Zeit" });
      return z.NEVER;
    }
    return d;
  });

export const eventBody = z.object({
  title: line(200).min(1),
  description: z.string().max(5000).refine(noControlExceptWhitespace).default(""),
  location: line(200).default(""),
  startsAt: time,
  endsAt: time,
  registrationDeadline: time.nullable().default(null),
  maxGuests: z.number().int().min(0).max(10).default(0),
});

/** Beim Ändern sind alle Felder optional; `registrationDeadline: null` entfernt die Frist. */
export const eventPatchBody = z.object({
  title: line(200).min(1).optional(),
  description: z.string().max(5000).refine(noControlExceptWhitespace).optional(),
  location: line(200).optional(),
  startsAt: time.optional(),
  endsAt: time.optional(),
  registrationDeadline: time.nullable().optional(),
  maxGuests: z.number().int().min(0).max(10).optional(),
});

export const idParams = z.object({ id: z.uuid() });

export const listQuery = z.object({
  from: time,
  to: time,
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export const inviteBody = z.object({
  recipients: z
    .array(z.object({ email: z.email().max(254), name: line(120).min(1) }))
    .min(1)
    .max(200),
});

export const respondBody = z.object({
  status: z.enum(["accepted", "declined"]),
  guests: z.number().int().min(0).max(10).default(0),
  note: z.string().trim().max(500).refine(noControlExceptWhitespace).default(""),
});

export const tokenParams = z.object({ token: z.string().max(100) });

/** Ausgabe: nur die Felder, die der Client braucht (SR-74). */
export function eventDto(e: CalendarEvent) {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    location: e.location,
    timeZone: TIME_ZONE,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt.toISOString(),
    startsAtLocal: toLocalString(e.startsAt),
    endsAtLocal: toLocalString(e.endsAt),
    registrationDeadline: e.registrationDeadline?.toISOString() ?? null,
    registrationDeadlineLocal: e.registrationDeadline
      ? toLocalString(e.registrationDeadline)
      : null,
    maxGuests: e.maxGuests,
  };
}
