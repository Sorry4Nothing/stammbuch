import type { ReactNode } from "react";
import type { Tone } from "./Badge";
import { Icon, type IconName } from "./Icon";

const icons: Record<Tone, IconName> = {
  ok: "check",
  warning: "warning",
  error: "warning",
  neutral: "info",
};

interface MessageProps {
  tone?: Tone;
  /** Fetter Einstieg, z. B. «Gespeichert.» */
  title?: string;
  children?: ReactNode;
  className?: string;
  /** Eigenes Symbol statt dem des Tons (z. B. Uhr bei «Automatische Löschung»). */
  icon?: IconName;
}

/** Meldung: Fehler als role="alert", alles andere als role="status" (Design-Guide 11.8). */
export function Message({ tone = "neutral", title, children, className, icon }: MessageProps) {
  return (
    <div
      className={["msg", `msg--${tone}`, className].filter(Boolean).join(" ")}
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon name={icon ?? icons[tone]} size={18} />
      <div>
        {title && <b>{title}</b>}
        {title && children ? " " : null}
        {children}
      </div>
    </div>
  );
}
