import { useEffect, useMemo, useState } from "react";
import { t, tp } from "../../i18n";
import { useCurrentTab } from "../../shell/tabs";
import { useOnTabActivate } from "../../shell/useOnTabActivate";
import { Badge, Button, DataTable, PageHeader, useToast, type Column, type Sort } from "../../ui";
import type { ParticipantRow } from "./calendarService";
import { useCalendar } from "./CalendarContext";
import { LoadError, useEvent, useParticipants } from "./hooks";
import { FilterSelect, Pager, SearchBox, usePaging } from "./ListParts";
import { formatStamp, wallOf } from "./time";

const ALL = "all";
const NO_ROWS: ParticipantRow[] = [];

/** Sortierung nach Zeitpunkt der Rückmeldung (ISO-Zeichenketten sind direkt vergleichbar). */
export function sortByResponse(rows: readonly ParticipantRow[], direction: "asc" | "desc") {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => sign * (a.respondedAt ?? "").localeCompare(b.respondedAt ?? ""));
}

/** Teilnehmerliste live mit Xlsx-Export (Design 8.5). */
export function ParticipantsTab() {
  const tab = useCurrentTab();
  const { service } = useCalendar();
  const toast = useToast();
  const event = useEvent(tab.params["eventId"]);
  const list = useParticipants(tab.params["eventId"], true);
  useOnTabActivate(list.reload);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState(ALL);
  const [guests, setGuests] = useState(ALL);
  const [sort, setSort] = useState<Sort>({ key: "respondedAt", direction: "desc" });

  const title = event.result.state === "ready" ? event.result.value.title : "";
  useEffect(() => {
    if (title) tab.setTitle(t("kalender.tab.participants", { title }));
  }, [tab, title]);

  const rows = list.result.state === "ready" ? list.result.value.rows : NO_ROWS;
  const accepted = useMemo(() => rows.filter((r) => r.status === "accepted"), [rows]);
  const groups = useMemo(
    () => [...new Set(accepted.map((r) => r.group).filter((g): g is string => !!g))].sort(),
    [accepted],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sortByResponse(
      accepted.filter(
        (r) =>
          (!q ||
            r.name.toLowerCase().includes(q) ||
            (r.memberNo ?? "").toLowerCase().includes(q)) &&
          (group === ALL || r.group === group) &&
          (guests === ALL || (guests === "with" ? r.guests > 0 : r.guests === 0)),
      ),
      sort.direction,
    );
  }, [accepted, query, group, guests, sort.direction]);

  const paging = usePaging(filtered.length, `${query}|${group}|${guests}`);
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
  const guestsTotal = s.attendees - s.accepted;
  const standAt = list.at ?? Date.now();
  const stand = wallOf(standAt);

  const exportList = async () => {
    try {
      await service.exportParticipants(event.result.state === "ready" ? event.result.value.id : "");
    } catch {
      toast.show({ tone: "error", title: t("kalender.export.failed") });
    }
  };

  const columns: Column<ParticipantRow>[] = [
    { key: "name", header: t("kalender.col.name"), width: "190px", cell: (r) => <b>{r.name}</b> },
    {
      key: "memberNo",
      header: t("kalender.col.memberNo"),
      width: "112px",
      cell: (r) => r.memberNo ?? "–",
    },
    { key: "group", header: t("kalender.col.group"), width: "150px", cell: (r) => r.group ?? "–" },
    {
      key: "guests",
      header: t("kalender.col.guests"),
      width: "96px",
      align: "right",
      cell: (r) => r.guests,
    },
    {
      key: "note",
      header: t("kalender.col.note"),
      cell: (r) => <span className="cal-note">{r.note || "–"}</span>,
    },
    {
      key: "respondedAt",
      header: t("kalender.col.responded"),
      width: "165px",
      sortable: true,
      cell: (r) => (
        <span className="num">{r.respondedAt ? formatStamp(Date.parse(r.respondedAt)) : "–"}</span>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        crumb={t("kalender.crumb.participants", { title })}
        title={t("kalender.participants.title", { title })}
        status={
          <>
            <Badge tone="ok">{t("kalender.live")}</Badge>
            <span className="muted">
              {t("kalender.stand", { date: formatStamp(standAt).slice(0, 10), time: stand.clock })}
            </span>
          </>
        }
        actions={
          <Button variant="primary" icon="table" onClick={() => void exportList()}>
            {t("kalender.export")}
          </Button>
        }
      />
      <p role="status" className="cal-sum">
        {t("kalender.participants.summary.a")}
        <b>{tp("kalender.participants.accepted", s.accepted)}</b>
        {tp("kalender.participants.guests", guestsTotal)}
        <b>{tp("kalender.participants.attendees", s.attendees)}</b>
        {t("kalender.participants.summary.b", {
          declined: tp("kalender.participants.declined", s.declined),
          pending: s.pending,
        })}
      </p>
      <div className="cal-tool">
        <SearchBox label={t("kalender.participants.search")} value={query} onChange={setQuery} />
        <FilterSelect
          label={t("kalender.filter.group")}
          value={group}
          options={[
            { value: ALL, label: t("kalender.filter.groupAll") },
            ...groups.map((g) => ({
              value: g,
              label: t("kalender.filter.groupOne", { group: g }),
            })),
          ]}
          onChange={setGroup}
        />
        <FilterSelect
          label={t("kalender.filter.guests")}
          value={guests}
          options={[
            { value: ALL, label: t("kalender.filter.guestsAll") },
            { value: "with", label: t("kalender.filter.guestsWith") },
            { value: "without", label: t("kalender.filter.guestsWithout") },
          ]}
          onChange={setGuests}
        />
        <span className="cal-tool__spacer" />
        <span className="muted" aria-live="polite">
          {t("kalender.participants.count", { shown: shown.length, total: filtered.length })}
        </span>
      </div>
      <div className="cal-list">
        <DataTable
          label={t("kalender.participants.table")}
          columns={columns}
          rows={shown}
          rowKey={(r) => r.invitationId}
          sort={sort}
          onSortChange={setSort}
          empty={<span className="muted">{t("kalender.participants.none")}</span>}
        />
      </div>
      <Pager page={paging.page} pages={paging.pages} onChange={paging.setPage} />
    </div>
  );
}
