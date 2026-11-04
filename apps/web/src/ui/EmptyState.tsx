import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

interface EmptyStateProps {
  icon: IconName;
  title: string;
  text?: string;
  /** Schaltflächen unter dem Text. */
  actions?: ReactNode;
  /** Kleiner Tipp, z. B. mit Tastaturkürzel. */
  tip?: ReactNode;
}

/** Leerer Zustand einer Liste (Design 2.5). */
export function EmptyState({ icon, title, text, actions, tip }: EmptyStateProps) {
  return (
    <div className="empty">
      <Icon name={icon} size={32} />
      <b className="empty__title">{title}</b>
      {text && <span className="muted empty__text">{text}</span>}
      {actions && <div className="empty__actions">{actions}</div>}
      {tip && <span className="muted">{tip}</span>}
    </div>
  );
}
