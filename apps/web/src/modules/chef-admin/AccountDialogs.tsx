import { useState } from "react";
import { useAuth } from "../../auth/auth";
import { t } from "../../i18n";
import { Button, Checkbox, Dialog, Message, OtpInput, TextField, useToast } from "../../ui";

const MIN_LENGTH = 12;

/** Eigenes Passwort ändern (`POST /auth/password`). Die API beendet dabei die anderen Sitzungen. */
export function PasswordDialog({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const { service } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [errors, setErrors] = useState<{ current?: string; next?: string; repeat?: string }>({});
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const found: typeof errors = {};
    if (!current) found.current = t("chef.password.currentRequired");
    if (!next) found.next = t("auth.reset.passwordRequired");
    else if ([...next].length < MIN_LENGTH) found.next = t("auth.reset.tooShort");
    if (!found.next && repeat !== next) found.repeat = t("auth.reset.mismatch");
    setErrors(found);
    setAlert(null);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const result = await (service.changePassword?.(current, next) ??
        Promise.reject(new Error("nicht unterstützt")));
      if (result.status === "ok") {
        toast.show({ tone: "ok", title: t("chef.password.done") });
        onChanged();
        return;
      }
      if (result.status === "invalid") setErrors({ current: t("chef.password.invalid") });
      else if (result.status === "weak") setErrors({ next: result.message });
      else setAlert(t("auth.reset.lockedText"));
    } catch {
      setAlert(t("chef.password.failed"));
    }
    setBusy(false);
  };

  return (
    <Dialog
      title={t("chef.password.title")}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button type="submit" variant="primary" icon="key" disabled={busy}>
            {t("chef.password.title")}
          </Button>
        </>
      }
    >
      {alert && <Message tone="error">{alert}</Message>}
      <TextField
        label={t("chef.password.current")}
        type="password"
        required
        data-autofocus
        autoComplete="current-password"
        value={current}
        error={errors.current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <TextField
        label={t("auth.reset.password")}
        type="password"
        required
        autoComplete="new-password"
        value={next}
        error={errors.next}
        hint={errors.next ? undefined : t("auth.reset.passwordHint")}
        onChange={(e) => setNext(e.target.value)}
      />
      <TextField
        label={t("auth.reset.repeat")}
        type="password"
        required
        autoComplete="new-password"
        value={repeat}
        error={errors.repeat}
        onChange={(e) => setRepeat(e.target.value)}
      />
    </Dialog>
  );
}

/** Neue Wiederherstellungscodes (`POST /auth/recovery-codes/renew`): erst Einmalcode, dann die Codes einmalig anzeigen. */
export function RecoveryCodesDialog({
  onClose,
  onRenewed,
}: {
  onClose: () => void;
  onRenewed: () => void;
}) {
  const { service } = useAuth();
  const [code, setCode] = useState("");
  const [alert, setAlert] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (code.length !== 6) {
      setAlert(t("auth.code.incompleteText"));
      return;
    }
    setBusy(true);
    setAlert(null);
    try {
      const result = await (service.renewRecoveryCodes?.(code) ??
        Promise.reject(new Error("nicht unterstützt")));
      if (result.status === "ok") {
        setCodes(result.recoveryCodes);
        onRenewed();
      } else {
        setAlert(t(result.status === "locked" ? "chef.codes.locked" : "chef.codes.invalid"));
        setCode("");
      }
    } catch {
      setAlert(t("chef.codes.failed"));
    }
    setBusy(false);
  };

  if (codes) {
    return (
      <Dialog
        title={t("chef.codes.title")}
        onClose={saved ? onClose : () => undefined}
        hideClose={!saved}
        footer={
          <Button variant="primary" disabled={!saved} onClick={onClose}>
            {t("chef.codes.close")}
          </Button>
        }
      >
        <Message tone="warning" title={t("auth.setup.codesWarnTitle")}>
          {t("auth.setup.codesWarnText")}
        </Message>
        <ul className="auth__codes" aria-label={t("auth.setup.codesList")}>
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <Checkbox
          label={t("auth.setup.codesSaved")}
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
        />
      </Dialog>
    );
  }

  return (
    <Dialog
      title={t("chef.codes.title")}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button type="submit" variant="primary" icon="refresh" disabled={busy}>
            {t("chef.codes.submit")}
          </Button>
        </>
      }
    >
      {alert && <Message tone="error">{alert}</Message>}
      <p>{t("chef.codes.intro")}</p>
      <OtpInput
        label={t("auth.code.label")}
        value={code}
        autoFocus
        invalid={!!alert}
        onChange={setCode}
      />
    </Dialog>
  );
}
