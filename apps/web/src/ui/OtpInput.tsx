import { useId, useRef, type ClipboardEvent, type KeyboardEvent } from "react";
import { t } from "../i18n";

interface OtpInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  length?: number;
  invalid?: boolean;
  autoFocus?: boolean;
  /** Wird beim Eingeben der letzten Ziffer aufgerufen. */
  onComplete?: (value: string) => void;
}

/**
 * Einmalcode als einzelne Ziffernfelder (Design 1.2, 1.5).
 * Eingabe springt weiter, Rücktaste zurück, Einfügen verteilt die Ziffern.
 */
export function OtpInput({
  label,
  value,
  onChange,
  length = 6,
  invalid,
  autoFocus,
  onComplete,
}: OtpInputProps) {
  const labelId = useId();
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length }, (_, i) => value[i] ?? "");

  const focusAt = (i: number) => refs.current[Math.max(0, Math.min(length - 1, i))]?.focus();

  const commit = (next: string) => {
    const clean = next.replace(/\D/g, "").slice(0, length);
    onChange(clean);
    if (clean.length === length) onComplete?.(clean);
  };

  const onInput = (i: number, raw: string) => {
    const typed = raw.replace(/\D/g, "");
    if (!typed) return;
    const chars = digits.slice();
    // Mehrere Zeichen (Autofill) ab der aktuellen Stelle verteilen.
    typed
      .slice(0, length - i)
      .split("")
      .forEach((c, k) => (chars[i + k] = c));
    commit(chars.join(""));
    focusAt(i + typed.length);
  };

  const onKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      const chars = digits.slice();
      if (chars[i]) {
        chars[i] = "";
        commit(chars.join(""));
      } else if (i > 0) {
        chars[i - 1] = "";
        commit(chars.join(""));
        focusAt(i - 1);
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusAt(i - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      focusAt(i + 1);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, length);
    if (!text) return;
    commit(text);
    focusAt(text.length);
  };

  return (
    <div className="otp">
      <span className="otp__label" id={labelId}>
        {label}
      </span>
      <div role="group" aria-labelledby={labelId} className="otp__row">
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            className={["in", "mono", "otp__digit", invalid && "in--err"].filter(Boolean).join(" ")}
            type="text"
            inputMode="numeric"
            autoComplete={i === 0 ? "one-time-code" : "off"}
            autoFocus={autoFocus && i === 0}
            aria-label={t("ui.otp.digit", { n: i + 1, total: length })}
            aria-invalid={invalid ? true : undefined}
            value={d}
            onChange={(e) => onInput(i, e.target.value)}
            onKeyDown={(e) => onKeyDown(i, e)}
            onPaste={onPaste}
            onFocus={(e) => e.target.select()}
          />
        ))}
      </div>
    </div>
  );
}
