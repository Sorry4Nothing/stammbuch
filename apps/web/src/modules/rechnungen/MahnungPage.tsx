import { useState } from "react";
import { useAuth } from "../../auth/auth";
import { t, tp } from "../../i18n";
import { useCurrentTab } from "../../shell/tabs";
import { Badge, Button, Message, PageHeader, Panel, useToast } from "../../ui";
import { ReminderPaper } from "./Papier";
import { addDays, chf, date, levelLabel, type BillingSettings, type Reminder } from "./model";
import { errorText, invoiceName, Kv, Loading, LoadError, useLoad } from "./parts";
import { useRechnungen, type InvoiceDetail } from "./service";
import "./rechnungen.css";

/** Mahnung auf Papier mit Vorschau und Erzeugen (Design 4.6). */
export function MahnungPage() {
  const service = useRechnungen();
  const { params } = useCurrentTab();
  const id = params["id"] ?? "";
  const detail = useLoad(() => service.getInvoice(id), `reminder-${id}`);
  const settings = useLoad(() => service.getSettings(), "settings");
  if (detail.state.status === "error")
    return (
      <LoadError
        what={t("rechnungen.reminder.what")}
        state={detail.state}
        onRetry={detail.reload}
      />
    );
  if (settings.state.status === "error")
    return (
      <LoadError
        what={t("rechnungen.reminder.what")}
        state={settings.state}
        onRetry={settings.reload}
      />
    );
  if (detail.state.status !== "ready" || settings.state.status !== "ready") return <Loading />;
  return (
    <ReminderView data={detail.state.data} settings={settings.state.data} reload={detail.reload} />
  );
}

function ReminderView({
  data,
  settings,
  reload,
}: {
  data: InvoiceDetail;
  settings: BillingSettings;
  reload: () => void;
}) {
  const service = useRechnungen();
  const toast = useToast();
  const { session } = useAuth();
  const [issued, setIssued] = useState<Reminder | null>(null);
  const [busy, setBusy] = useState(false);
  const inv = data.invoice;
  const name = invoiceName(inv);
  const crumb = `${t("rechnungen.crumb.list")} / ${t("rechnungen.dunning.title")} / ${name}`;
  const level = data.dueLevel;

  // Nach dem Erzeugen steht die gespeicherte Mahnung, davor die Vorschau der fälligen Stufe.
  const today = service.today();
  const prior = data.reminders.filter((r) => r.level < (issued?.level ?? level?.level ?? 0));
  const reminder =
    issued ??
    (level
      ? {
          title: level.title,
          level: level.level,
          issuedOn: today,
          dueOn: addDays(today, level.graceDays),
          feeCents: level.feeCents,
          openCents: inv.openCents,
          totalCents: inv.openCents + prior.reduce((s, r) => s + r.feeCents, 0) + level.feeCents,
        }
      : null);

  if (!reminder) {
    return (
      <div className="page">
        <PageHeader crumb={crumb} title={t("rechnungen.reminder.noneTitle", { name })} />
        <div className="rg-body">
          <Message tone="warning" title={t("rechnungen.reminder.noneNote")}>
            {t("rechnungen.reminder.noneText")}
          </Message>
        </div>
      </div>
    );
  }

  const issue = async () => {
    setBusy(true);
    try {
      setIssued(await service.issueReminder(inv.id));
      toast.show({
        tone: "warning",
        title: t("rechnungen.reminder.done"),
        text: t("rechnungen.reminder.doneText"),
      });
      reload();
    } catch (e) {
      toast.show({ tone: "error", title: t("rechnungen.reminder.failed"), text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const pdf = () =>
    service
      .downloadPdf(inv.id, reminder.level)
      .catch((e: unknown) =>
        toast.show({ tone: "error", title: t("rechnungen.pdfFailed"), text: errorText(e) }),
      );

  return (
    <div className="page">
      <PageHeader
        crumb={crumb}
        title={t("rechnungen.reminder.title", { title: reminder.title, name })}
        status={
          <>
            <Badge tone="error">{reminder.title}</Badge>
            <Badge>{issued ? t("rechnungen.reminder.issued") : t("rechnungen.status.draft")}</Badge>
          </>
        }
        actions={
          <>
            <Button icon="print" onClick={() => window.print()}>
              {t("rechnungen.paper.print")}
            </Button>
            <Button icon="download" disabled={!issued} onClick={() => void pdf()}>
              {t("rechnungen.paper.savePdf")}
            </Button>
            {!issued && (
              <Button variant="primary" icon="send" disabled={busy} onClick={() => void issue()}>
                {t("rechnungen.reminder.send")}
              </Button>
            )}
          </>
        }
      />
      <div className="desk">
        <div className="side2">
          <Panel title={t("rechnungen.reminder.panel")}>
            <dl className="kv rg-kv rg-kv--88">
              <Kv label={t("rechnungen.reminder.stage")}>
                {levelLabel(reminder.level, reminder.title, "")}
              </Kv>
              <Kv label={t("rechnungen.reminder.fee")}>{chf(reminder.feeCents)}</Kv>
              <Kv label={t("rechnungen.reminder.term")}>
                {tp(
                  "rechnungen.form.days",
                  Math.round((Date.parse(reminder.dueOn) - Date.parse(reminder.issuedOn)) / 864e5),
                )}
              </Kv>
              <Kv label={t("rechnungen.reminder.payUntil")}>{date(reminder.dueOn)}</Kv>
              <Kv label={t("rechnungen.reminder.delivery")}>
                {t("rechnungen.reminder.deliveryValue")}
              </Kv>
            </dl>
          </Panel>
        </div>
        <ReminderPaper
          invoice={inv}
          reminder={reminder}
          previous={prior}
          settings={settings}
          signer={session?.name ?? ""}
        />
      </div>
    </div>
  );
}
