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
  /** Fokus auf den Titel statt auf das erste Feld (Seiten ohne Eingabe). */
  focusTitle?: boolean;
  /** Breite Karte (560 px) für Registrierung und Einladungs-Antwort. */
  wide?: boolean;
}

/** Rahmen der Zugangs- und öffentlichen Seiten (Design 1.1 bis 1.12): Marke, Karte, Fusszeile. */
export function AuthLayout({ title, subtitle, children, focusTitle, wide }: AuthLayoutProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusTitle) heading.current?.focus();
  }, [focusTitle]);

  return (
    <div className="auth">
      <a className="skip" href="#main">
        {t("shell.skip")}
      </a>
      <header className="auth__brand">
        <div className="mark" aria-hidden="true">
          S
        </div>
        <span className="auth__name">{t("app.title")}</span>
      </header>
      <main id="main" className="auth__main" tabIndex={-1}>
        <section className={["card", wide && "card--wide"].filter(Boolean).join(" ")}>
          <div className="auth__head">
            <h1 ref={heading} tabIndex={-1}>
              {title}
            </h1>
            {subtitle && <span className="muted">{subtitle}</span>}
          </div>
          {children}
        </section>
      </main>
      {orgName && (
        <footer className="auth__foot">
          <span>{orgName}</span>
        </footer>
      )}
    </div>
  );
}
