import { useState } from "react";
import { t } from "../../i18n";
import {
  Button,
  Checkbox,
  Dialog,
  Icon,
  Message,
  RadioGroup,
  Select,
  TextArea,
  TextField,
} from "../../ui";
import { amount, chf, date, parseAmount, type BillingSettings } from "./model";
import { errorText, invoiceName, Kv } from "./parts";
import { useRechnungen, type InvoiceDetail } from "./service";
import "./rechnungen.css";

interface Common {
  data: InvoiceDetail;
  onClose: () => void;
}

const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

/** Versenden (Design 4.4). */
export function SendDialog({
  data,
  settings,
  onClose,
  onPreview,
  onDone,
}: Common & {
  settings: BillingSettings;
  onPreview: () => void;
  onDone: (delivered: boolean, mode: "email" | "pdf") => void;
}) {
  const service = useRechnungen();
  const inv = data.invoice;
  const name = invoiceName(inv);
  const [mode, setMode] = useState<"email" | "pdf">("email");
  const [to, setTo] = useState(data.email ?? "");
  const [subject, setSubject] = useState(
    inv.number
      ? t("rechnungen.send.subjectNumber", { name: inv.number, date: date(inv.issueDate) })
      : t("rechnungen.send.subjectDraft", { date: date(inv.issueDate) }),
  );
  const [message, setMessage] = useState(
    t(inv.number ? "rechnungen.send.messageNumber" : "rechnungen.send.messageDraft", {
      name,
      amount: chf(inv.totals.totalCents, inv.currency),
      due: date(inv.dueDate),
      org: settings.creditor.name,
    }),
  );
  const [errors, setErrors] = useState<{ to?: string; subject?: string }>({});
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const next = {
      ...(mode === "email" && !looksLikeEmail(to) ? { to: t("rechnungen.send.err.to") } : {}),
      ...(subject.trim() === "" ? { subject: t("rechnungen.send.err.subject") } : {}),
    };
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    setFailure("");
    try {
      const result = await service.sendInvoice(inv.id, {
        mode,
        to: to.trim(),
        subject: subject.trim(),
        message,
      });
      onDone(result.delivered, mode);
    } catch (e) {
      setFailure(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={inv.number ? t("rechnungen.send.title", { name }) : t("rechnungen.send.titleDraft")}
      width={600}
      closeLabel={t("rechnungen.dialog.close")}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button data-autofocus onClick={onClose}>
            {t("ui.cancel")}
          </Button>
          <Button icon="eye" onClick={onPreview}>
            {t("rechnungen.send.preview")}
          </Button>
          <Button type="submit" variant="primary" icon="send" disabled={busy}>
            {t("rechnungen.detail.send")}
          </Button>
        </>
      }
    >
      <RadioGroup
        legend={t("rechnungen.send.mode")}
        name="send-mode"
        inline
        value={mode}
        onChange={(v) => setMode(v as "email" | "pdf")}
        options={[
          { value: "email", label: t("rechnungen.send.modeEmail") },
          { value: "pdf", label: t("rechnungen.send.modePdf") },
        ]}
      />
      <TextField
        label={t("rechnungen.send.to")}
        required
        value={to}
        error={errors.to}
        hint={t("rechnungen.send.toHint")}
        onChange={(e) => setTo(e.target.value)}
      />
      <TextField
        label={t("rechnungen.send.subject")}
        required
        value={subject}
        error={errors.subject}
        onChange={(e) => setSubject(e.target.value)}
      />
      <TextArea
        label={t("rechnungen.send.message")}
        rows={7}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />
      <div className="rg-flex">
        <Icon name="attach" />
        <span>
          {t("rechnungen.send.attachment", { name: inv.number ?? t("rechnungen.draftName") })}
        </span>
        <span className="muted">{t("rechnungen.send.attachmentInfo")}</span>
      </div>
      <Message title={t("rechnungen.send.lockTitle")}>{t("rechnungen.send.lockText")}</Message>
      {failure && <Message tone="error">{failure}</Message>}
    </Dialog>
  );
}

const REASONS = ["amount", "recipient", "duplicate", "service", "other"] as const;

