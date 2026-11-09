import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { AuthLayout } from "../auth/AuthLayout";
import { contactEmail, orgName } from "../config";
import { t, tp } from "../i18n";
import { Button, Icon, Message, RadioGroup, TextArea, TextField } from "../ui";
import { formatRange, formatStamp } from "./format";
import {
  createHttpInvitationService,
  type AnswerStatus,
  type InvitationService,
  type InvitationView,
} from "./publicService";

const defaultService = createHttpInvitationService();

const NOTE_MAX = 500;

interface Errors {
  answer?: string;
  guests?: string;
  note?: string;
}

/** Datum, Ort und Anmeldeschluss, wie in 1.10 und 1.11. */
function EventFacts({ view, invitee }: { view: InvitationView; invitee?: boolean }) {
  const { event } = view;
  return (
    <dl className="kv">
      <dt>{t("public.response.date")}</dt>
      <dd>{formatRange(event.startsAt, event.endsAt)}</dd>
      {event.location && (
        <>
          <dt>{t("public.response.place")}</dt>
          <dd>{event.location}</dd>
        </>
      )}
      {event.registrationDeadline && (
        <>
          <dt>{t("public.response.deadline")}</dt>
          <dd>{formatStamp(event.registrationDeadline)}</dd>
        </>
      )}
      {invitee && view.invitee && (
        <>
          <dt>{t("public.response.invitee")}</dt>
          <dd>{view.invitee}</dd>
        </>
      )}
    </dl>
  );
}

/**
 * Antwort auf eine Einladung (Design 1.10), nach Anmeldeschluss (1.11) und Danke (1.12) unter
 * `/antwort/:token`. Das Token steht im Pfad, weil die API den Link so in die Einladung schreibt.
 * Ungültig und abgelaufen sind für den Server dasselbe (SR-05).
 */
