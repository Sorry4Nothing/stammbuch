import { useState } from "react";
import type { TotpSetup } from "../../auth/auth";
import { useAuth } from "../../auth/auth";
import { QrCode } from "../../auth/QrCode";
import { t } from "../../i18n";
import { Button, Checkbox, Dialog, Message, OtpInput, TextField, useToast } from "../../ui";
import { req } from "./shared";

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
        label={req(t("chef.password.current"))}
        type="password"
        aria-required="true"
        data-autofocus
        autoComplete="current-password"
        value={current}
        error={errors.current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <TextField
        label={req(t("auth.reset.password"))}
        type="password"
        aria-required="true"
        autoComplete="new-password"
        value={next}
        error={errors.next}
        hint={errors.next ? undefined : t("auth.reset.passwordHint")}
        onChange={(e) => setNext(e.target.value)}
      />
      <TextField
        label={req(t("auth.reset.repeat"))}
        type="password"
        aria-required="true"
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

/** Schlüssel in Vierergruppen mit Bindestrich. */
const grouped = (secret: string) => secret.replace(/(.{4})(?=.)/g, "$1-");

/**
 * Einmalcode (2FA) neu einrichten (`POST /auth/2fa/renew`, dann `/renew/confirm`): erst der bisherige Einmalcode,
 * dann der neue Schlüssel mit QR-Code und dessen erster Code. Der bisherige gilt, bis der neue bestätigt ist.
 */
export function TotpDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { service } = useAuth();
  const toast = useToast();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState("");
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (code.length !== 6) {
      setAlert(t("auth.code.incompleteText"));
      return;
    }
    setBusy(true);
    setAlert(null);
    try {
      if (!service.beginTotpRenewal || !service.confirmTotpRenewal)
        throw new Error("nicht unterstützt");
      if (setup) {
        const result = await service.confirmTotpRenewal(code);
        if (result.status === "ok") {
          toast.show({ tone: "ok", title: t("settings.totp.done") });
          onDone();
          return;
        }
        setAlert(t(result.status === "locked" ? "chef.codes.locked" : "chef.codes.invalid"));
      } else {
        const result = await service.beginTotpRenewal(code);
        if (result.status === "ok") setSetup(result);
        else setAlert(t(result.status === "locked" ? "chef.codes.locked" : "chef.codes.invalid"));
      }
      setCode("");
    } catch {
      setAlert(t("auth.unavailableText"));
    }
    setBusy(false);
  };

  return (
    <Dialog
      title={t("settings.totp.title")}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button type="submit" variant="primary" icon="check" disabled={busy}>
            {setup ? t("settings.totp.submit") : t("settings.totp.next")}
          </Button>
        </>
      }
    >
      {alert && <Message tone="error">{alert}</Message>}
      {setup ? (
        <>
          <div className="ca-totp">
            <div className="ca-totp__qr">
              <QrCode value={setup.otpauthUri} label={t("auth.setup.qr")} />
            </div>
            <div className="ca-stack">
              <div>
                <b>{t("settings.totp.step1")}</b>
                <br />
                <span className="muted">{t("settings.totp.step1Text")}</span>
              </div>
              <span className="num ca-totp__secret">{grouped(setup.secret)}</span>
            </div>
          </div>
          <OtpInput
            key="confirm"
            label={t("settings.totp.step2")}
            value={code}
            autoFocus
            invalid={!!alert}
            onChange={setCode}
          />
          <Message tone="warning" title={t("settings.totp.warnTitle")}>
            {t("settings.totp.warnText")}
          </Message>
        </>
      ) : (
        <>
          <Message tone="warning" title={t("settings.totp.askTitle")}>
            {t("settings.totp.askText")}
          </Message>
          <OtpInput
            key="current"
            label={t("settings.totp.current")}
            value={code}
            autoFocus
            invalid={!!alert}
            onChange={setCode}
          />
        </>
      )}
    </Dialog>
  );
}
