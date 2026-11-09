import { useId, useState } from "react";
import { t } from "../../i18n";
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  Message,
  OtpInput,
  TextField,
  useToast,
} from "../../ui";
import { useChefAdminService } from "./context";
import { formatDate, parseDate } from "./format";
import { ApiError, CodeRejectedError, RESET_REASON_MIN } from "./model";
import type { Customer, CustomerAction, CustomerUser } from "./model";
import { req } from "./shared";

interface CustomerDialogProps {
  customer: Customer;
  onClose: () => void;
  /** Der Kunde nach der Änderung. */
  onChanged: (customer: Customer) => void;
}

/**
 * 2FA eines Benutzers zurücksetzen (Design 10.4). Grund und Rückruf kommen ins Anbieter-Protokoll. Die API verlangt
 * als Step-up einen frischen Einmalcode des Chef-Admins; ohne ihn lässt sich der zweite Faktor nicht zurücksetzen.
 */
export function ResetTwoFactorDialog({
  customer,
  user,
  onClose,
  onDone,
}: {
  customer: Customer;
  user: CustomerUser;
  onClose: () => void;
  /** Nach dem erfolgreichen Zurücksetzen (der Dialog schliesst sich nicht selbst). */
  onDone: () => void;
}) {
  const service = useChefAdminService();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [calledBack, setCalledBack] = useState(false);
  const [code, setCode] = useState("");
  const [errors, setErrors] = useState<{ reason?: string; calledBack?: string; code?: string }>({});
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const text = reason.trim();
    const next = {
      ...(text.length >= RESET_REASON_MIN
        ? {}
        : { reason: t("chef.reset.err.reason", { min: RESET_REASON_MIN }) }),
      ...(calledBack ? {} : { calledBack: t("chef.reset.err.calledBack") }),
      ...(code.length === 6 ? {} : { code: t("chef.reset.err.code") }),
    };
    setErrors(next);
    setFailed(null);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    try {
      await service.resetTwoFactor(customer.id, user.id, { reason: text, calledBack, code });
      toast.show({ tone: "ok", title: t("chef.reset.done", { name: user.name }) });
      onDone();
    } catch (error) {
      if (error instanceof CodeRejectedError) setErrors({ code: t("chef.reset.err.codeInvalid") });
      else if (error instanceof ApiError && error.status === 429) setFailed(t("chef.reset.locked"));
      else if (error instanceof ApiError && error.status === 400)
        setFailed(t("chef.reset.invalid"));
      else setFailed(t("chef.reset.failed"));
      setCode("");
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("chef.reset.title", { name: user.name })}
      width={580}
      top={150}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button data-autofocus onClick={onClose}>
            {t("ui.cancel")}
          </Button>
          <Button type="submit" variant="danger" icon="key" disabled={busy}>
            {t("chef.reset.submit")}
          </Button>
        </>
      }
    >
      {failed && <Message tone="error">{failed}</Message>}
      <Message tone="warning" title={t("chef.reset.warnTitle")}>
        {t("chef.reset.warnText", { name: user.name })}
      </Message>
      <TextField label={t("chef.reset.user")} readOnly value={`${user.name} (${user.email})`} />
      <TextField
        label={req(t("chef.reset.reason"))}
        aria-required="true"
        autoComplete="off"
        maxLength={200}
        value={reason}
        error={errors.reason}
        hint={errors.reason ? undefined : t("chef.reset.reasonHint")}
        onChange={(e) => {
          setReason(e.target.value);
          setErrors((x) => ({ ...x, reason: undefined }));
        }}
      />
      <div className="ca-stack ca-stack--tight">
        <Checkbox
          label={t("chef.reset.calledBack")}
          checked={calledBack}
          aria-invalid={errors.calledBack ? true : undefined}
          onChange={(e) => {
            setCalledBack(e.target.checked);
            setErrors((x) => ({ ...x, calledBack: undefined }));
          }}
        />
        {errors.calledBack && <span className="ca-fielderror">{errors.calledBack}</span>}
      </div>
      <OtpInput
        label={t("chef.reset.code")}
        value={code}
        hint={t("chef.reset.codeHint")}
        {...(errors.code ? { error: errors.code } : {})}
        onChange={(value) => {
          setCode(value);
          setErrors((x) => ({ ...x, code: undefined }));
        }}
      />
    </Dialog>
  );
}

