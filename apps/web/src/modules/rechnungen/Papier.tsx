import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { t } from "../../i18n";
import {
  addressLines,
  amount,
  date,
  formatIban,
  formatReference,
  lineNet,
  qrPayload,
  quantity,
  vat,
  vatRate,
  type Address,
  type BillingSettings,
  type Invoice,
  type Reminder,
} from "./model";
import { invoiceName } from "./parts";
import "./rechnungen.css";

const QR_SIZE = 145;

/**
 * QR-Code mit Schweizer Kreuz (Design 4.3). Lokal im Browser erzeugt; immer schwarz auf Weiss,
 * auch im dunklen Theme (Papier). Die Bibliothek lädt bei Bedarf.
 */
function SwissQr({ value, label }: { value: string; label: string }) {
  const [matrix, setMatrix] = useState<{ size: number; path: string } | null>(null);

  useEffect(() => {
    let live = true;
    import("qrcode").then(
      ({ create }) => {
        const { size, data } = create(value, { errorCorrectionLevel: "M" }).modules;
        let path = "";
        for (let i = 0; i < data.length; i++) {
          if (data[i]) path += `M${i % size} ${Math.floor(i / size)}h1v1h-1z`;
        }
        if (live) setMatrix({ size, path });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [value]);

  if (!matrix) return <div className="slip__qr" role="img" aria-label={label} />;
  const k = QR_SIZE / matrix.size;
  return (
    <svg
      className="slip__qr"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${QR_SIZE} ${QR_SIZE}`}
      shapeRendering="crispEdges"
    >
      <rect width={QR_SIZE} height={QR_SIZE} fill="var(--paper)" />
      <path d={matrix.path} transform={`scale(${k})`} fill="var(--paper-text)" />
      <rect x="58" y="58" width="28" height="28" fill="var(--paper)" />
      <rect x="63" y="63" width="18" height="18" fill="var(--paper-text)" />
      <rect x="70" y="66" width="4" height="12" fill="var(--paper)" />
      <rect x="66" y="70" width="12" height="4" fill="var(--paper)" />
    </svg>
  );
}

function Lines({ lines }: { lines: readonly string[] }) {
  return (
    <>
      {lines.map((l, i) => (
        <Fragment key={`${i}-${l}`}>
          {i > 0 && <br />}
          {l}
        </Fragment>
      ))}
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <b>{label}</b>
      <div>{children}</div>
    </div>
  );
}

/** «Mitgliedsnummer M-1042 · » vor einer Untertitelzeile, ohne Nummer leer (Design 4.3, 4.6). */
const memberPrefix = (invoice: Invoice) =>
  invoice.memberNumber
    ? `${t("rechnungen.paper.memberNumber", { number: invoice.memberNumber })} · `
    : "";

/** Adresse im Zahlteil: Name und Strasse (ohne Ort), wie im Board. */
const payerLines = (a: Address) => addressLines(a).slice(0, 2);

interface SlipProps {
  settings: BillingSettings;
  invoice: Invoice;
  /** Zu zahlender Betrag in Rappen. */
  cents: number;
}

/** Zahlteil mit Empfangsschein der QR-Rechnung. */
function Slip({ settings, invoice, cents }: SlipProps) {
  const reference = formatReference(invoice.reference);
  const account = (
    <>
      {formatIban(settings.iban)}
      <br />
      <Lines lines={addressLines(settings.creditor)} />
    </>
  );
  const referenceText = reference || <span>{t("rechnungen.form.referenceLater")}</span>;
  const payer = <Lines lines={payerLines(invoice.debtor)} />;
  const money = (
    <div className="slip__amount">
      <Field label={t("rechnungen.slip.currency")}>{invoice.currency}</Field>
      <Field label={t("rechnungen.slip.amount")}>{amount(cents)}</Field>
    </div>
  );
  const payload = useMemo(
    () =>
      qrPayload({
        iban: settings.iban,
        creditor: settings.creditor,
        debtor: invoice.debtor,
        amountCents: cents,
        currency: invoice.currency,
        reference: invoice.reference,
        message: invoice.number ? t("rechnungen.slip.info", { name: invoice.number }) : "",
      }),
    [settings, invoice, cents],
  );
  return (
    <div className="slip">
      <div className="slip__recv">
        <div className="slip__title">{t("rechnungen.slip.receipt")}</div>
        <Field label={t("rechnungen.slip.account")}>{account}</Field>
        <Field label={t("rechnungen.slip.reference")}>{referenceText}</Field>
        <Field label={t("rechnungen.slip.payer")}>{payer}</Field>
        {money}
        <div className="slip__accept">{t("rechnungen.slip.acceptance")}</div>
      </div>
      <div className="slip__pay">
        <div className="slip__code">
          <div className="slip__title">{t("rechnungen.slip.payPart")}</div>
          <SwissQr value={payload} label={t("rechnungen.slip.qr")} />
          {money}
        </div>
        <div className="slip__info">
          <Field label={t("rechnungen.slip.account")}>{account}</Field>
          <Field label={t("rechnungen.slip.reference")}>{referenceText}</Field>
          {invoice.number && (
            <Field label={t("rechnungen.slip.additional")}>
              {t("rechnungen.slip.info", { name: invoice.number })}
            </Field>
          )}
          <Field label={t("rechnungen.slip.payer")}>{payer}</Field>
        </div>
      </div>
    </div>
  );
}

/** Briefkopf: Logo-Platz links, Absender rechts, darunter Empfänger und Ort mit Datum. */
function Head({
  settings,
  debtor,
  day,
}: {
  settings: BillingSettings;
  debtor: Address;
  day: string;
}) {
  const c = settings.creditor;
  const street = [c.street, c.buildingNumber].filter(Boolean).join(" ");
  return (
    <>
      <div className="paper__head">
        <div className="plogo">{t("rechnungen.paper.logo", { name: c.name })}</div>
        <div className="mut paper__sender">
          <Lines
            lines={[
              c.name,
              `${street}, ${c.postalCode} ${c.town}`,
              ...settings.contactLines,
              ...(settings.vatNumber
                ? [t("rechnungen.paper.vatNumber", { number: settings.vatNumber })]
                : []),
            ]}
          />
        </div>
      </div>
      <div className="paper__to">
        <div>
          <Lines lines={addressLines(debtor)} />
        </div>
        <div className="mut">
          {c.town}, {date(day)}
        </div>
      </div>
    </>
  );
}

function Closing({ settings, signer }: { settings: BillingSettings; signer: string }) {
  return (
    <p className="paper__text--sm">
      {t("rechnungen.paper.regards")}
      <br />
      <b>{settings.creditor.name}</b>
      <br />
      {signer}
    </p>
  );
}

/** Rechnung als Papier mit QR-Zahlteil (Design 4.3). */
export function InvoicePaper({
  invoice,
  settings,
  signer,
}: {
  invoice: Invoice;
  settings: BillingSettings;
  signer: string;
}) {
  const totals = invoice.totals;
  const term = Math.round((Date.parse(invoice.dueDate) - Date.parse(invoice.issueDate)) / 864e5);
  return (
    <article
      className="paper"
      aria-label={t("rechnungen.paper.label", { name: invoiceName(invoice) })}
    >
      <Head settings={settings} debtor={invoice.debtor} day={invoice.issueDate} />
      <h2 className="paper__title">
        {invoice.number
          ? t("rechnungen.paper.invoiceTitle", { name: invoice.number })
          : t("rechnungen.paper.invoice")}
      </h2>
      <div className="mut paper__sub">
        {memberPrefix(invoice)}
        {t("rechnungen.paper.payUntil", { date: date(invoice.dueDate), days: term })}
      </div>
      <table className="paper__table">
        <thead>
          <tr>
            <th scope="col">{t("rechnungen.paper.col.description")}</th>
            <th scope="col" className="r">
              {t("rechnungen.paper.col.qty")}
            </th>
            <th scope="col" className="r">
              {t("rechnungen.paper.col.price")}
            </th>
            <th scope="col" className="r">
              {t("rechnungen.paper.col.vat")}
            </th>
            <th scope="col" className="r">
              {t("rechnungen.paper.col.amount")}
            </th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((l, i) => (
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
      <table className="paper__sums">
        <tbody>
          <tr>
            <td>{t("rechnungen.sum.net")}</td>
            <td className="r">CHF {amount(totals.netCents)}</td>
          </tr>
          {totals.vatBuckets
            .filter((b) => b.rateBp > 0)
            .map((b) => (
              <tr key={b.rateBp}>
                <td>
                  {t("rechnungen.paper.vatOn", {
                    rate: vatRate(b.rateBp),
                    net: amount(b.netCents),
                  })}
                </td>
                <td className="r">CHF {amount(b.vatCents)}</td>
              </tr>
            ))}
          {totals.roundingCents !== 0 && (
            <tr>
              <td>{t("rechnungen.sum.rounding")}</td>
              <td className="r">CHF {amount(totals.roundingCents)}</td>
            </tr>
          )}
          <tr>
            <td>
              <b>{t("rechnungen.sum.total")}</b>
            </td>
            <td className="r">
              <b>CHF {amount(totals.totalCents)}</b>
            </td>
          </tr>
        </tbody>
      </table>
      {invoice.notes && <p className="paper__text">{invoice.notes}</p>}
      <Closing settings={settings} signer={signer} />
      <Slip settings={settings} invoice={invoice} cents={totals.totalCents} />
    </article>
  );
}

/** Mahnung als Papier (Design 4.6). `previous` sind die früheren Mahnungen derselben Rechnung. */
export function ReminderPaper({
  invoice,
  reminder,
  previous,
  settings,
  signer,
}: {
  invoice: Invoice;
  reminder: Pick<
    Reminder,
    "title" | "issuedOn" | "dueOn" | "feeCents" | "openCents" | "totalCents"
  >;
  previous: readonly Reminder[];
  settings: BillingSettings;
  signer: string;
}) {
  const last = previous.at(-1);
  const fees = [
    ...previous.filter((r) => r.feeCents > 0),
    ...(reminder.feeCents > 0 ? [reminder] : []),
  ];
  return (
    <article className="paper" aria-label={t("rechnungen.paper.label", { name: reminder.title })}>
      <Head settings={settings} debtor={invoice.debtor} day={reminder.issuedOn} />
      <h2 className="paper__title">{reminder.title}</h2>
      <div className="mut paper__sub">
        {t("rechnungen.paper.reminderRef", {
          name: invoiceName(invoice),
          date: date(invoice.issueDate),
        })}
        {invoice.memberNumber
          ? ` · ${t("rechnungen.paper.memberNumber", { number: invoice.memberNumber })}`
          : ""}
      </div>
      <p className="paper__text">{t("rechnungen.paper.salutation")}</p>
      <p className="paper__text--sm">
        {t("rechnungen.paper.reminderIntro")}{" "}
        {last &&
          t("rechnungen.paper.reminderPrev", { title: last.title, date: date(last.issuedOn) })}{" "}
        {t("rechnungen.paper.reminderPay")} <b>{date(reminder.dueOn)}</b>.
      </p>
      <table className="paper__table">
        <thead>
          <tr>
            <th scope="col">{t("rechnungen.paper.col.description")}</th>
            <th scope="col" className="r">
              {t("rechnungen.paper.col.due")}
            </th>
            <th scope="col" className="r">
              {t("rechnungen.paper.col.sum")}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              {t("rechnungen.paper.reminderInvoice", {
                name: invoiceName(invoice),
                date: date(invoice.issueDate),
              })}
            </td>
            <td className="r">{date(invoice.dueDate)}</td>
            <td className="r">CHF {amount(reminder.openCents)}</td>
          </tr>
          {fees.map((f) => (
            <tr key={f.title}>
              <td>{t("rechnungen.paper.reminderFee", { title: f.title })}</td>
              <td className="r">–</td>
              <td className="r">CHF {amount(f.feeCents)}</td>
            </tr>
          ))}
          <tr>
            <td>
              <b>{t("rechnungen.paper.reminderTotal")}</b>
            </td>
            <td className="r" />
            <td className="r">
              <b>CHF {amount(reminder.totalCents)}</b>
            </td>
          </tr>
        </tbody>
      </table>
      <p className="paper__text--tight">{t("rechnungen.paper.reminderCrossed")}</p>
      <Closing settings={settings} signer={signer} />
      <Slip settings={settings} invoice={invoice} cents={reminder.totalCents} />
    </article>
  );
}
