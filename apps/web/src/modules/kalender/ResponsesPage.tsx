import { useEffect, useMemo, useState } from "react";
import { t, tp } from "../../i18n";
import { useCurrentTab } from "../../shell/tabs";
import { useOnTabActivate } from "../../shell/useOnTabActivate";
import {
  Badge,
  Button,
  DataTable,
  Icon,
  Message,
  PageHeader,
  type Column,
  type Sort,
} from "../../ui";
import type { InviteResult, ParticipantRow } from "./calendarService";
import { useCalendar } from "./CalendarContext";
import { LoadError, useEvent, useParticipants } from "./hooks";
import { FilterSelect, Pager, SearchBox, usePaging } from "./ListParts";
import { formatStamp } from "./time";

const ALL = "all";
const NO_ROWS: ParticipantRow[] = [];

const percent = (part: number, whole: number): number => (whole > 0 ? (part / whole) * 100 : 0);

/** Rückmeldungen eines Events (Design 8.6): Übersicht, Filter und Liste aller Antworten. */
export function ResponsesTab() {
  const tab = useCurrentTab();
  const { service } = useCalendar();
  const eventId = tab.params["eventId"];
  const event = useEvent(eventId);
  const list = useParticipants(eventId, false);
  useOnTabActivate(list.reload);
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState(ALL);
  const [note, setNote] = useState(ALL);
  const [sort, setSort] = useState<Sort>({ key: "respondedAt", direction: "desc" });
  const [resent, setResent] = useState<InviteResult | "failed" | null>(null);

  const title = event.result.state === "ready" ? event.result.value.title : "";
  useEffect(() => {
    if (title) tab.setTitle(t("kalender.tab.responses", { title }));
  }, [tab, title]);

  const rows = list.result.state === "ready" ? list.result.value.rows : NO_ROWS;
  const answered = useMemo(() => rows.filter((r) => r.status !== "pending"), [rows]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sign = sort.direction === "asc" ? 1 : -1;
    return answered
      .filter(
        (r) =>
          (!q || r.name.toLowerCase().includes(q)) &&
          (answer === ALL || r.status === answer) &&
          (note === ALL || (note === "with" ? r.note !== "" : r.note === "")),
      )
      .sort((a, b) => sign * (a.respondedAt ?? "").localeCompare(b.respondedAt ?? ""));
  }, [answered, query, answer, note, sort.direction]);

  const paging = usePaging(filtered.length, `${query}|${answer}|${note}`);
  const shown = paging.slice(filtered);

  if (event.result.state === "error") {
    return <LoadError status={event.result.status} onRetry={event.reload} />;
  }
  if (list.result.state === "error") {
    return <LoadError status={list.result.status} onRetry={list.reload} />;
  }
  if (event.result.state === "loading" || list.result.state === "loading") {
    return (
      <div className="state-page" role="status">
        <span className="muted is-loading">{t("kalender.loading")}</span>
      </div>
    );
  }

  const s = list.result.value.summary;
  const answers = s.accepted + s.declined;

  const resendLinks = async () => {
    try {
      setResent(await service.resend(event.result.state === "ready" ? event.result.value.id : ""));
      list.reload();
    } catch {
      setResent("failed");
    }
  };

  const columns: Column<ParticipantRow>[] = [
    {
      key: "respondedAt",
      header: t("kalender.col.received"),
      width: "173px",
      sortable: true,
      cell: (r) => (
        <span className="num">{r.respondedAt ? formatStamp(Date.parse(r.respondedAt)) : "–"}</span>
      ),
    },
    { key: "name", header: t("kalender.col.name"), width: "217px", cell: (r) => <b>{r.name}</b> },
    {
      key: "answer",
      header: t("kalender.col.answer"),
      width: "129px",
      cell: (r) =>
        r.status === "accepted" ? (
          <Badge tone="ok">
            <Icon name="check" size={12} />
            {t("kalender.answer.accepted")}
          </Badge>
        ) : (
          <Badge>
            <Icon name="close" size={12} />
            {t("kalender.answer.declined")}
          </Badge>
        ),
    },
    {
      key: "guests",
      header: t("kalender.col.guests"),
      width: "118px",
      align: "right",
      cell: (r) => (r.status === "accepted" ? r.guests : "–"),
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
        crumb={t("kalender.crumb.responses", { title })}
        title={t("kalender.responses.title", { title })}
        actions={
          <Button icon="send" disabled={s.pending === 0} onClick={() => void resendLinks()}>
            {tp("kalender.responses.resend", s.pending)}
          </Button>
        }
      />
      {resent && (
        <div className="page__body">
          {resent === "failed" ? (
            <Message tone="error" title={t("kalender.responses.resendFailed")} />
          ) : (
            <Message tone="ok" title={tp("kalender.invite.done", resent.sent)} />
          )}
        </div>
      )}
      <div className="cal-answers">
        <div
          role="img"
          className="cal-bar"
          aria-label={t("kalender.responses.bar", {
            accepted: s.accepted,
            declined: s.declined,
            pending: s.pending,
          })}
        >
          <span className="cal-bar__yes" style={{ width: `${percent(s.accepted, s.invited)}%` }} />
          <span className="cal-bar__no" style={{ width: `${percent(s.declined, s.invited)}%` }} />
          <span className="cal-bar__open" style={{ width: `${percent(s.pending, s.invited)}%` }} />
        </div>
        <div className="cal-answers__legend">
          <span className="opt">
            <span className="cal-swatch cal-swatch--yes" />
            <span>
              {t("kalender.responses.legend.accepted")} <b>{s.accepted}</b>
            </span>
          </span>
          <span className="opt">
            <span className="cal-swatch cal-swatch--no" />
            <span>
              {t("kalender.responses.legend.declined")} <b>{s.declined}</b>
            </span>
          </span>
          <span className="opt">
            <span className="cal-swatch cal-swatch--open" />
            <span>
              {t("kalender.responses.legend.pending")} <b>{s.pending}</b>
            </span>
          </span>
          <span className="muted">
            {t("kalender.responses.total", {
              invited: s.invited,
              answers,
              percent: Math.round(percent(answers, s.invited)),
            })}
          </span>
        </div>
      </div>
      <div className="cal-tool">
        <SearchBox label={t("kalender.responses.search")} value={query} onChange={setQuery} />
        <FilterSelect
          label={t("kalender.filter.answer")}
          value={answer}
          options={[
            { value: ALL, label: t("kalender.filter.answerAll") },
            { value: "accepted", label: t("kalender.filter.answerAccepted") },
            { value: "declined", label: t("kalender.filter.answerDeclined") },
          ]}
          onChange={setAnswer}
        />
        <FilterSelect
          label={t("kalender.filter.note")}
          value={note}
          options={[
            { value: ALL, label: t("kalender.filter.noteAll") },
            { value: "with", label: t("kalender.filter.noteWith") },
            { value: "without", label: t("kalender.filter.noteWithout") },
          ]}
          onChange={setNote}
        />
        <span className="cal-tool__spacer" />
        <span className="muted" aria-live="polite">
          {t("kalender.responses.count", { shown: shown.length, total: filtered.length })}
        </span>
      </div>
      <div className="cal-list">
        <DataTable
          label={t("kalender.responses.table")}
          columns={columns}
          rows={shown}
          rowKey={(r) => r.invitationId}
          sort={sort}
          onSortChange={setSort}
          empty={<span className="muted">{t("kalender.responses.none")}</span>}
        />
      </div>
      <Pager page={paging.page} pages={paging.pages} onChange={paging.setPage} />
    </div>
  );
}
