import { useEffect, useState } from "react";
import { useAuth } from "../../auth/auth";
import { t, tp } from "../../i18n";
import { useCurrentTab, useTabs } from "../../shell/tabs";
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
  statusLabel,
  StatusBadge,
  useLoad,
} from "./parts";
import { CancelDialog, CreditDialog, SendDialog } from "./InvoiceDialogs";
import { useRechnungen, type InvoiceDetail } from "./service";
import "./rechnungen.css";

type Dialog = "send" | "cancel" | "credit" | null;

/** Rechnungsdetail mit Verlauf (4.12, 4.4, 4.7, 4.8) und Papieransicht (4.3). */
export function RechnungDetailPage() {
  const service = useRechnungen();
  const { params } = useCurrentTab();
  const id = params["id"] ?? "";
  const detail = useLoad(() => service.getInvoice(id), `invoice-${id}`);
  const settings = useLoad(() => service.getSettings(), "settings");

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
  if (detail.state.status !== "ready" || settings.state.status !== "ready") return <Loading />;
  return <Detail data={detail.state.data} settings={settings.state.data} reload={detail.reload} />;
}

function Detail({
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

  useEffect(() => {
    tab.setTitle(t("rechnungen.detail.tab", { name }));
  }, [tab, name]);

  const status = displayStatus(inv, data.level);
  const notAvailable = () =>
    toast.show({
      tone: "warning",
      title: t("rechnungen.unavailable.title"),
      text: t("rechnungen.unavailable.text"),
    });
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
          onClose={() => setDialog(null)}
          onPreview={() => {
            setDialog(null);
            setView("paper");
          }}
          onDone={(delivered, mode) =>
            delivered || mode === "pdf"
              ? done(mode === "pdf" ? t("rechnungen.send.donePdf") : t("rechnungen.send.doneMail"))
              : done(
                  t("rechnungen.send.doneNoMail"),
                  "warning",
                  t("rechnungen.send.doneNoMailText"),
                )
          }
        />
      )}
      {dialog === "cancel" && (
        <CancelDialog
          data={data}
          onClose={() => setDialog(null)}
          onDone={() => done(t("rechnungen.cancel.done"))}
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
      <div className="page">
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
          <div className="side2">
            <Panel title={t("rechnungen.paper.panelDocument")}>
              <dl className="kv rg-kv rg-kv--80">
                <Kv label={t("rechnungen.paper.format")}>{t("rechnungen.paper.formatValue")}</Kv>
                <Kv label={t("rechnungen.paper.language")}>
                  {t("rechnungen.paper.languageValue")}
                </Kv>
                <Kv label={t("rechnungen.paper.slip")}>{t("rechnungen.detail.qrInvoice")}</Kv>
                <Kv label={t("rechnungen.paper.logoLabel")}>{t("rechnungen.paper.logoValue")}</Kv>
              </dl>
            </Panel>
            {draft && (
              <Message title={t("rechnungen.paper.draftTitle")}>
                {t("rechnungen.paper.draftText")}
              </Message>
            )}
          </div>
          <InvoicePaper invoice={inv} settings={settings} signer={session?.name ?? ""} />
        </div>
        {dialogs}
      </div>
    );
  }

  return (
    <div className="page">
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
                <Button icon="send" onClick={notAvailable}>
                  {t("rechnungen.detail.resend")}
                </Button>
                {data.dueLevel && (
                  <Button
                    variant="primary"
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
            <Panel title={t("rechnungen.detail.panelInvoice")}>
              <dl className="kv rg-kv rg-kv--152">
                <Kv label={t("rechnungen.detail.recipient")}>{inv.debtor.name}</Kv>
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
              <Message title={t("rechnungen.detail.noBookingTitle")}>
                {t("rechnungen.detail.noBookingText")}
              </Message>
            ) : (
              <Panel title={t("rechnungen.detail.panelActions")}>
                <div className="rg-actions">
                  <Button icon="undo" disabled={!canCredit} onClick={() => setDialog("credit")}>
                    {t("rechnungen.detail.credit")}
                  </Button>
                  <Button icon="ban" disabled={!canCancel} onClick={() => setDialog("cancel")}>
                    {t("rechnungen.detail.cancel")}
                  </Button>
                  <Button icon="book" onClick={notAvailable}>
                    {t("rechnungen.detail.bookings")}
                  </Button>
                </div>
              </Panel>
            )}
          </div>
        </div>
        <div className="rg-col">
          <div className="rg-stack">
            <Panel title={t("rechnungen.detail.panelPayment")}>
              <dl className="kv rg-kv rg-kv--112">
                <Kv label={t("rechnungen.detail.status")}>{statusLabel(status)}</Kv>
                <Kv label={t("rechnungen.detail.open")}>
                  {chf(draft ? inv.totals.totalCents : inv.openCents, inv.currency)}
                </Kv>
                <Kv label={t("rechnungen.detail.level")}>
                  {levelLabel(data.level, data.levelTitle, t("rechnungen.level.none"))}
                </Kv>
                <Kv label={t("rechnungen.detail.dueSinceLabel")}>{dueSince}</Kv>
                <Kv label={t("rechnungen.detail.reference")}>
                  <span className="rg-kv-break">
                    {formatReference(inv.reference) || t("rechnungen.form.referenceLater")}
                  </span>
                </Kv>
              </dl>
            </Panel>
            <Panel title={t("rechnungen.detail.panelHistory")}>
              <History entries={data.history} label={t("rechnungen.detail.panelHistory")} />
            </Panel>
          </div>
        </div>
      </div>
      {dialogs}
    </div>
  );
}