/** Kunde sperren oder Vertrag beenden (Design 10.5). Bestätigt wird mit der Kunden-ID. */
export function SuspendDialog({ customer, onClose, onChanged }: CustomerDialogProps) {
  const service = useChefAdminService();
  const toast = useToast();
  const [action, setAction] = useState<"suspend" | "end-contract">("suspend");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const group = useId();

  const submit = async () => {
    if (typed.trim() !== customer.ref) {
      setError(t("chef.suspend.err.confirm"));
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      const updated = await service.changeStatus(customer.id, action);
      toast.show({
        tone: "ok",
        title: t(action === "suspend" ? "chef.suspend.suspended" : "chef.suspend.ended", {
          name: customer.name,
        }),
      });
      onChanged(updated);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  const choice = (value: "suspend" | "end-contract", title: string, text: string) => (
    <label className="ca-choice">
      <input
        type="radio"
        className="chk-input"
        name={group}
        checked={action === value}
        onChange={() => setAction(value)}
      />
      <span className="rad" aria-hidden="true" />
      <span>
        <b>{title}</b>
        <div className="muted">{text}</div>
      </span>
    </label>
  );

  return (
    <Dialog
      title={t("chef.suspend.title", { name: customer.name })}
      width={580}
      top={140}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button type="submit" variant="danger" icon="ban" disabled={busy}>
            {t(action === "suspend" ? "chef.suspend.suspend" : "chef.suspend.end")}
          </Button>
        </>
      }
    >
      {failed && <Message tone="error">{t("chef.suspend.failed")}</Message>}
      <fieldset className="ca-fieldset ca-stack">
        <legend className="visually-hidden">{t("chef.suspend.legend")}</legend>
        {choice(
          "suspend",
          t("chef.suspend.suspend"),
          t("chef.suspend.suspendText", { name: customer.name }),
        )}
        {choice(
          "end-contract",
          t("chef.suspend.end"),
          t("chef.suspend.endText", { date: formatDate(customer.licenceUntil) }),
        )}
      </fieldset>
      <Message tone="warning" title={t("chef.suspend.warnTitle")} />
      <div className="ca-confirm">
        <TextField
          label={req(t("chef.suspend.confirm"))}
          aria-required="true"
          mono
          data-autofocus
          autoComplete="off"
          value={typed}
          error={error}
          hint={error ? undefined : t("chef.suspend.confirmHint", { ref: customer.ref })}
          onChange={(e) => {
            setTyped(e.target.value);
            setError(undefined);
          }}
        />
      </div>
    </Dialog>
  );
}

/** Sperre aufheben. Die Oberfläche kennt dafür kein eigenes Board; die API bietet `reactivate`. */
export function ReactivateDialog({ customer, onClose, onChanged }: CustomerDialogProps) {
  const service = useChefAdminService();
  const toast = useToast();
  const [failed, setFailed] = useState(false);

  return (
    <ConfirmDialog
      title={t("chef.reactivate.title", { name: customer.name })}
      confirmLabel={t("chef.detail.reactivate")}
      onCancel={onClose}
      onConfirm={() => {
        setFailed(false);
        const action: CustomerAction = "reactivate";
        service.changeStatus(customer.id, action).then(
          (updated) => {
            toast.show({ tone: "ok", title: t("chef.reactivate.done", { name: customer.name }) });
            onChanged(updated);
          },
          () => setFailed(true),
        );
      }}
    >
      {failed && <Message tone="error">{t("chef.suspend.failed")}</Message>}
      {t("chef.reactivate.text", { name: customer.name })}
    </ConfirmDialog>
  );
}

/** Lizenz verlängern: neues Enddatum. Auch dafür gibt es kein Board; Aufbau wie die anderen Dialoge. */
export function ExtendDialog({ customer, onClose, onChanged }: CustomerDialogProps) {
  const service = useChefAdminService();
  const toast = useToast();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const until = parseDate(text);
    if (!until) {
      setError(t("chef.create.err.date"));
      return;
    }
    if (until <= customer.licenceUntil) {
      setError(t("chef.extend.err.range"));
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      const updated = await service.extendLicence(customer.id, until);
      toast.show({
        tone: "ok",
        title: t("chef.extend.done", { name: customer.name, date: formatDate(until) }),
      });
      onChanged(updated);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("chef.extend.title", { name: customer.name })}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button type="submit" variant="primary" icon="refresh" disabled={busy}>
            {t("chef.detail.extend")}
          </Button>
        </>
      }
    >
      {failed && <Message tone="error">{t("chef.extend.failed")}</Message>}
      <TextField
        label={req(t("chef.extend.label"))}
        aria-required="true"
        inputMode="numeric"
        data-autofocus
        value={text}
        error={error}
        placeholder={t("chef.create.datePlaceholder")}
        hint={t("chef.extend.current", { date: formatDate(customer.licenceUntil) })}
        onChange={(e) => {
          setText(e.target.value);
          setError(undefined);
        }}
      />
    </Dialog>
  );
}
