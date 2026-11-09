import { useEffect, useMemo, useRef, useState } from "react";
import { t, tp } from "../../i18n";
import { useCurrentTab, useTabs } from "../../shell/tabs";
import {
  Badge,
  Button,
  Checkbox,
  DataTable,
  Icon,
  Message,
  PageHeader,
  Panel,
  Select,
  TextArea,
  TextField,
  useToast,
  type Column,
} from "../../ui";
import type { CalEvent, EventInput, GroupOption, ParticipantRow } from "./calendarService";
import { useCalendar } from "./CalendarContext";
import { LoadError, notifyCalendarChanged, useEvent, useParticipants } from "./hooks";
import {
  addDays,
  dayOf,
  daysBetween,
  RETENTION_MS,
  deletionAt,
  instantOf,
  formatDay,
  parseClock,
  parseDay,
  timeOf,
  wallOf,
} from "./time";

/** Maximal erlaubte Begleitpersonen der API; «Begleitpersonen angeben» schaltet bis zu diesem Wert frei. */
const MAX_GUESTS = 10;
/** Zusagen in der Vorschau eines beendeten Events (Design 8.7). */
export const PREVIEW_ROWS = 11;

interface Values {
  title: string;
  date: string;
  begin: string;
  end: string;
  location: string;
  description: string;
  deadlineDate: string;
  deadlineTime: string;
  groupId: string;
  guests: boolean;
}

type Errors = Partial<Record<keyof Values, string>>;

const EMPTY: Values = {
  title: "",
  date: "",
  begin: "",
  end: "",
  location: "",
  description: "",
  deadlineDate: "",
  deadlineTime: "",
  groupId: "",
  guests: true,
};

function valuesOf(e: CalEvent): Values {
  return {
    title: e.title,
    date: formatDay(dayOf(e.startsAtLocal)),
    begin: timeOf(e.startsAtLocal),
    end: timeOf(e.endsAtLocal),
    location: e.location,
    description: e.description,
    deadlineDate: e.registrationDeadlineLocal ? formatDay(dayOf(e.registrationDeadlineLocal)) : "",
    deadlineTime: e.registrationDeadlineLocal ? timeOf(e.registrationDeadlineLocal) : "",
    groupId: e.inviteGroupId ?? "",
    guests: e.maxGuests > 0,
  };
}

/** `15.11.2026 um 20:30` */
export const atStamp = (ms: number): string => {
  const w = wallOf(ms);
  return t("kalender.at", { date: formatDay(w.day), time: w.time });
};

/**
 * Tab «Event»: neuer oder bestehender Event. Ein bestehender Event, dessen Ende erreicht ist, zeigt
 * den Hinweis zur Löschung nach 24 Stunden (Design 8.7), sonst das Formular (Design 8.3).
 */
export function EventTab() {
  const tab = useCurrentTab();
  const { now } = useCalendar();
  const eventId = tab.params["eventId"];
  const [created, setCreated] = useState<CalEvent | null>(null);
  const { result, reload } = useEvent(created ? undefined : eventId);
  // Ob der Event beendet ist, entscheidet sich beim Laden; ein Formular wird nicht unter den Händen ersetzt.
  const endedAtLoad = useRef<boolean | null>(null);

  if (!eventId && !created) return <EventForm event={undefined} onSaved={setCreated} />;
  if (created) return <EventForm event={created} onSaved={setCreated} />;
  if (result.state === "error") return <LoadError status={result.status} onRetry={reload} />;
  if (result.state === "loading") {
    return (
      <div className="state-page" role="status">
        <span className="muted is-loading">{t("kalender.loading")}</span>
      </div>
    );
  }
  endedAtLoad.current ??= Date.parse(result.value.endsAt) <= now;
  return endedAtLoad.current ? (
    <EndedEventView event={result.value} />
  ) : (
    <EventForm event={result.value} onSaved={setCreated} />
  );
}