/** Stornieren (Design 4.7). */
export function CancelDialog({ data, onClose, onDone }: Common & { onDone: () => void }) {
  const service = useRechnungen();
  const inv = data.invoice;
  const name = invoiceName(inv);
  const [reason, setReason] = useState<string>(REASONS[0]);
  const [remark, setRemark] = useState("");
  const [notify, setNotify] = useState(Boolean(data.email));
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setFailure("");
    try {
      await service.cancelInvoice(inv.id, {
        reason: t(`rechnungen.cancel.reason.${reason}` as "rechnungen.cancel.reason.amount"),
        remark: remark.trim(),
        notify: notify && Boolean(data.email),
      });
      onDone();
    } catch (e) {
      setFailure(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("rechnungen.cancel.title", { name })}
      width={580}
      closeLabel={t("rechnungen.dialog.close")}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button data-autofocus onClick={onClose}>
            {t("ui.cancel")}
          </Button>
          <Button type="submit" variant="danger" icon="ban" disabled={busy}>
            {t("rechnungen.detail.cancel")}
          </Button>
        </>
      }
    >
      <dl className="kv rg-kv rg-kv--88">
        <Kv label={t("rechnungen.cancel.invoice")}>
          {name} · {inv.debtor.name}
        </Kv>
        <Kv label={t("rechnungen.cancel.amount")}>{chf(inv.totals.totalCents, inv.currency)}</Kv>
        <Kv label={t("rechnungen.cancel.status")}>
          {t(data.level > 0 ? "rechnungen.cancel.statusReminded" : "rechnungen.cancel.statusOpen")}
        </Kv>
      </dl>
      <Select
        label={t("rechnungen.cancel.reasonLabel")}
        required
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        options={REASONS.map((r) => ({
          value: r,
          label: t(`rechnungen.cancel.reason.${r}` as "rechnungen.cancel.reason.amount"),
        }))}
      />
      <TextArea
        label={t("rechnungen.cancel.remark")}
        rows={2}
        value={remark}
        hint={t("rechnungen.cancel.remarkHint")}
        onChange={(e) => setRemark(e.target.value)}
      />
      <Message tone="warning" title={t("rechnungen.cancel.noteTitle")}>
        {t("rechnungen.cancel.noteText", { amount: chf(inv.totals.totalCents, inv.currency) })}
      </Message>
      {data.email && (
        <Checkbox
          checked={notify}
          onChange={(e) => setNotify(e.target.checked)}
          label={t("rechnungen.cancel.notify", { email: data.email })}
        />
      )}
      {failure && <Message tone="error">{failure}</Message>}
    </Dialog>
  );
}

/** Gutschreiben (Design 4.8). */
export function CreditDialog({ data, onClose, onDone }: Common & { onDone: () => void }) {
  const service = useRechnungen();
  const inv = data.invoice;
  const name = invoiceName(inv);
  const max = inv.totals.totalCents - inv.creditedCents;
  const [scope, setScope] = useState<"full" | "partial">("partial");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<{ amount?: string; reason?: string }>({});
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);

  const cents = scope === "full" ? max : parseAmount(value);
  const after = inv.openCents - (cents ?? 0);

  const submit = async () => {
    const next = {
      ...(cents === null || cents <= 0 || cents > max
        ? { amount: t("rechnungen.credit.err.amount", { max: chf(max, inv.currency) }) }
        : {}),
      ...(reason.trim() === "" ? { reason: t("rechnungen.credit.err.reason") } : {}),
    };
    setErrors(next);
    if (Object.keys(next).length > 0 || cents === null) return;
    setBusy(true);
    setFailure("");
    try {
      await service.creditInvoice(inv.id, { scope, amountCents: cents, reason: reason.trim() });
      onDone();
    } catch (e) {
      setFailure(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("rechnungen.credit.title", { name })}
      width={580}
      closeLabel={t("rechnungen.dialog.close")}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button data-autofocus onClick={onClose}>
            {t("ui.cancel")}
          </Button>
          <Button type="submit" variant="primary" icon="undo" disabled={busy}>
            {t("rechnungen.detail.credit")}
          </Button>
        </>
      }
    >
      <dl className="kv rg-kv rg-kv--160">
        <Kv label={t("rechnungen.cancel.invoice")}>
          {name} · {inv.debtor.name}
        </Kv>
        <Kv label={t("rechnungen.credit.invoiceAmount")}>
          {chf(inv.totals.totalCents, inv.currency)}
        </Kv>
        <Kv label={t("rechnungen.credit.already")}>{chf(inv.creditedCents, inv.currency)}</Kv>
      </dl>
      <RadioGroup
        legend={t("rechnungen.credit.scope")}
        name="credit-scope"
        inline
        value={scope}
        onChange={(v) => setScope(v as "full" | "partial")}
        options={[
          { value: "full", label: t("rechnungen.credit.scopeFull") },
          { value: "partial", label: t("rechnungen.credit.scopePartial") },
        ]}
      />
      <div className="grid rg-grid2">
        <TextField
          label={t("rechnungen.credit.amountLabel")}
          required
          inputMode="decimal"
          readOnly={scope === "full"}
          value={scope === "full" ? amount(max).replace(/'/g, "") : value}
          error={errors.amount}
          hint={t("rechnungen.credit.amountHint", { max: chf(max, inv.currency) })}
          onChange={(e) => setValue(e.target.value)}
        />
        <TextField
          label={t("rechnungen.credit.number")}
          readOnly
          value=""
          hint={t("rechnungen.credit.numberHint")}
        />
      </div>
      <TextField
        label={t("rechnungen.credit.reason")}
        required
        value={reason}
        error={errors.reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <Message
        title={t("rechnungen.credit.afterTitle", { amount: chf(Math.max(after, 0), inv.currency) })}
      >
        {t("rechnungen.credit.afterText")}
      </Message>
      {failure && <Message tone="error">{failure}</Message>}
    </Dialog>
  );
}
