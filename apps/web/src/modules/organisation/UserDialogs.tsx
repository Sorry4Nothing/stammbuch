import { useEffect, useRef, useState } from "react";
import type { TotpSetup } from "../../auth/auth";
import { QrCode } from "../../auth/QrCode";
import { t } from "../../i18n";
import { Button, Checkbox, Dialog, Message, TextField, useToast } from "../../ui";
import { ApiError, type SettingsUser } from "./model";
import { req } from "./common";
import { useSettings } from "./service";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Dialog 9.9: Benutzer hinzufügen. Die Einladung geht per E-Mail, der Benutzer richtet Passwort und Einmalcode selbst ein. */
export function AddUserDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const service = useSettings();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const found: typeof errors = {};
    if (!name.trim()) found.name = t("settings.error.required");
    if (!email.trim()) found.email = t("settings.error.required");
    else if (!EMAIL.test(email.trim())) found.email = t("auth.forgot.emailFormat");
    setErrors(found);
    if (found.name || found.email) return;
    setBusy(true);
    setFailure(null);
    try {
      await service.addUser(name.trim(), email.trim());
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setErrors({ email: t("settings.users.add.conflict") });
      } else {
        setFailure(
          t(
            e instanceof ApiError && e.code === "LICENCE_READ_ONLY"
              ? "settings.saveFailedLicence"
              : "settings.users.add.failed",
          ),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("settings.users.add.title")}
      width={560}
      top={120}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button type="submit" variant="primary" icon="send" disabled={busy}>
            {t("settings.users.add.submit")}
          </Button>
        </>
      }
    >
      {failure && <Message tone="error">{failure}</Message>}
      <TextField
        label={req(t("settings.users.add.name"))}
        value={name}
        error={errors.name}
        autoComplete="name"
        aria-required="true"
        onChange={(e) => setName(e.target.value)}
      />
      <TextField
        label={req(t("settings.users.add.email"))}
        hint={t("settings.users.add.emailHint")}
        value={email}
        error={errors.email}
        autoComplete="email"
        aria-required="true"
        onChange={(e) => setEmail(e.target.value)}
      />
      <Message tone="warning" title={t("settings.users.add.fullTitle")}>
        {t("settings.users.add.fullText")}
      </Message>
      <Message tone="neutral" title={t("settings.users.add.inviteTitle")}>
        {t("settings.users.add.inviteText")}
      </Message>
    </Dialog>
  );
}

