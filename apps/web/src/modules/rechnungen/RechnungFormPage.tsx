import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t, tp } from "../../i18n";
import {
  Button,
  Message,
  PageHeader,
  Panel,
  Select,
  TextArea,
  TextField,
  useToast,
  Badge,
} from "../../ui";
import { useCurrentTab, useTabs } from "../../shell/tabs";
import {
  addDays,
  addressLines,
  amount,
  chf,
  computeTotals,
  date,
  formatIban,
  lineNet,
  parseAmount,
  parseDate,
  parseQuantity,
  quantity,
  vat,
  vatRate,
  type BillingSettings,
  type InvoiceLine,
  type Recipient,
} from "./model";
import { errorText, invoiceName, Kv, Loading, LoadError, useLoad } from "./parts";
import { RecipientPicker } from "./RecipientPicker";
import { useRechnungen, type InvoiceDetail } from "./service";
import "./rechnungen.css";

interface LineForm {
  key: number;
  description: string;
  qty: string;
  price: string;
  vatBp: number;
}

interface FormState {
  recipient: Recipient | null;
  term: number;
  issueDate: string;
  subject: string;
  notes: string;
  lines: LineForm[];
}

const TERMS = [10, 14, 20, 30, 60];
const VAT_RATES = [0, 260, 380, 810];

function emptyLine(key: number, vatBp: number): LineForm {
  return { key, description: "", qty: "1", price: "", vatBp };
}

/** Eingaben als Positionen; ungültige Zeilen zählen als 0, die Prüfung beim Speichern meldet sie. */
function toLines(lines: readonly LineForm[]): InvoiceLine[] {
  return lines.map((l) => ({
    description: l.description.trim(),
    quantityMilli: parseQuantity(l.qty) ?? 0,
    unitCents: parseAmount(l.price) ?? 0,
    vatRateBp: l.vatBp,
  }));
}

/** Rechnung erstellen oder Entwurf bearbeiten (Design 4.2). */
export function RechnungFormPage() {
  const service = useRechnungen();
  const { params } = useCurrentTab();
  const settings = useLoad(() => service.getSettings(), "settings");
  const editId = params["id"];
  const existing = useLoad(
    async () => (editId ? await service.getInvoice(editId) : null),
    `edit-${editId ?? ""}`,
  );
  // Parameter «personId» und «name»: Empfänger, den ein anderes Modul (z. B. Personen) vorwählt.
  const presetId = editId ? undefined : params["personId"];
  const preset = useLoad(
    async () =>
      presetId
        ? ((await service.searchRecipients(params["name"] ?? "").catch(() => [])).find(
            (r) => r.id === presetId,
          ) ?? null)
        : null,
    `preset-${presetId ?? ""}`,
  );
  if (settings.state.status === "error")
    return (
      <LoadError
        what={t("rechnungen.form.title")}
        state={settings.state}
        onRetry={settings.reload}
      />
    );
  if (existing.state.status === "error")
    return (
      <LoadError
        what={t("rechnungen.form.title")}
        state={existing.state}
        onRetry={existing.reload}
      />
    );
  if (
    settings.state.status !== "ready" ||
    existing.state.status !== "ready" ||
    preset.state.status !== "ready"
  )
    return <Loading />;
  return (
    <Form
      settings={settings.state.data}
      existing={existing.state.data}
      preset={preset.state.data}
    />
  );
}

