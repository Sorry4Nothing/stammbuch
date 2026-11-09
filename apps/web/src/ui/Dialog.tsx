import {
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import { Button } from "./Button";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Offene Dialoge, der oberste bekommt Esc. */
const stack: symbol[] = [];

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Schaltflächen unten rechts. Die Hauptaktion steht ganz rechts. */
  footer?: ReactNode;
  /** Breite in px (Design: 520 bis 820). */
  width?: number;
  /** Wenn gesetzt, ist der Dialog ein Formular: Enter löst die Hauptaktion aus. */
  onSubmit?: () => void;
  /** Dialog ohne eigene Kopfzeile h2 (z. B. Suche, die ein eigenes Label hat). */
  label?: string;
  className?: string;
  /** Inhalt ohne Innenabstand, z. B. Suche mit eigener Aufteilung. */
  flush?: boolean;
  /** Abstand zum oberen Rand in px (Design: 90 bis 190). Ohne Angabe 10 % der Fensterhöhe. */
  top?: number;
  /** Beschriftung der Schliessen-Schaltfläche oben rechts (Standard «Dialog schliessen»). */
  closeLabel?: string;
  /** Ohne Schliessen-Schaltfläche, z. B. «Sitzung abgelaufen»: der Dialog lässt sich nur durch eine Anmeldung verlassen. */
  hideClose?: boolean;
}

/**
 * Modaler Dialog (Design-Guide 11.5, 11.8): Fokus bleibt im Dialog und kehrt danach
 * zur auslösenden Schaltfläche zurück, Esc schliesst, der Rest der Seite ist inaktiv.
 */
export function Dialog({
  title,
  label,
  onClose,
  children,
  footer,
  width = 520,
  onSubmit,
  className,
  flush,
  top,
  closeLabel,
  hideClose,
}: DialogProps) {
  const titleId = useId();
  const layer = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const token = Symbol("dialog");
    stack.push(token);
    const previous = document.activeElement as HTMLElement | null;

    // Hintergrund inaktiv schalten (Tastatur und Screenreader).
    const inerted: Element[] = [];
    for (const el of Array.from(document.body.children)) {
      if (el === layer.current || el.hasAttribute("data-keep-active") || el.hasAttribute("inert")) {
        continue;
      }
      el.setAttribute("inert", "");
      inerted.push(el);
    }

    // Start im Inhalt, nicht bei der Schliessen-Schaltfläche.
    const target =
      box.current?.querySelector<HTMLElement>("[data-autofocus]") ??
      Array.from(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).find(
        (el) => !el.classList.contains("dlg__close"),
      );
    (target ?? box.current)?.focus();

    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && stack[stack.length - 1] === token) {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      }
    };
    document.addEventListener("keydown", onKey, true);

    return () => {
      document.removeEventListener("keydown", onKey, true);
      stack.splice(stack.indexOf(token), 1);
      inerted.forEach((el) => el.removeAttribute("inert"));
      previous?.focus?.();
    };
  }, []);

  // Tab-Falle: der Fokus verlässt den Dialog nie.
  const trap = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !box.current) return;
    const items = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (
      e.shiftKey &&
      (document.activeElement === first || document.activeElement === box.current)
    ) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit?.();
  };

  const inner = (
    <>
      <div className={flush ? "dlg__body dlg__body--flush" : "dlg__body"}>{children}</div>
      {footer && <div className="dlg__foot">{footer}</div>}
    </>
  );

  return createPortal(
    <div ref={layer} className="dialog-layer">
      <div className="scrim" aria-hidden="true" />
      <div
        ref={box}
        className={["dlg", flush && "dlg--flush", className].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={label ? undefined : titleId}
        aria-label={label}
        tabIndex={-1}
        style={
          {
            "--dlg-width": `${width}px`,
            ...(top !== undefined && { "--dlg-top": `${top}px` }),
          } as CSSProperties
        }
        onKeyDown={trap}
      >
        {!label && <h2 id={titleId}>{title}</h2>}
        {!hideClose && (
          <Button
            variant="ghost"
            icon="close"
            className="dlg__close"
            aria-label={closeLabel ?? t("ui.dialog.close")}
            onClick={onClose}
          />
        )}
        {onSubmit ? (
          <form onSubmit={submit} noValidate className="dlg__form">
            {inner}
          </form>
        ) : (
          inner
        )}
      </div>
    </div>,
    document.body,
  );
}
