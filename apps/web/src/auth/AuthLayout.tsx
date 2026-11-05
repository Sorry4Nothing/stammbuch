import { useEffect, useRef, type ReactNode } from "react";
import { orgName } from "../config";
import { t } from "../i18n";

const pad = (n: number) => String(n).padStart(2, "0");

/** «14:30» */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** «14:30 · 02.11.2026» */
export function formatStamp(ms: number): string {
  const d = new Date(ms);
  return `${formatClock(ms)} · ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

interface AuthLayoutProps {
  title: string;
  /** Zeile unter dem Titel, z. B. Organisation. */
  subtitle?: string;
  children: ReactNode;
  /** Hinweis unter der Karte. */
  note?: string;
  /** Fokus auf den Titel statt auf das erste Feld (Seiten ohne Eingabe). */
  focusTitle?: boolean;
}

/** Rahmen der Zugangsseiten (Design 1.1 bis 1.6): Marke, Karte 440 px, Fusszeile. */
export function AuthLayout({ title, subtitle, children, note, focusTitle }: AuthLayoutProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusTitle) heading.current?.focus();
  }, [focusTitle]);

  return (
    <main className="auth">
      <div className="auth__brand">
        <div className="mark" aria-hidden="true">
          S
        </div>
        <span className="auth__name">{t("app.title")}</span>
      </div>
      <div className="card">
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
        {subtitle && <span className="muted">{subtitle}</span>}
        {children}
      </div>
      {note && <span className="muted auth__note">{note}</span>}
      <div className="auth__foot muted">
        <span>{t("auth.footer.imprint")}</span>
        <span>{t("auth.footer.privacy")}</span>
        <span>{[orgName, window.location.hostname].filter(Boolean).join(" · ")}</span>
      </div>
    </main>
  );
}
