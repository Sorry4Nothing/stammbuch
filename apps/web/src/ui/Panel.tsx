import { useId, type ReactNode } from "react";

interface PanelProps {
  title: string;
  /** Aktionen rechts in der Kopfzeile. */
  actions?: ReactNode;
  children: ReactNode;
  /** Ohne Innenabstand, z. B. für Tabellen. */
  flush?: boolean;
  /** Ohne Karte: nur Überschrift und Inhalt, für reine Aktions- und Navigationsblöcke. */
  plain?: boolean;
}

export function Panel({ title, actions, children, flush, plain }: PanelProps) {
  const id = useId();
  return (
    <section className={plain ? "panel panel--plain" : "panel"} aria-labelledby={id}>
      <h2 id={id}>
        {title}
        {actions && <span className="panel__actions">{actions}</span>}
      </h2>
      <div className={flush ? undefined : "panel__body"}>{children}</div>
    </section>
  );
}

/** Kennzahl (Startseite). */
export function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <section className="panel stat">
      <span className="muted">{label}</span>
      <b>{value}</b>
      {note && <span className="muted">{note}</span>}
    </section>
  );
}
