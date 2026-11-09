import { useEffect, useId, useState } from "react";
import { useAuth } from "../../auth/auth";
import { orgName } from "../../config";
import { t, tp } from "../../i18n";
import { useCurrentTab } from "../../shell/tabs";
import {
  Badge,
  Button,
  ConfirmDialog,
  Message,
  PageHeader,
  Panel,
  Select,
  useToast,
} from "../../ui";
import type { CalEvent, GroupOption, InviteResult, Recipient } from "./calendarService";
import { useCalendar } from "./CalendarContext";
import { atStamp } from "./EventPage";
import { LoadError, useEvent } from "./hooks";
import { dayOf, deletionAt, formatDay, timeOf, weekdayName } from "./time";

/** Einladung erzeugen (Design 8.4): Vorschau als Papier, Versand an eine Adressliste. */
export function InviteTab() {
  const tab = useCurrentTab();
  const { service, now } = useCalendar();
  const { session } = useAuth();
  const { result, reload } = useEvent(tab.params["eventId"]);
  const [groupId, setGroupId] = useState(tab.params["groupId"] ?? "");
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [recipients, setRecipients] = useState<Recipient[] | "loading" | "error">("loading");
  const [confirm, setConfirm] = useState(false);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<InviteResult | "failed" | null>(null);
  const selectId = useId();
  const toast = useToast();

  useEffect(() => {
    let active = true;
    service.groups().then(
      (list) => active && setGroups(list),
      () => undefined, // Ohne Liste bleibt die Auswahl leer; Versand ist dann nicht möglich.
    );
    return () => {
      active = false;
    };
  }, [service]);

  useEffect(() => {
    if (!groupId) {
      setRecipients([]);
      return;
    }
    let active = true;
    setRecipients("loading");
    service.recipients(groupId).then(
      (list) => active && setRecipients(list),
      () => active && setRecipients("error"),
    );
    return () => {
      active = false;
    };
  }, [service, groupId]);

  // Die am Event gespeicherte Adressliste gilt, solange kein Tab-Parameter eine andere setzt.
  const savedGroup = result.state === "ready" ? result.value.inviteGroupId : null;
  useEffect(() => {
    if (savedGroup) setGroupId((g) => g || savedGroup);
  }, [savedGroup]);

  useEffect(() => {
    if (result.state === "ready")
      tab.setTitle(t("kalender.tab.invite", { title: result.value.title }));
  }, [tab, result]);

  if (result.state === "error") return <LoadError status={result.status} onRetry={reload} />;
  if (result.state === "loading") {
    return (
      <div className="state-page" role="status">
        <span className="muted">{t("kalender.loading")}</span>
      </div>
    );
  }
  const event = result.value;
  const ended = Date.parse(event.endsAt) <= now;
  const group = groups.find((g) => g.id === groupId);
  const count = Array.isArray(recipients) ? recipients.length : 0;

  const sendTest = async () => {
    try {
      await service.sendTest(event.id);
      toast.show({ tone: "ok", title: t("kalender.invite.testSent") });
    } catch {
      toast.show({ tone: "error", title: t("kalender.invite.testFailed") });
    }
  };

  const send = async () => {
    if (!Array.isArray(recipients)) return;
    setConfirm(false);
    setSending(true);
    setOutcome(null);
    try {
      setOutcome(await service.invite(event.id, recipients));
    } catch {
      setOutcome("failed");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        crumb={t("kalender.crumb.invite", { title: event.title })}
        title={t("kalender.invite.title")}
        status={<Badge>{t("kalender.invite.preview")}</Badge>}
        actions={
          <>
            <Button icon="print" onClick={() => window.print()}>
              {t("kalender.invite.print")}
            </Button>
            <Button icon="mail" onClick={() => void sendTest()}>
              {t("kalender.invite.test")}
            </Button>
            <Button
              variant="primary"
              icon="send"
              disabled={ended || sending || count === 0}
              onClick={() => setConfirm(true)}
            >
              {t("kalender.invite.send")}
            </Button>
          </>
        }
      />
      {outcome && <InviteOutcome outcome={outcome} />}
      <div className="cal-desk">
        <Paper event={event} organization={session?.organization || orgName} />
        <div className="cal-desk__side">
          <div className="cal-stack">
            <Panel title={t("kalender.invite.send.title")}>
              <dl className="cal-kv cal-kv--narrow">
                <dt>{t("kalender.invite.subject")}</dt>
                <dd>{t("kalender.invite.subjectValue", { title: event.title })}</dd>
                <dt>{t("kalender.invite.list")}</dt>
                <dd>
                  {groupId ? (
                    (group?.name ?? "–")
                  ) : (
                    <Select
                      id={selectId}
                      label={t("kalender.invite.list")}
                      value={groupId}
                      options={[
                        { value: "", label: t("kalender.form.groupNone") },
                        ...groups.map((g) => ({ value: g.id, label: g.name })),
                      ]}
                      onChange={(e) => setGroupId(e.target.value)}
                    />
                  )}
                </dd>
                <dt>{t("kalender.invite.recipients")}</dt>
                <dd>{recipients === "loading" ? "…" : recipients === "error" ? "–" : count}</dd>
                <dt>{t("kalender.invite.deadline")}</dt>
                <dd>
                  {event.registrationDeadlineLocal
                    ? formatDay(dayOf(event.registrationDeadlineLocal))
                    : "–"}
                </dd>
              </dl>
              {recipients === "error" && (
                <Message tone="error">{t("kalender.invite.recipientsError")}</Message>
              )}
            </Panel>
            <Panel title={t("kalender.invite.placeholders.title")}>
              <span className="muted">{t("kalender.invite.placeholders.text")}</span>
            </Panel>
            <Message icon="clock" title={t("kalender.invite.links.title")}>
              {t("kalender.invite.links.text", { when: atStamp(deletionAt(event.endsAt)) })}
            </Message>
          </div>
        </div>
      </div>
      {confirm && (
        <ConfirmDialog
          title={t("kalender.invite.confirm.title")}
          confirmLabel={t("kalender.invite.send")}
          confirmIcon="send"
          onConfirm={() => void send()}
          onCancel={() => setConfirm(false)}
        >
          {tp("kalender.invite.confirm.text", count, { title: event.title })}
        </ConfirmDialog>
      )}
    </div>
  );
}

function InviteOutcome({ outcome }: { outcome: InviteResult | "failed" }) {
  if (outcome === "failed") {
    return (
      <div className="page__body">
        <Message tone="error" title={t("kalender.invite.failed.title")}>
          {t("kalender.invite.failed.text")}
        </Message>
      </div>
    );
  }
  const problems = outcome.failed > 0;
  return (
    <div className="page__body">
      <Message tone={problems ? "warning" : "ok"} title={tp("kalender.invite.done", outcome.sent)}>
        {[
          outcome.skipped > 0 && tp("kalender.invite.skipped", outcome.skipped),
          outcome.failed > 0 && tp("kalender.invite.notSent", outcome.failed),
        ]
          .filter(Boolean)
          .join(" ")}
      </Message>
    </div>
  );
}

/** Das Blatt: so sieht die Person die Einladung. Anrede, Name und Link setzt der Versand pro Person ein. */
function Paper({ event, organization }: { event: CalEvent; organization: string }) {
  const day = dayOf(event.startsAtLocal);
  const sameDay = dayOf(event.endsAtLocal) === day;
  const end = sameDay
    ? timeOf(event.endsAtLocal)
    : `${formatDay(dayOf(event.endsAtLocal))} ${timeOf(event.endsAtLocal)}`;
  const deadline = event.registrationDeadlineLocal;
  const paragraphs = event.description.split(/\n{2,}/).filter((p) => p.trim());
  return (
    <div className="cal-paper">
      <div className="cal-paper__head">
        <b>{organization}</b>
      </div>
      <h2>{t("kalender.paper.heading", { title: event.title })}</h2>
      <p>
        {t("kalender.paper.greeting")}{" "}
        <span className="cal-pin">{t("kalender.paper.salutation")}</span>{" "}
        <span className="cal-pin">{t("kalender.paper.name")}</span>
      </p>
      {paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
      {event.maxGuests > 0 && <p>{t("kalender.paper.guests")}</p>}
      <table>
        <tbody>
          <tr>
            <th scope="row">{t("kalender.paper.date")}</th>
            <td>
              <b>{`${weekdayName(day)}, ${formatDay(day)}`}</b>
            </td>
          </tr>
          <tr>
            <th scope="row">{t("kalender.paper.time")}</th>
            <td>
              <b>{t("kalender.paper.timeValue", { from: timeOf(event.startsAtLocal), to: end })}</b>
            </td>
          </tr>
          {event.location && (
            <tr>
              <th scope="row">{t("kalender.paper.place")}</th>
              <td>
                <b>{event.location}</b>
              </td>
            </tr>
          )}
          {deadline && (
            <tr>
              <th scope="row">{t("kalender.paper.deadline")}</th>
              <td>
                <b>
                  {t("kalender.paper.deadlineValue", {
                    date: formatDay(dayOf(deadline)),
                    time: timeOf(deadline),
                  })}
                </b>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p>
        {t("kalender.paper.link")} <span className="cal-pin">{t("kalender.paper.linkPin")}</span>
      </p>
      <p>{event.maxGuests > 0 ? t("kalender.paper.answers") : t("kalender.paper.answersPlain")}</p>
      <div className="cal-paper__sign">
        {t("kalender.paper.regards")}
        <br />
        {organization}
      </div>
    </div>
  );
}