/** Dialog 9.10: Benutzer entfernen. Die Bestätigung verlangt die E-Mail-Adresse des Benutzers. */
export function RemoveUserDialog({
  user,
  showLastLogin,
  onClose,
  onDone,
}: {
  user: SettingsUser;
  showLastLogin: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const service = useSettings();
  const [typed, setTyped] = useState("");
  const [failure, setFailure] = useState(false);
  const [busy, setBusy] = useState(false);
  const matches = typed.trim().toLowerCase() === user.email.toLowerCase();

  const submit = async () => {
    if (!matches) return;
    setBusy(true);
    setFailure(false);
    try {
      await service.removeUser(user.id);
      onDone();
    } catch {
      setFailure(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("settings.users.remove.title", { name: user.name })}
      width={560}
      top={150}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button type="submit" variant="danger" icon="trash" disabled={!matches || busy}>
            {t("settings.users.remove")}
          </Button>
        </>
      }
    >
      {failure && <Message tone="error">{t("settings.users.remove.failed")}</Message>}
      <Message tone="warning" title={t("settings.users.remove.lostTitle", { name: user.name })}>
        {t("settings.users.remove.lostText")}
      </Message>
      <dl className="kv set__kv">
        <dt>{t("settings.users.col.name")}</dt>
        <dd>{user.name}</dd>
        <dt>{t("settings.users.col.email")}</dt>
        <dd>{user.email}</dd>
        {showLastLogin && user.lastLogin && (
          <>
            <dt>{t("settings.users.col.lastLogin")}</dt>
            <dd>{user.lastLogin}</dd>
          </>
        )}
      </dl>
      <TextField
        label={req(t("settings.users.remove.confirm"))}
        hint={t("settings.users.remove.hint", { email: user.email })}
        value={typed}
        autoComplete="off"
        aria-required="true"
        onChange={(e) => setTyped(e.target.value)}
      />
    </Dialog>
  );
}

/** Schlüssel in Vierergruppen mit Bindestrich, wie im Board («DEMO-5Q2K-7XM4-TEST»). */
const grouped = (secret: string) => secret.replace(/(.{4})(?=.)/g, "$1-");

/** Dialog 9.11: Einmalcode (2FA) neu einrichten, mit QR-Code. Der bisherige Code gilt, bis der neue bestätigt ist. */
export function TotpDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const service = useSettings();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState(false);
  const [busy, setBusy] = useState(false);
  // Jeder Aufruf erzeugt einen neuen Schlüssel; nur der zuletzt erzeugte gilt. Darum genau einmal.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    service.beginTotpRenewal().then(setSetup, () => setFailure(true));
  }, [service]);

  const submit = async () => {
    if (!/^\d{6}$/.test(code)) {
      setError(t("auth.code.incompleteText"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (await service.confirmTotpRenewal(code)) onDone();
      else setError(t("auth.code.invalidTitle"));
    } catch {
      setFailure(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("settings.totp.title")}
      width={640}
      top={90}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button type="submit" variant="primary" icon="check" disabled={busy || !setup}>
            {t("settings.totp.submit")}
          </Button>
        </>
      }
    >
      {failure && (
        <Message tone="error" title={t("auth.unavailableTitle")}>
          {t("auth.unavailableText")}
        </Message>
      )}
      <div className="set__totp">
        {setup && (
          <div className="set__qr">
            <QrCode value={setup.otpauthUri} label={t("auth.setup.qr")} />
          </div>
        )}
        <div className="set__stack">
          <div>
            <b>{t("settings.totp.step1")}</b>
            <br />
            <span className="muted">{t("settings.totp.step1Text")}</span>
          </div>
          {setup && <span className="num set__secret">{grouped(setup.secret)}</span>}
          <TextField
            mono
            className="set__code"
            label={req(t("settings.totp.step2"))}
            hint={t("settings.totp.hint")}
            value={code}
            error={error ?? undefined}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            aria-required="true"
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, ""));
              setError(null);
            }}
          />
        </div>
      </div>
      <Message tone="warning" title={t("settings.totp.warnTitle")}>
        {t("settings.totp.warnText")}
      </Message>
    </Dialog>
  );
}

/**
 * Dialog 9.12: Neue Wiederherstellungscodes. Die API verlangt dafür einen frischen Einmalcode:
 * Erst nach der Bestätigung zeigt der Dialog die Codes, genau einmal und nur im Speicher.
 */
