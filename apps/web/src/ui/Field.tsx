import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { Icon } from "./Icon";

interface FieldBase {
  /** Beschriftung; bei `required` folgt ein Stern. */
  label: ReactNode;
  /** Hilfetext unter dem Feld. */
  hint?: string;
  /** Fehlertext unter dem Feld. Setzt Rand 2 px und aria-invalid (Design-Guide 11.3). */
  error?: string;
}

function ids(base: string, hint?: string, error?: string) {
  const hintId = hint ? `${base}-hint` : undefined;
  const errorId = error ? `${base}-error` : undefined;
  return { hintId, errorId, describedBy: [errorId, hintId].filter(Boolean).join(" ") || undefined };
}

function Shell({
  inputId,
  label,
  required,
  hint,
  error,
  children,
}: FieldBase & { inputId: string; required?: boolean; children: ReactNode }) {
  const { hintId, errorId } = ids(inputId, hint, error);
  return (
    <div className="lbl">
      <label htmlFor={inputId}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      {children}
      {error && (
        <span className="lbl__error" id={errorId}>
          <Icon name="warning" size={12} />
          <span>{error}</span>
        </span>
      )}
      {hint && (
        <span className="lbl__hint" id={hintId}>
          {hint}
        </span>
      )}
    </div>
  );
}

export interface TextFieldProps
  extends FieldBase, Omit<InputHTMLAttributes<HTMLInputElement>, "children"> {
  /** Schrift mit gleich breiten Zeichen für Codes und Nummern. */
  mono?: boolean;
  ref?: Ref<HTMLInputElement>;
}

/** Einzeiliges Feld mit Label, Hinweis und Fehlertext. */
export function TextField({
  label,
  hint,
  error,
  mono,
  required,
  className,
  id,
  ref,
  ...rest
}: TextFieldProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const { describedBy } = ids(inputId, hint, error);
  return (
    <Shell inputId={inputId} label={label} required={required} hint={hint} error={error}>
      <input
        ref={ref}
        id={inputId}
        className={["in", error && "in--err", rest.readOnly && "in--ro", mono && "mono", className]
          .filter(Boolean)
          .join(" ")}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        required={required}
        {...rest}
      />
    </Shell>
  );
}

export interface TextAreaProps
  extends FieldBase, Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "children"> {
  ref?: Ref<HTMLTextAreaElement>;
}

export function TextArea({
  label,
  hint,
  error,
  required,
  className,
  id,
  ref,
  ...rest
}: TextAreaProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const { describedBy } = ids(inputId, hint, error);
  return (
    <Shell inputId={inputId} label={label} required={required} hint={hint} error={error}>
      <textarea
        ref={ref}
        id={inputId}
        rows={3}
        className={["in", "in--area", error && "in--err", rest.readOnly && "in--ro", className]
          .filter(Boolean)
          .join(" ")}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        required={required}
        {...rest}
      />
    </Shell>
  );
}

export interface SelectProps
  extends FieldBase, Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  options: readonly { value: string; label: string }[];
  ref?: Ref<HTMLSelectElement>;
}

/** Auswahlfeld auf Basis des nativen select (Tastatur und Screenreader gratis). */
export function Select({
  label,
  hint,
  error,
  options,
  required,
  className,
  id,
  ref,
  ...rest
}: SelectProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const { describedBy } = ids(inputId, hint, error);
  return (
    <Shell inputId={inputId} label={label} required={required} hint={hint} error={error}>
      <span className="sel">
        <select
          ref={ref}
          id={inputId}
          className={["in", error && "in--err", className].filter(Boolean).join(" ")}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          required={required}
          {...rest}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" />
      </span>
    </Shell>
  );
}

/** Kontrollkästchen. Nativer Input, gezeichnet über das Geschwister-Element. */
export function Checkbox({
  label,
  className,
  id,
  ref,
  ...rest
}: { label: ReactNode; ref?: Ref<HTMLInputElement> } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "children"
>) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <label className={["opt", className].filter(Boolean).join(" ")} htmlFor={inputId}>
      <input ref={ref} id={inputId} type="checkbox" className="chk-input" {...rest} />
      <span className="chk" aria-hidden="true">
        <Icon name="check" size={12} />
      </span>
      {label !== undefined && label !== "" && <span>{label}</span>}
    </label>
  );
}

export interface RadioGroupProps {
  legend: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  /** Nebeneinander statt untereinander. */
  inline?: boolean;
}

/** Optionsfelder in einer fieldset-Gruppe. Pfeiltasten wechseln, wie bei nativen Radios. */
export function RadioGroup({ legend, name, value, onChange, options, inline }: RadioGroupProps) {
  const base = useId();
  return (
    <fieldset className={["radios", inline && "radios--inline"].filter(Boolean).join(" ")}>
      <legend>{legend}</legend>
      {options.map((o, i) => {
        const id = `${base}-${i}`;
        return (
          <label key={o.value} className="opt" htmlFor={id}>
            <input
              id={id}
              type="radio"
              className="chk-input"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            <span className="rad" aria-hidden="true" />
            <span>{o.label}</span>
          </label>
        );
      })}
    </fieldset>
  );
}

interface SwitchProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Sichtbarer Text neben dem Schalter, z. B. «Ein»/«Aus». */
  text?: string;
  disabled?: boolean;
}

/** Schalter (role="switch"). */
export function Switch({ label, checked, onChange, text, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="switch"
      onClick={() => onChange(!checked)}
    >
      <span className="switch__track" aria-hidden="true">
        <span className="switch__thumb" />
      </span>
      {text}
    </button>
  );
}
