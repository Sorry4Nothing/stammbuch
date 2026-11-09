import { useState } from "react";
import { t } from "../../i18n";
import { Button, Dialog, Message, OtpInput } from "../../ui";
import { ROTATION_KINDS, type RotationKind } from "./rotationModel";

/**
 * Bestätigung der Rotation (Design 10.9). Die Rotation betrifft alle Kunden; deshalb verlangt die API einen frischen
 * Einmalcode des Chef-Admins (Step-up). `error` ist die Meldung zum letzten Versuch (Code abgelehnt, gesperrt).
 */
export function RotationDialog({
  kinds,
  error,
  onClose,
  onSubmit,
}: {
  /** Arten, die der Lauf sichert (nur eingerichtete). */
  kinds: readonly RotationKind[];
  error?: string;
  onClose: () => void;
  onSubmit: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | undefined>();

  const names = ROTATION_KINDS.filter((k) => kinds.includes(k)).map((k) =>
    t(k === "mail" ? "chef.rot.kind.mail" : "chef.rot.kind.totp"),
  );
  const [first = "", second = ""] = names;

  const submit = () => {
    if (code.length !== 6) {
      setCodeError(t("chef.reset.err.code"));
      return;
    }
    onSubmit(code);
  };

  return (
    <Dialog
      title={t("chef.rot.dlg.title")}
      width={580}
      top={72}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button data-autofocus onClick={onClose}>
            {t("ui.cancel")}
          </Button>
          <Button type="submit" variant="primary" icon="refresh">
            {t("chef.rot.start")}
          </Button>
        </>
      }
    >
      {error && <Message tone="error">{error}</Message>}
      <span>
        {t("chef.rot.dlg.intro", {
          kinds: second ? t("chef.rot.dlg.kinds", { a: first, b: second }) : first,
        })}
      </span>
      <ul className="rot-list rot-list--tight">
        <li>{t("chef.rot.dlg.l1")}</li>
        <li>{t("chef.rot.dlg.l2")}</li>
      </ul>
      <Message tone="warning" title={t("chef.rot.dlg.warn.title")}>
        {t("chef.rot.dlg.warn.text")}
      </Message>
      <OtpInput
        label={t("chef.rot.dlg.code")}
        hint={t("chef.rot.dlg.codeHint")}
        required
        value={code}
        {...(codeError ? { error: codeError } : {})}
        onChange={(value) => {
          setCode(value);
          setCodeError(undefined);
        }}
      />
    </Dialog>
  );
}
