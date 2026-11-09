import { useState, type ReactNode } from "react";
import { t } from "../i18n";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import type { IconName } from "./Icon";

interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  confirmIcon?: IconName;
  /** Gefährliche Aktion (Löschen, Sperren, Auflösen): rote Schaltfläche. */
  danger?: boolean;
  /** Gibt `onConfirm` ein Promise zurück, ist die Bestätigung bis zu dessen Ende gesperrt (Doppelklick). */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  /** Weitere Schaltfläche zwischen Abbrechen und Bestätigen, z. B. «Verwerfen und schliessen». */
  extra?: ReactNode;
  width?: number;
  top?: number;
}

/** Bestätigungsdialog. Der Fokus beginnt bei «Abbrechen», damit Enter nichts Zerstörerisches auslöst. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  confirmIcon,
  danger,
  onConfirm,
  onCancel,
  extra,
  width,
  top,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const confirm = () => {
    if (busy) return;
    const result = onConfirm();
    if (result instanceof Promise) {
      setBusy(true);
      const release = () => setBusy(false);
      result.then(release, release);
    }
  };
  return (
    <Dialog
      title={title}
      width={width}
      top={top}
      onClose={onCancel}
      footer={
        <>
          <Button data-autofocus onClick={onCancel}>
            {t("ui.cancel")}
          </Button>
          {extra}
          <Button
            variant={danger ? "danger" : "primary"}
            icon={confirmIcon}
            disabled={busy}
            onClick={confirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
