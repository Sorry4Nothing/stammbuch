import { Fragment, useEffect, useState } from "react";
import { useAuth } from "../../auth/auth";
import { t, tp } from "../../i18n";
import { useCurrentTab, useTabs } from "../../shell/tabs";
import { useOnTabActivate } from "../../shell/useOnTabActivate";
import { Badge, Button, Message, PageHeader, Panel, useToast } from "../../ui";
import { InvoicePaper } from "./Papier";
import {
  chf,
  date,
  displayStatus,
  levelLabel,
  daysBetween,
  formatReference,
  quantity,
  vat,
  amount,
  lineNet,
  type BillingSettings,
} from "./model";
import {
  errorText,
  History,
  invoiceName,
  Kv,
  Loading,
  LoadError,
  StatusBadge,
  UndeliveredBadge,
  useLoad,
} from "./parts";
import { clearUndelivered, markUndelivered, undeliveredAt } from "./mailState";
import {
  BookingsDialog,
  CancelDialog,
  CreditDialog,
  ReminderMailDialog,
  ResendDialog,
  SendDialog,
} from "./InvoiceDialogs";
import { useRechnungen, type HistoryEntry, type InvoiceDetail } from "./service";
import "./rechnungen.css";

type Dialog = "send" | "resend" | "reminderMail" | "cancel" | "credit" | "bookings" | null;

/** Rechnungsdetail mit Verlauf (4.12, 4.4, 4.7, 4.8) und Papieransicht (4.3). */
export function RechnungDetailPage() {
  const service = useRechnungen();
  const { params } = useCurrentTab();
  const id = params["id"] ?? "";
  const detail = useLoad(() => service.getInvoice(id), `invoice-${id}`);
  useOnTabActivate(detail.reload);
  const settings = useLoad(() => service.getSettings(), "settings");
  const mail = useLoad(() => service.mailAvailable(), "mail-available");

  if (detail.state.status === "error")
    return (
      <LoadError what={t("rechnungen.detail.what")} state={detail.state} onRetry={detail.reload} />
    );
  if (settings.state.status === "error")
    return (
      <LoadError
        what={t("rechnungen.detail.what")}
        state={settings.state}
        onRetry={settings.reload}
      />
    );
  if (
    detail.state.status !== "ready" ||
    settings.state.status !== "ready" ||
    mail.state.status !== "ready"
  )
    return <Loading />;
  return (
    <Detail
      data={detail.state.data}
      settings={settings.state.data}
      mailAvailable={mail.state.data}
      reload={detail.reload}
    />
  );
}

/** Bezugsnummer in Gruppen: ein Umbruch trennt nur zwischen den Gruppen, nie mitten in einer. */
function ReferenceText({ value }: { value: string }) {
  return (
    <>
      {value.split(" ").map((group, i) => (
        <Fragment key={`${i}-${group}`}>
          <span className="rg-nw">{group}</span>{" "}
        </Fragment>
      ))}
    </>
  );
}

