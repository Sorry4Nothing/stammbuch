import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  /** Zusatz neben dem Titel in Grau, z. B. das Datum der Startseite. */
  sub?: ReactNode;
  /** Badge o. Ä. direkt neben dem Titel. */
  status?: ReactNode;
  /** Schaltflächen rechts. Die Hauptaktion steht ganz rechts. */
  actions?: ReactNode;
  /** Brotkrumen über dem Titel. */
  crumb?: ReactNode;
}

export function PageHeader({ title, sub, status, actions, crumb }: PageHeaderProps) {
  return (
    <>
      {crumb && <div className="crumb">{crumb}</div>}
      <div className="phead">
        <h1>{title}</h1>
        {sub && <span className="muted">{sub}</span>}
        {status}
        <span className="phead__spacer" />
        {actions}
      </div>
    </>
  );
}
