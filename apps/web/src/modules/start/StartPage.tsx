import { useAuth } from "../../auth/auth";
import { orgName } from "../../config";
import { t } from "../../i18n";
import { DataTable, PageHeader, Panel, Stat, type Column } from "../../ui";

interface Row {
  id: string;
}

const dateFmt = new Intl.DateTimeFormat("de-CH", {
  weekday: "long",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/** «Montag, 02.11.2026» */
function today(now: number): string {
  const parts = Object.fromEntries(
    dateFmt.formatToParts(new Date(now)).map((p) => [p.type, p.value]),
  );
  return `${parts.weekday}, ${parts.day}.${parts.month}.${parts.year}`;
}

const tasks: Column<Row>[] = [
  { key: "task", header: t("start.tasks.task"), cell: () => null },
  { key: "due", header: t("start.tasks.due"), width: "90px", cell: () => null },
  { key: "status", header: t("start.tasks.status"), width: "100px", cell: () => null },
];

const items: Column<Row>[] = [
  { key: "invoice", header: t("start.items.invoice"), width: "112px", cell: () => null },
  { key: "debtor", header: t("start.items.debtor"), cell: () => null },
  {
    key: "amount",
    header: t("start.items.amount"),
    width: "114px",
    align: "right",
    cell: () => null,
  },
  { key: "due", header: t("start.items.due"), width: "96px", cell: () => null },
];

const events: Column<Row>[] = [
  { key: "event", header: t("start.events.event"), cell: () => null },
  { key: "date", header: t("start.events.date"), width: "160px", cell: () => null },
  { key: "yes", header: t("start.events.yes"), width: "90px", align: "right", cell: () => null },
  { key: "deadline", header: t("start.events.deadline"), width: "140px", cell: () => null },
];

const none: Row[] = [];
const rowKey = (r: Row) => r.id;

/**
 * Startseite (Design 2.1). Die Kennzahlen und Listen liefern die Fachmodule (Personen,
 * Rechnungen, Kalender); bis sie angebunden sind, zeigt die Seite den leeren Zustand.
 */
export function StartPage() {
  const { session, now } = useAuth();
  const org = session?.organization || orgName;
  const crumb = [today(now), org].filter(Boolean).join(" · ");
  const empty = <span className="muted">{t("start.empty")}</span>;

  return (
    <div className="page">
      <PageHeader title={t("start.title")} crumb={crumb} />
      <div className="page__body">
        <div className="grid grid--stats">
          <Stat label={t("start.stat.tasks")} value="–" />
          <Stat label={t("start.stat.items")} value="–" />
          <Stat label={t("start.stat.overdue")} value="–" />
          <Stat label={t("start.stat.members")} value="–" />
        </div>
        <div className="grid grid--two">
          <Panel title={t("start.tasks.title")} flush>
            <DataTable
              label={t("start.tasks.title")}
              columns={tasks}
              rows={none}
              rowKey={rowKey}
              empty={empty}
            />
          </Panel>
          <Panel title={t("start.items.title")} flush>
            <DataTable
              label={t("start.items.title")}
              columns={items}
              rows={none}
              rowKey={rowKey}
              empty={empty}
            />
          </Panel>
        </div>
        <Panel title={t("start.events.title")} flush>
          <DataTable
            label={t("start.events.title")}
            columns={events}
            rows={none}
            rowKey={rowKey}
            empty={empty}
          />
        </Panel>
      </div>
    </div>
  );
}
