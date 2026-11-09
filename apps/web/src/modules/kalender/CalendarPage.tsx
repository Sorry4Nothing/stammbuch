import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { t, tp } from "../../i18n";
import { useTabs } from "../../shell/tabs";
import { useOnTabActivate } from "../../shell/useOnTabActivate";
import { Badge, Button, Icon, PageHeader } from "../../ui";
import type { CalEvent } from "./calendarService";
import { useCalendar } from "./CalendarContext";
import { LoadError, statusOf, useCalendarChanged } from "./hooks";
import {
  MONTHS,
  WEEKDAYS,
  WEEKDAYS_SHORT,
  addDays,
  addMonths,
  dayOf,
  deletionAt,
  formatDay,
  formatDayMonth,
  formatMonth,
  isoWeek,
  minutesOf,
  monthGrid,
  monthKey,
  startOfWeek,
  timeOf,
  wallOf,
  weekDays,
} from "./time";

type View = "month" | "week";

/** Eintrag im Raster: Event, Anmeldeschluss oder ein beendeter Event vor der Löschung. */
interface Item {
  kind: "event" | "deadline" | "expiring";
  day: string;
  time: string;
  event: CalEvent;
}

/** Stunden im Wochenraster: 08:00 bis 22:00 (14 Zeilen à 32 px). */
const FIRST_HOUR = 8;
const HOURS = 14;
const ROW_PX = 32;

const GRID_LOOKAHEAD_DAYS = 64;

function itemsOf(events: readonly CalEvent[], now: number): Item[] {
  const out: Item[] = [];
  for (const e of events) {
    const ended = Date.parse(e.endsAt) <= now;
    out.push({
      kind: ended ? "expiring" : "event",
      day: dayOf(e.startsAtLocal),
      time: timeOf(e.startsAtLocal),
      event: e,
    });
    if (!ended && e.registrationDeadlineLocal) {
      out.push({
        kind: "deadline",
        day: dayOf(e.registrationDeadlineLocal),
        time: timeOf(e.registrationDeadlineLocal),
        event: e,
      });
    }
  }
  return out.sort((a, b) => a.time.localeCompare(b.time));
}

/** `09.11.–15.11.2026`, über den Jahreswechsel mit beiden Jahren. */
function weekRange(days: string[]): string {
  const [a, b] = [days[0]!, days[6]!];
  const from = formatDay(a);
  return a.slice(0, 4) === b.slice(0, 4)
    ? `${from.slice(0, 6)}–${formatDay(b)}`
    : `${from}–${formatDay(b)}`;
}

function deleteWord(e: CalEvent, now: number): string {
  return wallOf(deletionAt(e.endsAt)).day === wallOf(now).day
    ? t("kalender.expiring.today")
    : t("kalender.expiring.tomorrow");
}

