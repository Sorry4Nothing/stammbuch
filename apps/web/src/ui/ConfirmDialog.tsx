import type { ReactNode } from "react";
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
  onConfirm: () => void;
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
          <Button variant={danger ? "danger" : "primary"} icon={confirmIcon} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
