/**
 * Zugriff auf die öffentlichen Routen ohne Anmeldung: Registrierung (`/public/:kunde/registrierung/*`)
 * und Einladungs-Antwort (`/calendar/public/responses/:token`). Gleiche Origin, keine Cookies, kein CSRF-Token
 * (es gibt keine Sitzung). Fehlertexte der API gelangen nie in die Oberfläche; nur der Status zählt.
 */

export interface PersonRegistration {
  kind: "person";
  firstName: string;
  lastName: string;
  street: string;
  zip: string;
  city: string;
  email: string;
  /** TT.MM.JJJJ. Die API hat dafür kein Feld; der Wert wird nicht übertragen. */
  birthDate?: string;
}

export interface FirmaRegistration {
  kind: "firma";
  name: string;
  uid: string;
  mwst?: string;
  street: string;
  zip: string;
  city: string;
  /** Die API hat dafür kein Feld; der Wert wird nicht übertragen. */
  contact: string;
  email: string;
  phone?: string;
}

export type RegistrationInput = PersonRegistration | FirmaRegistration;

export type RegistrationOutcome =
  /** Angenommen. `reference` fehlt, solange die API keine Referenz liefert. */
  | { status: "accepted"; reference?: string }
  /** Die API hat das Formular abgelehnt (zu schnell, zu alt, ungültig): neu laden und erneut senden. */
  | { status: "rejected" }
  /** Unbekannter Verein in der Adresse. */
  | { status: "unknown" }
  | { status: "tooMany" };

export interface RegistrationService {
  /** Holt das Formular-Token (Bot-Schutz). `null`: Verein unbekannt. */
  begin: (kunde: string) => Promise<string | null>;
  submit: (
    kunde: string,
    formToken: string,
    /** Honeypot: bleibt bei Menschen leer. */
    website: string,
    input: RegistrationInput,
  ) => Promise<RegistrationOutcome>;
}

export interface InvitationEvent {
  title: string;
  location: string;
  startsAt: string;
  endsAt: string;
  registrationDeadline: string | null;
  maxGuests: number;
}

export type AnswerStatus = "accepted" | "declined";

export interface InvitationAnswer {
  status: AnswerStatus;
  guests: number;
  note: string;
}

export interface InvitationView {
  event: InvitationEvent;
  /** Anmeldeschluss noch nicht erreicht. */
  open: boolean;
  /** Name der eingeladenen Person. */
  invitee: string;
  response: InvitationAnswer | null;
}

export type RespondOutcome =
  | { status: "ok"; view: InvitationView }
  | { status: "closed" }
  | { status: "invalid" }
  | { status: "rejected" };

export interface InvitationService {
  /** `null`: Link unbekannt, abgelaufen oder ungültig (der Server unterscheidet das nie). */
  load: (token: string) => Promise<InvitationView | null>;
  respond: (token: string, answer: InvitationAnswer) => Promise<RespondOutcome>;
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null;
const unexpected = (what: string, status: number) =>
  new Error(`Unerwartete Antwort (${what}, ${status})`);

async function call(
  fetchFn: typeof fetch,
  method: "GET" | "POST",
  path: string,
  payload?: object,
): Promise<{ status: number; body: unknown }> {
  const res = await fetchFn(path, {
    method,
    headers: {
      Accept: "application/json",
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
    credentials: "omit",
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const nonEmpty = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : undefined);

export function createHttpRegistrationService(
  fetchFn: typeof fetch = (...args) => fetch(...args),
): RegistrationService {
  const base = (kunde: string) => `/public/${encodeURIComponent(kunde)}/registrierung`;
  return {
    async begin(kunde) {
      const r = await call(fetchFn, "GET", `${base(kunde)}/formular`);
      if (r.status === 404) return null;
      if (r.status !== 200 || !isRecord(r.body) || typeof r.body["formToken"] !== "string") {
        throw unexpected("Formular", r.status);
      }
      return r.body["formToken"];
    },
    async submit(kunde, formToken, website, input) {
      const adresse = {
        strasse: input.street.trim(),
        plz: input.zip.trim(),
        ort: input.city.trim(),
        land: "CH",
      };
      const payload =
        input.kind === "person"
          ? {
              website,
              formToken,
              mitglied: {
                typ: "einzel",
                vorname: input.firstName.trim(),
                nachname: input.lastName.trim(),
                email: input.email.trim(),
                adresse,
              },
            }
          : {
              website,
              formToken,
              firma: {
                name: input.name.trim(),
                uid: input.uid.trim(),
                mwstNr: nonEmpty(input.mwst),
                adresse,
                email: input.email.trim(),
                telefon: nonEmpty(input.phone),
              },
            };
      const r = await call(
        fetchFn,
        "POST",
        `${base(kunde)}/${input.kind === "person" ? "person" : "firma"}`,
        payload,
      );
      if (r.status === 202) return { status: "accepted" };
      if (r.status === 400) return { status: "rejected" };
      if (r.status === 404) return { status: "unknown" };
      if (r.status === 429) return { status: "tooMany" };
      throw unexpected("Registrierung", r.status);
    },
  };
}

function viewOf(body: unknown): InvitationView {
  const event = isRecord(body) ? body["event"] : undefined;
  const invitee = isRecord(body) ? body["invitee"] : undefined;
  const response = isRecord(body) ? body["response"] : undefined;
  if (
    !isRecord(body) ||
    !isRecord(event) ||
    !isRecord(invitee) ||
    typeof event["title"] !== "string" ||
    typeof event["startsAt"] !== "string" ||
    typeof event["endsAt"] !== "string" ||
    typeof body["open"] !== "boolean"
  ) {
    throw new Error("Unerwartete Antwort (Einladung)");
  }
  const status = isRecord(response) ? response["status"] : undefined;
  return {
    event: {
      title: event["title"],
      location: typeof event["location"] === "string" ? event["location"] : "",
      startsAt: event["startsAt"],
      endsAt: event["endsAt"],
      registrationDeadline:
        typeof event["registrationDeadline"] === "string" ? event["registrationDeadline"] : null,
      maxGuests: typeof event["maxGuests"] === "number" ? event["maxGuests"] : 0,
    },
    open: body["open"],
    invitee: typeof invitee["name"] === "string" ? invitee["name"] : "",
    response:
      isRecord(response) && (status === "accepted" || status === "declined")
        ? {
            status,
            guests: typeof response["guests"] === "number" ? response["guests"] : 0,
            note: typeof response["note"] === "string" ? response["note"] : "",
          }
        : null,
  };
}

export function createHttpInvitationService(
  fetchFn: typeof fetch = (...args) => fetch(...args),
): InvitationService {
  const path = (token: string) => `/calendar/public/responses/${encodeURIComponent(token)}`;
  return {
    async load(token) {
      const r = await call(fetchFn, "GET", path(token));
      if (r.status === 404) return null;
      if (r.status !== 200) throw unexpected("Einladung", r.status);
      return viewOf(r.body);
    },
    async respond(token, answer) {
      const r = await call(fetchFn, "POST", path(token), answer);
      if (r.status === 200) return { status: "ok", view: viewOf(r.body) };
      if (r.status === 409) return { status: "closed" };
      if (r.status === 404) return { status: "invalid" };
      if (r.status === 400) return { status: "rejected" };
      throw unexpected("Antwort", r.status);
    },
  };
}