// ---------- Formular (8.3) ----------

function EventForm({
  event,
  onSaved,
}: {
  event: CalEvent | undefined;
  onSaved: (e: CalEvent) => void;
}) {
  const { service, now } = useCalendar();
  const tab = useCurrentTab();
  const tabs = useTabs();
  const toast = useToast();
  const [current, setCurrent] = useState<CalEvent | undefined>(event);
  const [groups, setGroups] = useState<GroupOption[] | "error">([]);
  const [initial, setInitial] = useState<Values>(() => (event ? valuesOf(event) : EMPTY));
  const [values, setValues] = useState<Values>(initial);
  const [errors, setErrors] = useState<Errors>({});
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  // shortcut: Der Event hat im Formular nur ein Datum; ein Event über mehrere Tage behält seine Dauer in Tagen.
  const spanDays = current
    ? daysBetween(dayOf(current.startsAtLocal), dayOf(current.endsAtLocal))
    : 0;

  const dirty = useMemo(
    () => JSON.stringify(values) !== JSON.stringify(initial),
    [values, initial],
  );
  useEffect(() => tab.setDirty(dirty), [tab, dirty]);

  useEffect(() => {
    let active = true;
    service.groups().then(
      (list) => active && setGroups(list),
      () => active && setGroups("error"),
    );
    return () => {
      active = false;
    };
  }, [service]);

  const participants = useParticipants(current?.id, false);
  const summary = participants.result.state === "ready" ? participants.result.value.summary : null;

  const set = <K extends keyof Values>(key: K, value: Values[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  };

  /** Prüft die Eingaben; liefert die Angaben für die API oder die Fehler je Feld. */
  const check = (): { input: EventInput } | { errors: Errors } => {
    const err: Errors = {};
    const day = parseDay(values.date);
    const begin = parseClock(values.begin);
    const end = parseClock(values.end);
    const dDay = parseDay(values.deadlineDate);
    const dTime = parseClock(values.deadlineTime);
    if (!values.title.trim()) err.title = t("kalender.error.title");
    if (!day) err.date = t("kalender.error.date");
    if (!begin) err.begin = t("kalender.error.time");
    if (!end) err.end = t("kalender.error.time");
    if (!values.location.trim()) err.location = t("kalender.error.location");
    if (!dDay) err.deadlineDate = t("kalender.error.date");
    if (!dTime) err.deadlineTime = t("kalender.error.time");
    if (Object.values(err).some(Boolean)) return { errors: err };
    const startsAtLocal = `${day}T${begin}`;
    const endsAtLocal = `${addDays(day!, spanDays)}T${end}`;
    const deadline = `${dDay}T${dTime}`;
    if (endsAtLocal <= startsAtLocal) err.end = t("kalender.error.endBeforeStart");
    if (deadline > startsAtLocal) err.deadlineDate = t("kalender.error.deadlineAfterStart");
    if (err.end || err.deadlineDate) return { errors: err };
    const input: EventInput = {
      title: values.title.trim(),
      description: values.description.trim(),
      location: values.location.trim(),
      startsAtLocal,
      endsAtLocal,
      registrationDeadlineLocal: deadline,
      maxGuests: values.guests ? current?.maxGuests || MAX_GUESTS : 0,
      inviteGroupId: values.groupId || null,
    };
    return { input };
  };

  const FIELD_IDS: Record<keyof Values, string> = {
    title: "ev-title",
    date: "ev-date",
    begin: "ev-begin",
    end: "ev-end",
    location: "ev-location",
    description: "ev-description",
    deadlineDate: "ev-deadline-date",
    deadlineTime: "ev-deadline-time",
    groupId: "ev-group",
    guests: "ev-guests",
  };

  async function save(): Promise<boolean> {
    const checked = check();
    if ("errors" in checked) {
      setErrors(checked.errors);
      setFailed(false);
      const first = (Object.keys(FIELD_IDS) as (keyof Values)[]).find((k) => checked.errors[k]);
      if (first) document.getElementById(FIELD_IDS[first])?.focus();
      return false;
    }
    setSaving(true);
    setFailed(false);
    try {
      const saved = await service.saveEvent(current?.id ?? null, checked.input);
      setCurrent(saved);
      const next = valuesOf(saved);
      setInitial(next);
      setValues(next);
      setErrors({});
      if (!current) {
        tabs.update(tab.id, {
          key: `event:${saved.id}`,
          params: { eventId: saved.id },
          title: t("kalender.tab.edit", { title: saved.title }),
        });
        onSaved(saved);
      } else {
        tab.setTitle(t("kalender.tab.edit", { title: saved.title }));
      }
      notifyCalendarChanged();
      toast.show({ tone: "ok", title: t("kalender.saved") });
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setSaving(false);
    }
  }

  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => tab.registerSave(() => saveRef.current()), [tab]);

  // Zeitpunkt der Löschung aus den eingegebenen Werten, sonst aus dem gespeicherten Stand.
  const endDay = parseDay(values.date);
  const endTime = parseClock(values.end);
  const deleteAt = (() => {
    if (!endDay || !endTime) return current ? deletionAt(current.endsAt) : null;
    const wall = `${addDays(endDay, spanDays)}T${endTime}`;
    return instantOf(wall) + RETENTION_MS;
  })();

  const groupOptions = [
    { value: "", label: t("kalender.form.groupNone") },
    ...(groups === "error"
      ? []
      : groups.map((g) => ({
          value: g.id,
          label: t("kalender.form.groupOption", { name: g.name, n: g.members }),
        }))),
  ];

  const openTabFor = (
    type: string,
    key: string,
    title: string,
    extra: Record<string, string> = {},
  ) => {
    if (!current) return;
    tabs.openTab(type, {
      key: `${key}:${current.id}`,
      params: { eventId: current.id, ...extra },
      title,
    });
  };

  const open = current
    ? now <= Date.parse(current.registrationDeadline ?? current.startsAt)
    : false;

  return (
    <div className="page">
      <PageHeader
        crumb={t("kalender.crumb.event", { title: current?.title ?? t("kalender.tab.new") })}
        title={current ? t("kalender.edit.title") : t("kalender.tab.new")}
        status={dirty ? <Badge tone="warning">{t("kalender.unsaved")}</Badge> : undefined}
        actions={
          <>
            <Button icon="close" onClick={() => tab.close()}>
              {t("ui.cancel")}
            </Button>
            <Button variant="primary" icon="save" disabled={saving} onClick={() => void save()}>
              {t("kalender.save")}
            </Button>
          </>
        }
      />
      <div className="cal-split">
        <div className="cal-split__main cal-split__main--form">
          <div className="cal-stack">
            {failed && (
              <Message tone="error" title={t("kalender.saveFailed.title")}>
                {t("kalender.saveFailed.text")}
              </Message>
            )}
            {Object.values(errors).some(Boolean) && (
              <Message tone="error">{t("kalender.errors.summary")}</Message>
            )}
            <Panel title={t("kalender.form.panel")}>
              <form
                className="cal-form"
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <span className="muted">{t("kalender.form.required")}</span>
                <TextField
                  id={FIELD_IDS.title}
                  label={t("kalender.form.title")}
                  required
                  value={values.title}
                  error={errors.title}
                  maxLength={200}
                  onChange={(e) => set("title", e.target.value)}
                />
                <div className="cal-form__row cal-form__row--3">
                  <TextField
                    id={FIELD_IDS.date}
                    label={t("kalender.form.date")}
                    required
                    value={values.date}
                    error={errors.date}
                    hint={t("kalender.form.dateHint")}
                    onChange={(e) => set("date", e.target.value)}
                  />
                  <TextField
                    id={FIELD_IDS.begin}
                    label={t("kalender.form.begin")}
                    required
                    value={values.begin}
                    error={errors.begin}
                    hint={t("kalender.form.timeHint")}
                    onChange={(e) => set("begin", e.target.value)}
                  />
                  <TextField
                    id={FIELD_IDS.end}
                    label={t("kalender.form.end")}
                    required
                    value={values.end}
                    error={errors.end}
                    hint={t("kalender.form.timeHint")}
                    onChange={(e) => set("end", e.target.value)}
                  />
                </div>
                <TextField
                  id={FIELD_IDS.location}
                  label={t("kalender.form.location")}
                  required
                  value={values.location}
                  error={errors.location}
                  maxLength={200}
                  onChange={(e) => set("location", e.target.value)}
                />
                <TextArea
                  id={FIELD_IDS.description}
                  label={t("kalender.form.description")}
                  rows={3}
                  value={values.description}
                  maxLength={5000}
                  onChange={(e) => set("description", e.target.value)}
                />
                <div className="cal-form__row cal-form__row--2">
                  <TextField
                    id={FIELD_IDS.deadlineDate}
                    label={t("kalender.form.deadlineDate")}
                    required
                    value={values.deadlineDate}
                    error={errors.deadlineDate}
                    hint={t("kalender.form.dateHint")}
                    onChange={(e) => set("deadlineDate", e.target.value)}
                  />
                  <TextField
                    id={FIELD_IDS.deadlineTime}
                    label={t("kalender.form.deadlineTime")}
                    required
                    value={values.deadlineTime}
                    error={errors.deadlineTime}
                    hint={t("kalender.form.timeHint")}
                    onChange={(e) => set("deadlineTime", e.target.value)}
                  />
                </div>
                <Select
                  id={FIELD_IDS.groupId}
                  label={t("kalender.form.group")}
                  value={values.groupId}
                  error={groups === "error" ? t("kalender.form.groupError") : undefined}
                  options={groupOptions}
                  onChange={(e) => set("groupId", e.target.value)}
                />
                <fieldset>
                  <legend>{t("kalender.form.answers")}</legend>
                  <Checkbox
                    label={t("kalender.form.answerYesNo")}
                    checked
                    disabled
                    onChange={() => undefined}
                  />
                  <Checkbox
                    id={FIELD_IDS.guests}
                    label={t("kalender.form.answerGuests")}
                    checked={values.guests}
                    onChange={(e) => set("guests", e.target.checked)}
                  />
                  <Checkbox
                    label={t("kalender.form.answerNote")}
                    checked
                    disabled
                    onChange={() => undefined}
                  />
                </fieldset>
              </form>
            </Panel>
          </div>
        </div>
        <div className="cal-split__side">
          <div className="cal-stack">
            <Message icon="clock" title={t("kalender.retention.title")}>
              {deleteAt === null
                ? t("kalender.retention.textPlain")
                : t("kalender.retention.text", { when: atStamp(deleteAt) })}
            </Message>
            {current && (
              <Panel title={t("kalender.stand.title")}>
                <dl className="cal-kv">
                  <dt>{t("kalender.stand.status")}</dt>
                  <dd>
                    {open ? (
                      <Badge tone="ok">
                        <Icon name="check" size={12} />
                        {t("kalender.stand.open")}
                      </Badge>
                    ) : (
                      <Badge>
                        <Icon name="lock" size={12} />
                        {t("kalender.stand.closed")}
                      </Badge>
                    )}
                  </dd>
                  <dt>{t("kalender.stand.accepted")}</dt>
                  <dd>{summary ? summary.accepted : "–"}</dd>
                  <dt>{t("kalender.stand.declined")}</dt>
                  <dd>{summary ? summary.declined : "–"}</dd>
                  <dt>{t("kalender.stand.pending")}</dt>
                  <dd>{summary ? summary.pending : "–"}</dd>
                  <dt>{t("kalender.stand.invitation")}</dt>
                  <dd>
                    {summary && summary.invited > 0
                      ? tp("kalender.stand.invited", summary.invited)
                      : t("kalender.stand.notInvited")}
                  </dd>
                </dl>
              </Panel>
            )}
            <Panel title={t("kalender.after.title")}>
              <div className="cal-stack cal-stack--tight">
                <Button
                  icon="mail"
                  disabled={!current}
                  onClick={() =>
                    openTabFor(
                      "calendar-invite",
                      "invite",
                      t("kalender.tab.invite", { title: current?.title ?? "" }),
                      {
                        groupId: values.groupId,
                      },
                    )
                  }
                >
                  {t("kalender.after.invite")}
                </Button>
                <Button
                  icon="people"
                  disabled={!current}
                  onClick={() =>
                    openTabFor(
                      "calendar-participants",
                      "participants",
                      t("kalender.tab.participants", { title: current?.title ?? "" }),
                    )
                  }
                >
                  {t("kalender.after.participants")}
                </Button>
                <Button
                  icon="send"
                  disabled={!current}
                  onClick={() =>
                    openTabFor(
                      "calendar-responses",
                      "responses",
                      t("kalender.tab.responses", { title: current?.title ?? "" }),
                    )
                  }
                >
                  {t("kalender.after.responses")}
                </Button>
                <span className="muted">{t("kalender.after.note")}</span>
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Beendeter Event (8.7) ----------

function EndedEventView({ event }: { event: CalEvent }) {
  const { service, now } = useCalendar();
  const toast = useToast();
  const { result, reload } = useParticipants(event.id, false);
  const [next, setNext] = useState<CalEvent | null>(null);
  const endedAt = Date.parse(event.endsAt);
  const removeAt = deletionAt(event.endsAt);
  const sameDay = wallOf(removeAt).day === wallOf(now).day;
  const when = sameDay ? t("kalender.expiring.today") : t("kalender.expiring.tomorrow");

  // Der nächste Event nach diesem: Die Regel zur Löschung gilt für jeden.
  useEffect(() => {
    let active = true;
    const from = wallOf(now).day;
    service.listEvents(`${from}T00:00`, `${addDays(from, 365)}T00:00`).then(
      (list) => {
        const upcoming = list
          .filter((e) => e.id !== event.id && Date.parse(e.endsAt) > now)
          .sort((a, b) => a.endsAt.localeCompare(b.endsAt));
        if (active) setNext(upcoming[0] ?? null);
      },
      () => undefined, // Der Hinweis ist eine Zugabe.
    );
    return () => {
      active = false;
    };
  }, [service, event.id, now]);

  const exportList = async () => {
    try {
      await service.exportParticipants(event.id);
    } catch {
      toast.show({ tone: "error", title: t("kalender.export.failed") });
    }
  };

  const rows = result.state === "ready" ? result.value.rows : [];
  const accepted = rows.filter((r) => r.status === "accepted");
  const declined = rows.filter((r) => r.status === "declined");
  const guests = accepted.reduce((n, r) => n + r.guests, 0);
  const shown = accepted.slice(0, PREVIEW_ROWS);

  const columns: Column<ParticipantRow>[] = [
    { key: "name", header: t("kalender.col.name"), width: "217px", cell: (r) => <b>{r.name}</b> },
    { key: "group", header: t("kalender.col.group"), width: "184px", cell: (r) => r.group ?? "–" },
    {
      key: "guests",
      header: t("kalender.col.guests"),
      width: "118px",
      align: "right",
      cell: (r) => r.guests,
    },
    {
      key: "note",
      header: t("kalender.col.note"),
      cell: (r) => <span className="cal-note">{r.note || "–"}</span>,
    },
  ];

  return (
    <div className="page">
      <PageHeader
        crumb={t("kalender.crumb.event", { title: event.title })}
        title={event.title}
        status={
          <Badge tone="warning">
            <Icon name="trash" size={12} />
            {t("kalender.expiring.badge", { when })}
          </Badge>
        }
        actions={
          <Button variant="primary" icon="table" onClick={() => void exportList()}>
            {t("kalender.export")}
          </Button>
        }
      />
      <div className="cal-split">
        <div className="cal-split__main">
          <div className="cal-stack">
            <Message
              tone="warning"
              title={t("kalender.ended.title", { when, time: wallOf(removeAt).time })}
            >
              {t("kalender.ended.text")}
            </Message>
            <Panel title={t("kalender.ended.flow")}>
              <div className="cal-steps">
                <div className="cal-step">
                  <span className="cal-step__icon">
                    <Icon name="check" />
                  </span>
                  <div>
                    <b>{t("kalender.ended.over")}</b>
                    <br />
                    <span className="muted">{atStamp(endedAt)}</span>
                  </div>
                </div>
                <div className="cal-step">
                  <span className="cal-step__icon">
                    <Icon name="clock" />
                  </span>
                  <div>
                    <b>{t("kalender.ended.now")}</b>
                    <br />
                    <span className="muted">{atStamp(now)}</span>
                  </div>
                </div>
                <div className="cal-step">
                  <span className="cal-step__icon cal-step__icon--todo">
                    <Icon name="trash" />
                  </span>
                  <div>
                    <b>{t("kalender.ended.removal")}</b>
                    <br />
                    <span className="muted">{atStamp(removeAt)}</span>
                  </div>
                </div>
              </div>
            </Panel>
            <Panel
              title={
                result.state === "ready"
                  ? t("kalender.ended.last", {
                      accepted: accepted.length,
                      guests,
                      declined: declined.length,
                    })
                  : t("kalender.loading")
              }
              flush
            >
              {result.state === "error" ? (
                <div className="cal-pg">
                  <span>{t("kalender.error.status", { status: result.status })}</span>
                  <Button small onClick={reload}>
                    {t("error.retry")}
                  </Button>
                </div>
              ) : (
                <>
                  <DataTable
                    label={t("kalender.ended.table", { title: event.title })}
                    columns={columns}
                    rows={shown}
                    rowKey={(r) => r.invitationId}
                    empty={<span className="muted">{t("kalender.ended.none")}</span>}
                  />
                  <div className="cal-pg cal-pg--inset">
                    {t("kalender.ended.shown", { shown: shown.length, total: accepted.length })}
                  </div>
                </>
              )}
            </Panel>
          </div>
        </div>
        <div className="cal-split__side cal-split__side--narrow">
          <div className="cal-stack">
            <Panel title={t("kalender.ended.deleted")}>
              <div className="cal-list-plain">
                <span className="opt">
                  <Icon name="trash" />
                  {t("kalender.ended.deletedEvent", { title: event.title })}
                </span>
                <span className="opt">
                  <Icon name="trash" />
                  {t("kalender.ended.deletedAnswers", {
                    n: accepted.length + declined.length,
                    accepted: accepted.length,
                    declined: declined.length,
                  })}
                </span>
                <span className="opt">
                  <Icon name="trash" />
                  {t("kalender.ended.deletedLinks")}
                </span>
              </div>
            </Panel>
            <Panel title={t("kalender.ended.kept")}>
              <div className="cal-list-plain">
                {(["invoices", "accounting", "people"] as const).map((k) => (
                  <span key={k} className="opt">
                    <Icon name="check" />
                    {t(`kalender.ended.kept.${k}`)}
                  </span>
                ))}
              </div>
            </Panel>
            <Message title={t("kalender.ended.every")}>
              {next
                ? t("kalender.ended.everyText", {
                    title: next.title,
                    when: atStamp(deletionAt(next.endsAt)),
                  })
                : t("kalender.ended.everyPlain")}
            </Message>
          </div>
        </div>
      </div>
    </div>
  );
}