function Form({
  settings,
  existing,
  preset,
}: {
  settings: BillingSettings;
  existing: InvoiceDetail | null;
  preset: Recipient | null;
}) {
  const service = useRechnungen();
  const toast = useToast();
  const { openTab } = useTabs();
  const tab = useCurrentTab();
  const nextKey = useRef(2);
  const vatMode = settings.defaultVatMode;
  const defaultVat = vatMode === "none" ? 0 : settings.defaultVatRateBp;
  const today = service.today();

  const initial = useMemo<FormState>(() => {
    if (!existing) {
      return {
        recipient: preset,
        term: settings.paymentTermDays,
        issueDate: date(today),
        subject: "",
        notes: "",
        lines: [emptyLine(1, defaultVat)],
      };
    }
    const inv = existing.invoice;
    const term = Math.round((Date.parse(inv.dueDate) - Date.parse(inv.issueDate)) / 864e5);
    return {
      recipient: {
        id: inv.customerId ?? "",
        name: inv.debtor.name,
        address: inv.debtor,
        email: existing.email,
      },
      term,
      issueDate: date(inv.issueDate),
      subject: inv.subject,
      notes: inv.notes,
      lines: inv.lines.map((l, i) => ({
        key: i + 1,
        description: l.description,
        qty: quantity(l.quantityMilli),
        price: amount(l.unitCents).replace(/'/g, ""),
        vatBp: l.vatRateBp,
      })),
    };
    // Nur beim Öffnen: spätere Änderungen der Eingaben dürfen den Ausgangszustand nicht verschieben.
  }, []);

  const [form, setForm] = useState<FormState>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const saved = useRef(
    existing ? { id: existing.invoice.id, version: existing.invoice.version } : null,
  );
  const [baseline, setBaseline] = useState(() => JSON.stringify(initial));
  const dirty = useMemo(() => JSON.stringify(form) !== baseline, [form, baseline]);
  const [everSaved, setEverSaved] = useState(false);

  const patch = (p: Partial<FormState>) => setForm((f) => ({ ...f, ...p }));
  const setLine = (key: number, p: Partial<LineForm>) =>
    setForm((f) => ({ ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...p } : l)) }));

  const issueIso = parseDate(form.issueDate);
  const dueIso = issueIso ? addDays(issueIso, form.term) : null;
  const lines = toLines(form.lines);
  const totals = computeTotals(lines, vatMode, settings.roundTo5);

  useEffect(() => tab.setDirty(dirty), [dirty, tab]);
  useEffect(() => {
    if (existing)
      tab.setTitle(t("rechnungen.form.tabEdit", { name: invoiceName(existing.invoice) }));
  }, [existing, tab]);

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!form.recipient) e["recipient"] = t("rechnungen.form.err.recipient");
    if (!issueIso) e["issueDate"] = t("rechnungen.form.err.date");
    form.lines.forEach((l, i) => {
      if (
        l.description.trim() === "" ||
        parseQuantity(l.qty) === null ||
        parseAmount(l.price) === null
      )
        e[`line${i}`] = t("rechnungen.form.err.line", { n: i + 1 });
    });
    return e;
  };

  /** Speichert den Entwurf. `null` bei ungültigen Eingaben oder Fehler des Servers. */
  const persist = useCallback(async () => {
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0 || !form.recipient || !issueIso || !dueIso) return null;
    setBusy(true);
    try {
      const inv = await service.saveDraft(
        {
          recipient: form.recipient,
          issueDate: issueIso,
          dueDate: dueIso,
          subject: form.subject.trim(),
          notes: form.notes.trim(),
          lines,
        },
        saved.current ?? undefined,
      );
      saved.current = { id: inv.id, version: inv.version };
      setEverSaved(true);
      setBaseline(JSON.stringify(form));
      tab.setDirty(false);
      return inv;
    } catch (err) {
      toast.show({ tone: "error", title: t("rechnungen.form.saveFailed"), text: errorText(err) });
      return null;
    } finally {
      setBusy(false);
    }
  }, [form, service, tab, toast]);

  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => tab.registerSave(async () => (await persistRef.current()) !== null), [tab]);

  const draft = async () => {
    if (await persist()) toast.show({ tone: "ok", title: t("rechnungen.form.saved") });
  };
  const openDetail = (id: string, name: string, extra: Record<string, string>) =>
    openTab("rechnung", {
      key: id,
      params: { id, ...extra },
      title: t("rechnungen.detail.tab", { name }),
    });
  const preview = async () => {
    const inv = await persist();
    if (inv) openDetail(inv.id, invoiceName(inv), { view: "paper" });
  };
  const sendNow = async () => {
    const inv = await persist();
    if (!inv) return;
    openDetail(inv.id, invoiceName(inv), { send: "1" });
  };

  const showDirty = dirty;
  const rec = form.recipient;
  const vatOptions = (
    vatMode === "none" ? [0] : [...new Set([...VAT_RATES, form.lines[0]?.vatBp ?? 0])]
  ).sort((a, b) => a - b);
  const termOptions = [...new Set([...TERMS, settings.paymentTermDays, form.term])].sort(
    (a, b) => a - b,
  );

  return (
    <div className="page">
      <PageHeader
        crumb={
          existing
            ? t("rechnungen.crumb.invoice", { name: invoiceName(existing.invoice) })
            : t("rechnungen.form.crumb")
        }
        title={existing ? t("rechnungen.form.titleEdit") : t("rechnungen.form.title")}
        status={
          showDirty ? (
            <Badge tone="warning">{t("rechnungen.form.unsaved")}</Badge>
          ) : existing || everSaved ? (
            <Badge>{t("rechnungen.status.draft")}</Badge>
          ) : undefined
        }
        actions={
          <>
            <Button icon="eye" disabled={busy} onClick={() => void preview()}>
              {t("rechnungen.form.preview")}
            </Button>
            <Button icon="save" disabled={busy} onClick={() => void draft()}>
              {t("rechnungen.form.saveDraft")}
            </Button>
            <Button variant="primary" icon="send" disabled={busy} onClick={() => void sendNow()}>
              {t("rechnungen.form.saveAndSend")}
            </Button>
          </>
        }
      />
      <div className="rg-split">
        <div className="rg-col">
          <div className="rg-stack">
            <Panel title={t("rechnungen.form.panelRecipient")}>
              <div className="grid rg-grid3">
                <div className="rg-span2">
                  <RecipientPicker
                    value={rec}
                    onChange={(r) => patch({ recipient: r })}
                    search={(q, signal) => service.searchRecipients(q, signal)}
                    error={errors["recipient"]}
                  />
                </div>
                <Select
                  label={t("rechnungen.form.term")}
                  required
                  value={String(form.term)}
                  onChange={(e) => patch({ term: Number(e.target.value) })}
                  options={termOptions.map((d) => ({
                    value: String(d),
                    label: tp("rechnungen.form.days", d),
                  }))}
                />
                <TextField
                  label={t("rechnungen.form.issueDate")}
                  required
                  value={form.issueDate}
                  hint={t("rechnungen.form.dateHint")}
                  error={errors["issueDate"]}
                  onChange={(e) => patch({ issueDate: e.target.value })}
                />
                <TextField
                  label={t("rechnungen.form.dueDate")}
                  readOnly
                  value={dueIso ? date(dueIso) : ""}
                  hint={t("rechnungen.form.dueHint")}
                />
                <TextField
                  label={t("rechnungen.form.number")}
                  readOnly
                  value={existing?.invoice.number ?? ""}
                  placeholder={t("rechnungen.form.numberPlaceholder")}
                  hint={t("rechnungen.form.numberHint")}
                />
                <div className="rg-span3">
                  <TextField
                    label={t("rechnungen.form.subject")}
                    value={form.subject}
                    onChange={(e) => patch({ subject: e.target.value })}
                  />
                </div>
              </div>
            </Panel>
            <Panel title={t("rechnungen.form.panelLines")} flush>
              <table className="tbl rg-lines" aria-label={t("rechnungen.form.panelLines")}>
                <colgroup>
                  <col />
                  <col />
                  <col />
                  <col />
                  <col />
                  <col />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">{t("rechnungen.form.col.pos")}</th>
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
                    <th scope="col">
                      <span className="visually-hidden">{t("rechnungen.form.col.remove")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {form.lines.map((l, i) => (
                    <tr key={l.key}>
                      <td>{i + 1}</td>
                      <td>
                        <input
                          className="in in--cell"
                          aria-label={t("rechnungen.form.lineField", {
                            field: t("rechnungen.form.col.description"),
                            n: i + 1,
                          })}
                          aria-invalid={errors[`line${i}`] ? true : undefined}
                          value={l.description}
                          onChange={(e) => setLine(l.key, { description: e.target.value })}
                        />
                      </td>
                      <td className="r">
                        <input
                          className="in in--cell r"
                          aria-label={t("rechnungen.form.lineField", {
                            field: t("rechnungen.form.col.qty"),
                            n: i + 1,
                          })}
                          value={l.qty}
                          onChange={(e) => setLine(l.key, { qty: e.target.value })}
                        />
                      </td>
                      <td className="r">
                        <input
                          className="in in--cell r"
                          aria-label={t("rechnungen.form.lineField", {
                            field: t("rechnungen.form.col.price"),
                            n: i + 1,
                          })}
                          inputMode="decimal"
                          value={l.price}
                          onChange={(e) => setLine(l.key, { price: e.target.value })}
                          onBlur={() => {
                            const c = parseAmount(l.price);
                            if (c !== null) setLine(l.key, { price: amount(c).replace(/'/g, "") });
                          }}
                        />
                      </td>
                      <td className="r">
                        <select
                          className="in in--cell"
                          aria-label={t("rechnungen.form.lineField", {
                            field: t("rechnungen.form.col.vat"),
                            n: i + 1,
                          })}
                          value={l.vatBp}
                          disabled={vatMode === "none"}
                          onChange={(e) => setLine(l.key, { vatBp: Number(e.target.value) })}
                        >
                          {vatOptions.map((bp) => (
                            <option key={bp} value={bp}>
                              {vat(bp)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="r">{amount(lineNet(toLines([l])[0]!))}</td>
                      <td>
                        <Button
                          variant="ghost"
                          small
                          icon="trash"
                          aria-label={t("rechnungen.form.removeLine", { n: i + 1 })}
                          disabled={form.lines.length === 1}
                          onClick={() =>
                            setForm((f) => ({
                              ...f,
                              lines: f.lines.filter((x) => x.key !== l.key),
                            }))
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {Object.entries(errors)
                .filter(([k]) => k.startsWith("line"))
                .map(([k, text]) => (
                  <p key={k} className="lbl__error rg-add" role="alert">
                    {text}
                  </p>
                ))}
              <div className="rg-add">
                <Button
                  small
                  icon="plus"
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      lines: [...f.lines, emptyLine(nextKey.current++, defaultVat)],
                    }))
                  }
                >
                  {t("rechnungen.form.addLine")}
                </Button>
              </div>
            </Panel>
            <Panel title={t("rechnungen.form.panelText")}>
              <TextArea
                label={t("rechnungen.form.notes")}
                rows={2}
                value={form.notes}
                onChange={(e) => patch({ notes: e.target.value })}
              />
            </Panel>
          </div>
        </div>
        <div className="rg-col--form">
          <Panel title={t("rechnungen.form.panelSum")}>
            <dl className="kv rg-kv rg-kv--120">
              <Kv label={t("rechnungen.sum.net")}>{chf(totals.netCents)}</Kv>
              {totals.vatBuckets
                .filter((b) => b.rateBp > 0)
                .map((b) => (
                  <Kv key={b.rateBp} label={t("rechnungen.sum.vat", { rate: vatRate(b.rateBp) })}>
                    {chf(b.vatCents)}
                  </Kv>
                ))}
              {totals.roundingCents !== 0 && (
                <Kv label={t("rechnungen.sum.rounding")}>{chf(totals.roundingCents)}</Kv>
              )}
              <dt>
                <b>{t("rechnungen.sum.total")}</b>
              </dt>
              <dd>
                <b>{chf(totals.totalCents)}</b>
              </dd>
            </dl>
          </Panel>
          <Panel title={t("rechnungen.form.panelPayment")}>
            <dl className="kv rg-kv rg-kv--80">
              <dt>{t("rechnungen.form.qrIban")}</dt>
              <dd>{formatIban(settings.iban)}</dd>
              <dt>{t("rechnungen.form.reference")}</dt>
              <dd>{t("rechnungen.form.referenceLater")}</dd>
            </dl>
            <div className="muted rg-note">{t("rechnungen.form.qrNote")}</div>
          </Panel>
          {rec && (
            <Panel title={t("rechnungen.form.panelAddress")}>
              <span>
                {addressLines(rec.address).map((l, i) => (
                  <span key={l}>
                    {i > 0 && <br />}
                    {l}
                  </span>
                ))}
              </span>
              {rec.email && <div className="muted rg-note rg-note--tight">{rec.email}</div>}
            </Panel>
          )}
          {showDirty && (
            <Message tone="warning" title={t("rechnungen.form.dirtyTitle")}>
              {t("rechnungen.form.dirtyText")}
            </Message>
          )}
        </div>
      </div>
    </div>
  );
}