export function RecoveryCodesDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const service = useSettings();
  const toast = useToast();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);

  const request = async () => {
    if (!/^\d{6}$/.test(code)) {
      setError(t("auth.code.incompleteText"));
      return;
    }
    setBusy(true);
    setError(null);
    setFailure(false);
    try {
      const fresh = await service.renewRecoveryCodes(code);
      if (fresh) setCodes(fresh);
      else setError(t("auth.code.invalidTitle"));
    } catch {
      setFailure(true);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!codes) return;
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      toast.show({ tone: "ok", title: t("settings.codes.copied") });
    } catch {
      toast.show({ tone: "error", title: t("settings.codes.copyFailed") });
    }
  };

  if (!codes) {
    return (
      <Dialog
        title={t("settings.codes.title")}
        width={560}
        top={80}
        onClose={onClose}
        onSubmit={() => void request()}
        footer={
          <>
            <Button onClick={onClose}>{t("ui.cancel")}</Button>
            <Button type="submit" variant="primary" icon="refresh" disabled={busy}>
              {t("settings.codes.generate")}
            </Button>
          </>
        }
      >
        {failure && (
          <Message tone="error" title={t("auth.unavailableTitle")}>
            {t("auth.unavailableText")}
          </Message>
        )}
        <Message tone="warning" title={t("settings.codes.askTitle")}>
          {t("settings.codes.askText")}
        </Message>
        <TextField
          mono
          className="set__code"
          label={req(t("settings.totp.step2"))}
          hint={t("settings.totp.hint")}
          value={code}
          error={error ?? undefined}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          aria-required="true"
          onChange={(e) => {
            setCode(e.target.value.replace(/\D/g, ""));
            setError(null);
          }}
        />
      </Dialog>
    );
  }

  return (
    <Dialog
      title={t("settings.codes.title")}
      width={560}
      top={80}
      onClose={onClose}
      className="set__codes"
      footer={
        <Button variant="primary" icon="check" disabled={!saved} onClick={onDone}>
          {t("settings.codes.confirm")}
        </Button>
      }
    >
      <Message tone="warning" title={t("settings.codes.onceTitle")}>
        {t("settings.codes.onceText")}
      </Message>
      <ol className="set__codelist" aria-label={t("auth.setup.codesList")}>
        {codes.map((c, i) => (
          <li key={c} className="num">
            <span className="set__codeno">{i + 1}.</span>
            {c}
          </li>
        ))}
      </ol>
      <div className="set__row">
        <Button icon="copy" onClick={() => void copy()}>
          {t("settings.codes.copy")}
        </Button>
        <Button icon="print" onClick={() => window.print()}>
          {t("settings.codes.print")}
        </Button>
      </div>
      <Checkbox
        label={t("auth.setup.codesSaved")}
        checked={saved}
        onChange={(e) => setSaved(e.target.checked)}
      />
    </Dialog>
  );
}

/** Passwort ändern. Dieser Dialog steht nicht im Design; er nutzt dessen Felder und die Texte der Anmeldeseiten. */
export function PasswordDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const service = useSettings();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [errors, setErrors] = useState<{ current?: string; next?: string; repeat?: string }>({});
  const [failure, setFailure] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const found: typeof errors = {};
    if (!current) found.current = t("settings.error.required");
    if (next.length < 12) found.next = t("auth.reset.tooShort");
    if (next !== repeat) found.repeat = t("auth.reset.mismatch");
    setErrors(found);
    if (found.current || found.next || found.repeat) return;
    setBusy(true);
    setFailure(false);
    try {
      const result = await service.changePassword(current, next);
      if (result === "ok") onDone();
      else if (result === "wrong") setErrors({ current: t("settings.password.wrong") });
      else setErrors({ next: t("auth.reset.tooShort") });
    } catch {
      setFailure(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("settings.password.title")}
      width={560}
      top={120}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button type="submit" variant="primary" icon="lock" disabled={busy}>
            {t("settings.password.submit")}
          </Button>
        </>
      }
    >
      {failure && (
        <Message tone="error" title={t("auth.unavailableTitle")}>
          {t("auth.unavailableText")}
        </Message>
      )}
      <TextField
        type="password"
        label={req(t("settings.password.current"))}
        value={current}
        error={errors.current}
        autoComplete="current-password"
        aria-required="true"
        onChange={(e) => setCurrent(e.target.value)}
      />
      <TextField
        type="password"
        label={req(t("auth.reset.password"))}
        hint={t("auth.reset.passwordHint")}
        value={next}
        error={errors.next}
        autoComplete="new-password"
        aria-required="true"
        onChange={(e) => setNext(e.target.value)}
      />
      <TextField
        type="password"
        label={req(t("auth.reset.repeat"))}
        value={repeat}
        error={errors.repeat}
        autoComplete="new-password"
        aria-required="true"
        onChange={(e) => setRepeat(e.target.value)}
      />
    </Dialog>
  );
}
