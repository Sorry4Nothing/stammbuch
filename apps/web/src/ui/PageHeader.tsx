import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  /** Badge o. Ä. direkt neben dem Titel. */
  status?: ReactNode;
  /** Schaltflächen rechts. Die Hauptaktion steht ganz rechts. */
  actions?: ReactNode;
  /** Brotkrumen oder Datumszeile über dem Titel. */
  crumb?: ReactNode;
}

export function PageHeader({ title, status, actions, crumb }: PageHeaderProps) {
  return (
    <>
      {crumb && <div className="crumb">{crumb}</div>}
      <div className="phead">
        <h1>{title}</h1>
        {status}
        <span className="phead__spacer" />
        {actions}
      </div>
    </>
  );
}