export function CalendarPage() {
  const { service, now } = useCalendar();
  const { openTab } = useTabs();
  const today = wallOf(now).day;

  const [view, setView] = useState<View>("month");
  const [cursor, setCursor] = useState(today);
  const [viewMonth, setViewMonth] = useState(today);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [status, setStatus] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [accepted, setAccepted] = useState<Record<string, number>>({});
  const root = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);

  const grid = useMemo(() => monthGrid(viewMonth), [viewMonth]);
  const days = useMemo(
    () => (view === "month" ? grid.flat() : weekDays(cursor)),
    [view, grid, cursor],
  );
  const first = days[0]!;
  const last = days[days.length - 1]!;

  useCalendarChanged(() => setAttempt((n) => n + 1));
  useOnTabActivate(() => setAttempt((n) => n + 1));

  useEffect(() => {
    const ctl = new AbortController();
    service
      .listEvents(`${first}T00:00`, `${addDays(last, GRID_LOOKAHEAD_DAYS)}T00:00`, ctl.signal)
      .then(
        (list) => {
          setEvents(list);
          setStatus(null);
        },
        (e: unknown) => {
          if (!ctl.signal.aborted) setStatus(statusOf(e));
        },
      );
    return () => ctl.abort();
  }, [service, first, last, attempt]);

  const items = useMemo(() => itemsOf(events, now), [events, now]);
  const byDay = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const it of items) map.set(it.day, [...(map.get(it.day) ?? []), it]);
    return map;
  }, [items]);

  // Zusagen je Event für das Wochenraster (nur die Events der Woche).
  const weekEventIds = useMemo(
    () =>
      view === "week"
        ? items
            .filter((i) => i.kind === "event" && days.includes(i.day))
            .map((i) => i.event.id)
            .join(",")
        : "",
    [view, items, days],
  );
  useEffect(() => {
    let active = true;
    for (const id of weekEventIds.split(",").filter(Boolean)) {
      service.participants(id).then(
        (p) =>
          active &&
          p.summary.invited > 0 &&
          setAccepted((m) => ({ ...m, [id]: p.summary.accepted })),
        () => undefined, // Die Zahl ist eine Zugabe; ohne sie bleibt der Block ohne Zeile.
      );
    }
    return () => {
      active = false;
    };
  }, [service, weekEventIds]);

  // Nach einer Pfeiltaste landet der Fokus auf dem neuen Tag, sobald er gezeichnet ist.
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    root.current?.querySelector<HTMLElement>(`[data-day="${cursor}"]`)?.focus();
  });

  const moveTo = (day: string) => {
    refocus.current = true;
    setCursor(day);
    if (view === "month" && !grid.flat().includes(day)) setViewMonth(day);
  };

  const onKey = (e: KeyboardEvent<HTMLElement>, day: string) => {
    if (e.target !== e.currentTarget) return;
    const step =
      view === "month"
        ? { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
        : { ArrowLeft: -1, ArrowRight: 1 };
    const delta = (step as Record<string, number>)[e.key];
    let next: string | undefined;
    if (delta !== undefined) next = addDays(day, delta);
    else if (e.key === "Home") next = startOfWeek(day);
    else if (e.key === "End") next = addDays(startOfWeek(day), 6);
    else if (e.key === "PageUp") next = view === "month" ? addMonths(day, -1) : addDays(day, -7);
    else if (e.key === "PageDown") next = view === "month" ? addMonths(day, 1) : addDays(day, 7);
    if (next === undefined) return;
    e.preventDefault();
    moveTo(next);
  };

  const step = (n: 1 | -1) => {
    if (view === "month") {
      const target = addMonths(viewMonth, n);
      setViewMonth(target);
      setCursor(monthKey(cursor) === monthKey(viewMonth) ? addMonths(cursor, n) : target);
    } else {
      setCursor(addDays(cursor, 7 * n));
    }
  };

  const goToday = () => {
    setCursor(today);
    setViewMonth(today);
  };

  const switchView = (next: View) => {
    if (next === "month") setViewMonth(cursor);
    setView(next);
  };

  const openEvent = (e: CalEvent, expiring: boolean) =>
    openTab("calendar-event", {
      key: `event:${e.id}`,
      params: { eventId: e.id },
      title: expiring ? e.title : t("kalender.tab.edit", { title: e.title }),
    });

  const chip = (it: Item, withTime: boolean) => {
    const { event } = it;
    if (it.kind === "expiring") {
      return (
        <button
          key={`x-${event.id}`}
          type="button"
          className="cal-chip cal-chip--delete"
          onClick={() => openEvent(event, true)}
        >
          <Icon name="trash" size={12} />
          <span>
            {t("kalender.chip.expiring", { title: event.title, when: deleteWord(event, now) })}
          </span>
        </button>
      );
    }
    if (it.kind === "deadline") {
      return (
        <button
          key={`d-${event.id}`}
          type="button"
          className="cal-chip cal-chip--deadline"
          onClick={() => openEvent(event, false)}
        >
          <Icon name="clock" size={12} />
          <span>
            {withTime ? `${it.time} ` : ""}
            {t("kalender.chip.deadline", { title: event.title })}
          </span>
        </button>
      );
    }
    return (
      <button
        key={`e-${event.id}`}
        type="button"
        className="cal-chip"
        onClick={() => openEvent(event, false)}
      >
        <Icon name="calendar" size={12} />
        <span>{`${it.time} ${event.title}`}</span>
      </button>
    );
  };

  const eventsIn = (list: string[]) =>
    items.filter((i) => i.kind !== "deadline" && list.includes(i.day)).length;
  const deadlinesIn = (list: string[]) =>
    items.filter((i) => i.kind === "deadline" && list.includes(i.day)).length;

  const monthDays = grid.flat().filter((d) => monthKey(d) === monthKey(viewMonth));
  const weekOfDays = view === "week" ? days : [];
  // Ein leerer Zeitraum zeigt kein Badge: das leere Raster sagt es schon.
  const badge =
    view === "month"
      ? eventsIn(monthDays) === 0
        ? undefined
        : tp("kalender.badge.month", eventsIn(monthDays), {
            month: MONTHS[Number(viewMonth.slice(5, 7)) - 1]!,
          })
      : eventsIn(weekOfDays) + deadlinesIn(weekOfDays) === 0
        ? undefined
        : [
            eventsIn(weekOfDays) > 0 && tp("kalender.badge.events", eventsIn(weekOfDays)),
            deadlinesIn(weekOfDays) > 0 && tp("kalender.badge.deadlines", deadlinesIn(weekOfDays)),
          ]
            .filter(Boolean)
            .join(", ");

  const activeDay = days.includes(cursor)
    ? cursor
    : (days.find((d) => monthKey(d) === monthKey(viewMonth)) ?? first);
  const kw = isoWeek(cursor);

  const title =
    view === "month"
      ? formatMonth(viewMonth)
      : t("kalender.week.title", { kw, range: weekRange(days) });

  return (
    <div className="page" ref={root}>
      <PageHeader
        title={t("kalender.title")}
        crumb={view === "month" ? t("kalender.crumb.month") : t("kalender.crumb.week")}
        status={badge ? <Badge>{badge}</Badge> : undefined}
        actions={
          <Button
            variant="primary"
            icon="plus"
            onClick={() => openTab("calendar-event", { key: "new", title: t("kalender.tab.new") })}
          >
            {t("kalender.new")}
          </Button>
        }
      />

      <div className="cal-tool cal-tool--cal" role="toolbar" aria-label={t("kalender.toolbar")}>
        <Button
          icon="chevronLeft"
          aria-label={view === "month" ? t("kalender.prevMonth") : t("kalender.prevWeek")}
          onClick={() => step(-1)}
        />
        <h2>{title}</h2>
        <Button
          icon="chevronRight"
          aria-label={view === "month" ? t("kalender.nextMonth") : t("kalender.nextWeek")}
          onClick={() => step(1)}
        />
        <Button onClick={goToday}>{t("kalender.today")}</Button>
        <span className="cal-tool__spacer" />
        <span className="cal-legend">
          <Icon name="calendar" size={14} />
          <span>{t("kalender.legend.event")}</span>
        </span>
        <span className="cal-legend">
          <Icon name="clock" size={14} />
          <span>{t("kalender.legend.deadline")}</span>
        </span>
        <span className="cal-tool__gap" />
        <Button
          variant="secondary"
          aria-pressed={view === "month"}
          onClick={() => switchView("month")}
        >
          {t("kalender.view.month")}
        </Button>
        <Button
          variant="secondary"
          aria-pressed={view === "week"}
          onClick={() => switchView("week")}
        >
          {t("kalender.view.week")}
        </Button>
      </div>

      {status !== null ? (
        <LoadError status={status} onRetry={() => setAttempt((n) => n + 1)} />
      ) : view === "month" ? (
        <div className="cal-month">
          <table
            role="grid"
            aria-label={t("kalender.month.label", { month: formatMonth(viewMonth) })}
          >
            <thead>
              <tr>
                {WEEKDAYS.map((w) => (
                  <th key={w} scope="col">
                    {w}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.map((week) => (
                <tr key={week[0]}>
                  {week.map((day) => {
                    const inMonth = monthKey(day) === monthKey(viewMonth);
                    const isFirst = day === grid[0]![0] || day.endsWith("-01");
                    const label = isFirst ? formatDayMonth(day) : String(Number(day.slice(8, 10)));
                    return (
                      <td
                        key={day}
                        role="gridcell"
                        data-day={day}
                        className={inMonth ? "cal-day" : "cal-day cal-day--out"}
                        tabIndex={day === activeDay ? 0 : -1}
                        onKeyDown={(e) => onKey(e, day)}
                        onFocus={(e) => e.target === e.currentTarget && setCursor(day)}
                      >
                        <div className="cal-day__in">
                          <div className="cal-day__num">
                            {day === today ? (
                              <span className="cal-today">
                                <span aria-current="date" className="cal-today__num">
                                  {Number(day.slice(8, 10))}
                                </span>
                                <span className="muted">{t("kalender.todayMark")}</span>
                              </span>
                            ) : (
                              <span>{label}</span>
                            )}
                          </div>
                          {(byDay.get(day) ?? []).map((it) => chip(it, false))}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="cal-week" role="group" aria-label={t("kalender.week.label", { kw })}>
          <div className="cal-week__row">
            <div className="cal-week__gutter" />
            {days.map((day, i) => (
              <div
                key={day}
                role="group"
                data-day={day}
                className="cal-week__col cal-week__head"
                aria-label={`${WEEKDAYS[i]}, ${formatDay(day)}`}
                aria-current={day === today ? "date" : undefined}
                tabIndex={day === activeDay ? 0 : -1}
                onKeyDown={(e) => onKey(e, day)}
                onFocus={(e) => e.target === e.currentTarget && setCursor(day)}
              >
                <b>{WEEKDAYS_SHORT[i]}</b>{" "}
                <span className="muted">{`${Number(day.slice(8, 10))}.${Number(day.slice(5, 7))}.`}</span>
              </div>
            ))}
          </div>
          <div className="cal-week__row">
            <div className="cal-week__gutter cal-week__label">{t("kalender.week.deadlines")}</div>
            {days.map((day) => (
              <div key={day} className="cal-week__col cal-week__due">
                {(byDay.get(day) ?? [])
                  .filter((i) => i.kind === "deadline")
                  .map((it) => chip(it, true))}
              </div>
            ))}
          </div>
          <div className="cal-week__row cal-week__row--grid">
            <div className="cal-week__gutter">
              {Array.from({ length: HOURS }, (_, h) => (
                <div key={h} className="cal-week__hour">
                  {String(FIRST_HOUR + h).padStart(2, "0")}:00
                </div>
              ))}
            </div>
            {days.map((day) => (
              <div key={day} className="cal-week__col">
                {Array.from({ length: HOURS }, (_, h) => (
                  <div key={h} className="cal-week__slot" />
                ))}
                {(byDay.get(day) ?? [])
                  .filter((i) => i.kind !== "deadline")
                  .map((it) => {
                    const e = it.event;
                    // shortcut: Events über Mitternacht enden im Raster um 22:00, Beginn vor 08:00 beginnt oben.
                    const startMin = Math.max(minutesOf(it.time), FIRST_HOUR * 60);
                    const sameDay = dayOf(e.endsAtLocal) === day;
                    const endMin = Math.min(
                      sameDay ? minutesOf(timeOf(e.endsAtLocal)) : (FIRST_HOUR + HOURS) * 60,
                      (FIRST_HOUR + HOURS) * 60,
                    );
                    const top = Math.min(
                      ((startMin - FIRST_HOUR * 60) / 60) * ROW_PX,
                      HOURS * ROW_PX - ROW_PX,
                    );
                    const height = Math.max(((endMin - startMin) / 60) * ROW_PX, ROW_PX);
                    const count = accepted[e.id];
                    const expiring = it.kind === "expiring";
                    return (
                      <button
                        key={e.id}
                        type="button"
                        className={expiring ? "cal-block cal-block--delete" : "cal-block"}
                        style={{ top, height }}
                        // Kurze Einträge zeigen nicht alles: der Tooltip nennt Zeit, Titel und Ort.
                        title={[`${it.time}–${timeOf(e.endsAtLocal)}`, e.title, e.location]
                          .filter(Boolean)
                          .join(", ")}
                        onClick={() => openEvent(e, expiring)}
                      >
                        <b>{`${it.time}–${timeOf(e.endsAtLocal)}`}</b>
                        <b>{e.title}</b>
                        {expiring ? (
                          <span>{t("kalender.block.expiring", { when: deleteWord(e, now) })}</span>
                        ) : (
                          <>
                            {e.location && <span>{e.location}</span>}
                            {count !== undefined && (
                              <span>{tp("kalender.week.accepted", count)}</span>
                            )}
                          </>
                        )}
                      </button>
                    );
                  })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
