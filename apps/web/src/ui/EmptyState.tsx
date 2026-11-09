import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  text?: string;
  /** Schaltflächen unter dem Text. */
  actions?: ReactNode;
}

/** Leerer Zustand einer Liste: Titel, ein Satz, eine Aktion; linksbündig unter dem Tabellenkopf. */
export function EmptyState({ title, text, actions }: EmptyStateProps) {
  return (
    <div className="empty">
      <h2 className="empty__title">{title}</h2>
      {text && <span className="muted empty__text">{text}</span>}
      {actions && <div className="empty__actions">{actions}</div>}
    </div>
  );
}