export function ResponsePage({ service = defaultService }: { service?: InvitationService }) {
  const { token = "" } = useParams();
  const [view, setView] = useState<InvitationView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "invalid" | "unavailable">("loading");
  const [phase, setPhase] = useState<"form" | "thanks">("form");
  const [answer, setAnswer] = useState<AnswerStatus | "">("");
  const [guests, setGuests] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [alert, setAlert] = useState<{ title: string; text: string } | null>(null);
  const [later, setLater] = useState(false);
  const [busy, setBusy] = useState(false);

  /** Übernimmt die Ansicht des Servers samt der letzten Antwort ins Formular. */
  const adopt = useCallback((next: InvitationView) => {
    setView(next);
    setAnswer(next.response?.status ?? "");
    setGuests(next.response && next.response.guests > 0 ? String(next.response.guests) : "");
    setNote(next.response?.note ?? "");
    setState("ready");
  }, []);

  useEffect(() => {
    let active = true;
    service.load(token).then(
      (loaded) => {
        if (!active) return;
        if (loaded) adopt(loaded);
        else setState("invalid");
      },
      () => active && setState("unavailable"),
    );
    return () => {
      active = false;
    };
  }, [service, token, adopt]);

  const title = view ? t("public.response.title", { title: view.event.title }) : undefined;

  if (state === "loading") {
    return (
      <AuthLayout title={t("public.response.loadingTitle")} wide>
        <span className="muted" role="status">
          {t("public.response.loading")}
        </span>
      </AuthLayout>
    );
  }

  if (state === "invalid" || state === "unavailable" || !view) {
    const bad = state === "invalid";
    return (
      <AuthLayout title={t("public.response.loadingTitle")} wide focusTitle>
        <Message
          tone="error"
          title={bad ? t("public.response.invalidTitle") : t("public.unavailableTitle")}
        >
          {bad ? t("public.response.invalidText") : t("public.unavailableText")}
        </Message>
      </AuthLayout>
    );
  }

  const saved = view.response;

  // 1.11: Anmeldeschluss vorbei. Die letzte Rückmeldung bleibt gültig.
  if (!view.open) {
    const kept = saved
      ? saved.status === "declined"
        ? t("public.closed.declined")
        : saved.guests > 0
          ? tp("public.closed.acceptedGuests", saved.guests)
          : t("public.closed.accepted")
      : null;
    return (
      <AuthLayout title={t("public.closed.title")} subtitle={view.event.title} wide focusTitle>
        <Message tone="warning" title={t("public.closed.alertTitle")}>
          {kept ? t("public.closed.kept", { answer: kept }) : t("public.closed.none")}
        </Message>
        <EventFacts view={view} />
        <div className="auth__block auth__block--tight">
          <span className="muted">{t("public.closed.help")}</span>
          {contactEmail && (
            <a className="lk" href={`mailto:${contactEmail}`}>
              {contactEmail}
            </a>
          )}
        </div>
      </AuthLayout>
    );
  }

  // 1.12: Danke
  if (phase === "thanks" && saved) {
    return (
      <AuthLayout title={t("public.thanks.title")} subtitle={view.event.title} wide focusTitle>
        <Message
          tone="ok"
          title={t(
            saved.status === "accepted" ? "public.thanks.accepted" : "public.thanks.declined",
          )}
        />
        <dl className="kv">
          <dt>{t("public.thanks.answer")}</dt>
          <dd>
            {t(saved.status === "accepted" ? "public.closed.accepted" : "public.closed.declined")}
          </dd>
          {saved.status === "accepted" && (
            <>
              <dt>{t("public.thanks.guests")}</dt>
              <dd className="num">{saved.guests}</dd>
            </>
          )}
          {saved.note && (
            <>
              <dt>{t("public.thanks.note")}</dt>
              <dd>{saved.note}</dd>
            </>
          )}
        </dl>
        <div className="auth__block">
          {view.event.registrationDeadline && (
            <span className="muted">
              {t("public.thanks.until", { deadline: formatStamp(view.event.registrationDeadline) })}
            </span>
          )}
          <div className="auth__actions">
            <Button icon="edit" onClick={() => setPhase("form")}>
              {t("public.thanks.change")}
            </Button>
          </div>
        </div>
      </AuthLayout>
    );
  }

  const max = view.event.maxGuests;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found: Errors = {};
    if (!answer) found.answer = t("public.response.answerRequired");
    const n = guests.trim() === "" ? 0 : Number(guests.trim());
    if (answer === "accepted" && (!Number.isInteger(n) || n < 0 || n > max)) {
      found.guests = t("public.response.guestsInvalid", { max });
    }
    if ([...note.trim()].length > NOTE_MAX) found.note = t("public.response.noteTooLong");
    setErrors(found);
    const count = Object.keys(found).length;
    if (count > 0 || !answer) {
      setAlert({ title: tp("auth.fieldsInvalid", count), text: t("public.fieldsInvalidText") });
      return;
    }
    setAlert(null);
    setLater(false);
    setBusy(true);
    try {
      const result = await service.respond(token, {
        status: answer,
        guests: answer === "accepted" ? n : 0,
        note: note.trim(),
      });
      if (result.status === "ok") {
        adopt(result.view);
        setPhase("thanks");
      } else if (result.status === "invalid") {
        setState("invalid");
      } else if (result.status === "closed") {
        // Der Anmeldeschluss ist während des Ausfüllens verstrichen: Stand neu laden, dann zeigt sich 1.11.
        const fresh = await service.load(token);
        if (fresh) adopt(fresh);
        else setState("invalid");
      } else {
        setAlert({ title: tp("auth.fieldsInvalid", 1), text: t("public.fieldsInvalidText") });
      }
    } catch {
      setAlert({ title: t("public.unavailableTitle"), text: t("public.unavailableText") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={title ?? ""} subtitle={orgName || undefined} wide>
      <EventFacts view={view} invitee />
      <form className="auth__form" onSubmit={submit} noValidate>
        {alert && (
          <Message tone="error" title={alert.title}>
            {alert.text}
          </Message>
        )}
        {later && <Message tone="neutral">{t("public.response.laterText")}</Message>}
        <div className="auth__fields">
          <span className="muted">{t("public.requiredNote")}</span>
          <div className="auth__fields">
            <div className="auth__check">
              <RadioGroup
                legend={t("public.response.answer")}
                name="answer"
                inline
                value={answer}
                onChange={(next) => setAnswer(next as AnswerStatus)}
                options={[
                  { value: "accepted", label: t("public.response.accept") },
                  { value: "declined", label: t("public.response.decline") },
                ]}
              />
              {errors.answer && (
                <span className="lbl__error">
                  <Icon name="warning" size={12} />
                  <span>{errors.answer}</span>
                </span>
              )}
            </div>
            {max > 0 && (
              <TextField
                mono
                inputMode="numeric"
                label={t("public.response.guests")}
                hint={t("public.response.guestsHint")}
                className="in--w160"
                value={guests}
                error={errors.guests}
                onChange={(e) => setGuests(e.target.value)}
              />
            )}
            <TextArea
              label={t("public.response.note")}
              hint={t("public.response.noteHint")}
              value={note}
              error={errors.note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <div className="auth__actions">
          <Button type="submit" variant="primary" icon="send" disabled={busy}>
            {t("public.response.submit")}
          </Button>
          <Button onClick={() => setLater(true)}>{t("public.response.later")}</Button>
        </div>
      </form>
    </AuthLayout>
  );
}