function Detail({
  data,
  settings,
  mailAvailable,
  reload,
}: {
  data: InvoiceDetail;
  settings: BillingSettings;
  mailAvailable: boolean;
  reload: () => void;
}) {
  const service = useRechnungen();
  const toast = useToast();
  const { openTab } = useTabs();
  const tab = useCurrentTab();
  const { session } = useAuth();
  const inv = data.invoice;
  const name = invoiceName(inv);
  const draft = inv.status === "draft";
  const [view, setView] = useState<"detail" | "paper">(
    tab.params["view"] === "paper" ? "paper" : "detail",
  );
  const [dialog, setDialog] = useState<Dialog>(tab.params["send"] === "1" && draft ? "send" : null);
  // Gebucht, aber die Mail kam nicht in die Versandwarteschlange (Zustand liegt im Browser, siehe mailState.ts)
  const [undelivered, setUndelivered] = useState(() => (draft ? null : undeliveredAt(inv.id)));
  const history: HistoryEntry[] = undelivered
    ? [
        ...data.history,
        { id: "mail-failed", at: undelivered, kind: "mailFailed" as const, params: {} },
      ].sort((a, b) => a.at.localeCompare(b.at))
    : data.history;

  useEffect(() => {
    tab.setTitle(t("rechnungen.detail.tab", { name }));
  }, [tab, name]);

  const status = displayStatus(inv, data.level);
  const pdf = () =>
    service
      .downloadPdf(inv.id)
      .catch((e: unknown) =>
        toast.show({ tone: "error", title: t("rechnungen.pdfFailed"), text: errorText(e) }),
      );
  const done = (title: string, tone: "ok" | "warning" = "ok", text?: string) => {
    setDialog(null);
    toast.show({ tone, title, ...(text ? { text } : {}) });
    reload();
  };

  const badges = (
    <>
      <StatusBadge status={status} />
      {undelivered && <UndeliveredBadge />}
      <Badge>{t("rechnungen.detail.qrInvoice")}</Badge>
    </>
  );
  const crumbBase = t("rechnungen.crumb.list");

  const overdue =
    !draft && inv.status === "sent" && inv.openCents > 0
      ? daysBetween(inv.dueDate, service.today())
      : 0;
  const dueSince = draft
    ? t("rechnungen.detail.dueAfterSend")
    : inv.status !== "sent"
      ? "–"
      : overdue > 0
        ? tp("rechnungen.detail.dueSince", overdue)
        : t("rechnungen.detail.notDue");
  // Die zuletzt erzeugte Mahnung einer offenen Rechnung lässt sich per E-Mail senden.
  const lastReminder =
    inv.status === "sent"
      ? data.reminders.reduce<(typeof data.reminders)[number] | null>(
          (m, r) => (m && m.level >= r.level ? m : r),
          null,
        )
      : null;
  const canCancel = inv.status === "sent" && inv.paidCents === 0 && inv.creditedCents === 0;
  const canCredit =
    (inv.status === "sent" || inv.status === "paid") &&
    inv.totals.totalCents - inv.creditedCents > 0;

  const dialogs = (
    <>
      {dialog === "send" && (
        <SendDialog
          data={data}
          settings={settings}
          mailAvailable={mailAvailable}
          onClose={() => setDialog(null)}
          onPreview={() => {
            setDialog(null);
            setView("paper");
          }}
          onDone={(delivered, mode) => {
            // Nach dem Buchen ist die Detailansicht die Landeseite, auch wenn die Vorschau offen war.
            setView("detail");
            if (mode === "email" && !delivered) {
              markUndelivered(inv.id);
              setUndelivered(undeliveredAt(inv.id));
              done(t("rechnungen.send.doneNoMail"), "warning", t("rechnungen.send.doneNoMailText"));
            } else {
              done(mode === "pdf" ? t("rechnungen.send.donePdf") : t("rechnungen.send.doneMail"));
            }
          }}
        />
      )}
      {dialog === "resend" && (
        <ResendDialog
          data={data}
          settings={settings}
          mailAvailable={mailAvailable}
          onClose={() => setDialog(null)}
          onDone={() => {
            clearUndelivered(inv.id);
            setUndelivered(null);
            done(t("rechnungen.resend.done"));
          }}
        />
      )}
      {dialog === "reminderMail" && lastReminder && (
        <ReminderMailDialog
          data={data}
          settings={settings}
          mailAvailable={mailAvailable}
          reminder={lastReminder}
          onClose={() => setDialog(null)}
          onDone={() => done(t("rechnungen.reminderMail.done"))}
        />
      )}
      {dialog === "bookings" && <BookingsDialog data={data} onClose={() => setDialog(null)} />}
      {dialog === "cancel" && (
        <CancelDialog
          data={data}
          mailAvailable={mailAvailable}
          onClose={() => setDialog(null)}
          onDone={(notification) =>
            notification === "sent"
              ? done(t("rechnungen.cancel.done"), "ok", t("rechnungen.cancel.doneSent"))
              : notification === "no-address"
                ? done(t("rechnungen.cancel.done"), "warning", t("rechnungen.cancel.doneNoAddress"))
                : notification === "failed"
                  ? done(
                      t("rechnungen.cancel.done"),
                      "warning",
                      t("rechnungen.cancel.doneMailFailed"),
                    )
                  : done(t("rechnungen.cancel.done"))
          }
        />
      )}
      {dialog === "credit" && (
        <CreditDialog
          data={data}
          onClose={() => setDialog(null)}
          onDone={() => done(t("rechnungen.credit.done"))}
        />
      )}
    </>
  );

  if (view === "paper") {
    return (
      <div className="page rg-head">
        <PageHeader
          crumb={
            <>
              {crumbBase} /{" "}
              <button type="button" className="link" onClick={() => setView("detail")}>
                {name}
              </button>
            </>
          }
          title={t("rechnungen.detail.title", { name })}
          status={badges}
          actions={
            <>
              <Button icon="print" onClick={() => window.print()}>
                {t("rechnungen.paper.print")}
              </Button>
              <Button icon="download" onClick={() => void pdf()}>
                {t("rechnungen.paper.savePdf")}
              </Button>
              {draft && (
                <Button variant="primary" icon="send" onClick={() => setDialog("send")}>
                  {t("rechnungen.detail.send")}
                </Button>
              )}
            </>
          }
        />
        <div className="desk">
          <InvoicePaper invoice={inv} settings={settings} signer={session?.name ?? ""} />
        </div>
        {dialogs}
      </div>
    );
  }

  return (
    <div className="page rg-head">
      <PageHeader
        crumb={`${crumbBase} / ${name}`}
        title={t("rechnungen.detail.title", { name })}
        status={badges}
        actions={
          <>
            <Button icon="eye" onClick={() => setView("paper")}>
              {t("rechnungen.detail.paper")}
            </Button>
            {draft ? (
              <>
                <Button
                  icon="edit"
                  onClick={() =>
                    openTab("rechnung-neu", {
                      key: `edit-${inv.id}`,
                      params: { id: inv.id },
                      title: t("rechnungen.form.tabEdit", { name }),
                    })
                  }
                >
                  {t("rechnungen.detail.edit")}
                </Button>
                <Button variant="primary" icon="send" onClick={() => setDialog("send")}>
                  {t("rechnungen.detail.send")}
                </Button>
              </>
            ) : (
              <>
                {lastReminder && (
                  <Button icon="warning" onClick={() => setDialog("reminderMail")}>
                    {t("rechnungen.detail.sendReminder")}
                  </Button>
                )}
                <Button
                  variant={undelivered || !data.dueLevel ? "primary" : "secondary"}
                  icon="send"
                  onClick={() => setDialog("resend")}
                >
                  {t("rechnungen.detail.resend")}
                </Button>
                {data.dueLevel && (
                  <Button
                    variant={undelivered ? "secondary" : "primary"}
                    icon="warning"
                    onClick={() =>
                      openTab("mahnung", {
                        key: inv.id,
                        params: { id: inv.id },
                        title: t("rechnungen.reminder.tab", { name }),
                      })
                    }
                  >
                    {t("rechnungen.detail.createReminder", { title: data.dueLevel.title })}
                  </Button>
                )}
              </>
            )}
          </>
        }
      />
      <div className="rg-split">
        <div className="rg-col rg-col--wide">
          <div className="rg-stack">
            {undelivered && (
              <Message tone="warning" title={t("rechnungen.detail.undeliveredTitle")}>
                {t("rechnungen.detail.undeliveredText")}
              </Message>
            )}
            <Panel title={t("rechnungen.detail.panelInvoice")}>
              <dl className="kv rg-kv rg-kv--152">
                <Kv label={t("rechnungen.detail.recipient")}>
                  {inv.memberNumber ? `${inv.debtor.name} (${inv.memberNumber})` : inv.debtor.name}
                </Kv>
                <Kv label={t("rechnungen.detail.email")}>{data.email ?? "–"}</Kv>
                <Kv label={t("rechnungen.detail.subject")}>{inv.subject || "–"}</Kv>
                <Kv label={t("rechnungen.detail.issueDate")}>{date(inv.issueDate)}</Kv>
                <Kv label={t("rechnungen.detail.dueDate")}>{date(inv.dueDate)}</Kv>
              </dl>
            </Panel>
            <Panel title={t("rechnungen.detail.panelLines")} flush>
              <table className="tbl rg-dlines" aria-label={t("rechnungen.detail.panelLines")}>
                <colgroup>
                  <col />
                  <col />
                  <col />
                  <col />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">{t("rechnungen.form.col.description")}</th>
                    <th scope="col" className="r">
                      {t("rechnungen.form.col.qty")}
                    </th>
                    <th scope="col" className="r">
                      {t("rechnungen.form.col.price")}
                    </th>
                    <th scope="col" className="r">
                      {t("rechnungen.form.col.vat")}
                    </th>
                    <th scope="col" className="r">
                      {t("rechnungen.form.col.amount")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {inv.lines.map((l, i) => (
                    <tr key={i}>
                      <td>{l.description}</td>
                      <td className="r">{quantity(l.quantityMilli)}</td>
                      <td className="r">{amount(l.unitCents)}</td>
                      <td className="r">{vat(l.vatRateBp)}</td>
                      <td className="r">{amount(lineNet(l))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="rg-total">
                <span className="muted">{t("rechnungen.detail.totalInclVat")}</span>
                <b>{chf(inv.totals.totalCents, inv.currency)}</b>
              </div>
            </Panel>
            {draft ? (
              <Message title={t("rechnungen.detail.noBookingTitle")} />
            ) : (
              <Panel title={t("rechnungen.detail.panelActions")}>
                <div className="rg-actions">
                  <Button icon="undo" disabled={!canCredit} onClick={() => setDialog("credit")}>
                    {t("rechnungen.detail.credit")}
                  </Button>
                  <Button icon="book" onClick={() => setDialog("bookings")}>
                    {t("rechnungen.detail.bookings")}
                  </Button>
                  {/* Storno steht abgesetzt am Ende: es lässt sich nicht rückgängig machen */}
                  <span className="rg-actions__end">
                    <Button
                      variant="danger"
                      icon="ban"
                      disabled={!canCancel}
                      onClick={() => setDialog("cancel")}
                    >
                      {t("rechnungen.detail.cancel")}
                    </Button>
                  </span>
                </div>
              </Panel>
            )}
          </div>
        </div>
        <div className="rg-col">
          <div className="rg-stack">
            <Panel title={t("rechnungen.detail.panelPayment")}>
              <dl className="kv rg-kv rg-kv--112">
                <Kv label={t("rechnungen.detail.open")}>
                  {chf(draft ? inv.totals.totalCents : inv.openCents, inv.currency)}
                </Kv>
                <Kv label={t("rechnungen.detail.level")}>
                  {levelLabel(data.level, data.levelTitle, t("rechnungen.level.none"))}
                </Kv>
                <Kv label={t("rechnungen.detail.dueSinceLabel")}>{dueSince}</Kv>
                <Kv label={t("rechnungen.detail.reference")}>
                  {inv.reference && formatReference(inv.reference) ? (
                    <ReferenceText value={formatReference(inv.reference)} />
                  ) : (
                    t("rechnungen.form.referenceLater")
                  )}
                </Kv>
              </dl>
            </Panel>
            <Panel title={t("rechnungen.detail.panelHistory")}>
              <History entries={history} label={t("rechnungen.detail.panelHistory")} />
            </Panel>
          </div>
        </div>
      </div>
      {dialogs}
    </div>
  );
}
