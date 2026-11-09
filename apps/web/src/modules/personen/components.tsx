import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { t, tp } from "../../i18n";
import { Badge, Button, Dialog, ErrorState, Icon, Message, type Tone } from "../../ui";
import type { FirmaStatus, PersonStatus } from "./model";
import "./personen.css";

/** Leerer Wert in Detailansichten. */
export const dash = (v: string | null | undefined) => (v ? v : "–");

/** Lädt Daten und lädt neu, wenn sich `deps` ändern oder `reload` aufgerufen wird. */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({
    loading: true,
  });
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ data: s.data, loading: true }));
    load().then(
      (data) => live && setState({ data, loading: false }),
      (error: unknown) => live && setState({ error, loading: false }),
    );
    return () => {
      live = false;
    };
  }, [...deps, round]);
  return { ...state, reload: () => setRound((n) => n + 1) };
}

/** Zustand einer Ansicht, die nicht geladen werden konnte (Design 2.6). */
export function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <ErrorState
      title={t("personen.error.title")}
      text={t("personen.error.text")}
      onRetry={onRetry}
    />
  );
}

/** Beschriftete Werte (Design `.kv`). `wide`/`narrow` setzen die Breite der Beschriftungsspalte. */
export function Kv({ rows, size }: { rows: Array<[string, ReactNode]>; size?: "wide" | "narrow" }) {
  return (
    <dl className={["kv", size && `kv--${size}`].filter(Boolean).join(" ")}>
      {rows.map(([k, v], i) => (
        <Fragment key={`${i}-${k}`}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function Loading() {
  return (
    <p className="pad-x muted" role="status">
      {t("personen.loading")}
    </p>
  );
}

const personTone: Record<PersonStatus, Tone> = {
  aktiv: "ok",
  ausstehend: "warning",
  ausgetreten: "neutral",
};

export function PersonStatusBadge({ status }: { status: PersonStatus }) {
  return (
    <Badge tone={personTone[status]}>
      {t(`personen.status.${status}` as "personen.status.aktiv")}
    </Badge>
  );
}

const firmaTone: Record<FirmaStatus, Tone> = {
  ausstehend: "warning",
  freigegeben: "ok",
  abgelehnt: "error",
};

export function FirmaStatusBadge({ status }: { status: FirmaStatus }) {
  return (
    <Badge tone={firmaTone[status]}>
      {t(`personen.firmaStatus.${status}` as "personen.firmaStatus.freigegeben")}
    </Badge>
  );
}

interface FieldShell {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  id?: string;
}

function Shell({
  inputId,
  label,
  required,
  hint,
  error,
  children,
}: FieldShell & { inputId: string; children: ReactNode }) {
  return (
    <div className="lbl">
      <label htmlFor={inputId}>
        {label}
        {required && (
          <>
            {" "}
            <span aria-hidden="true">*</span>
            <span className="visually-hidden">{t("personen.field.required")}</span>
          </>
        )}
      </label>
      {children}
      {hint && (
        <span className="lbl__hint" id={`${inputId}-hint`}>
          {hint}
        </span>
      )}
      {error && (
        <span className="lbl__em" id={`${inputId}-error`}>
          <Icon name="warning" size={14} />
          <span>{error}</span>
        </span>
      )}
    </div>
  );
}

const describe = (id: string, hint?: string, error?: string) =>
  [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(" ") || undefined;

/** Einzeiliges Feld nach Board 3.4: Pflichtfeld mit «*» und Hinweis, Hinweis vor Fehlertext. */
export function FormInput({
  label,
  required,
  hint,
  error,
  id,
  className,
  ...rest
}: FieldShell & Omit<InputHTMLAttributes<HTMLInputElement>, "id">) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Shell inputId={inputId} label={label} required={required} hint={hint} error={error}>
      <input
        id={inputId}
        type="text"
        className={["in", error && "in--err", rest.readOnly && "in--ro", className]
          .filter(Boolean)
          .join(" ")}
        aria-invalid={error ? true : undefined}
        aria-describedby={describe(inputId, hint, error)}
        aria-required={required || undefined}
        {...rest}
      />
    </Shell>
  );
}

export function FormTextArea({
  label,
  required,
  hint,
  error,
  id,
  ...rest
}: FieldShell & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id">) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Shell inputId={inputId} label={label} required={required} hint={hint} error={error}>
      <textarea
        id={inputId}
        rows={2}
        className={["in", "in--area", error && "in--err"].filter(Boolean).join(" ")}
        aria-invalid={error ? true : undefined}
        aria-describedby={describe(inputId, hint, error)}
        {...rest}
      />
    </Shell>
  );
}

export function FormSelect({
  label,
  required,
  hint,
  error,
  id,
  options,
  ...rest
}: FieldShell & {
  options: readonly { value: string; label: string }[];
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, "id" | "children">) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Shell inputId={inputId} label={label} required={required} hint={hint} error={error}>
      <span className="sel">
        <select
          id={inputId}
          className={["in", error && "in--err"].filter(Boolean).join(" ")}
          aria-invalid={error ? true : undefined}
          aria-describedby={describe(inputId, hint, error)}
          aria-required={required || undefined}
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

/** Suchfeld der Listen. Das Symbol steht links, der Text ist der Platzhalter und der Name des Feldes. */
export function SearchBox({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="in tool__search">
      <Icon name="search" />
      <input
        type="search"
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** Filter einer Liste: natives Auswahlfeld, der sichtbare Text lautet z. B. «Typ: Alle». */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <span className="sel tool__filter">
      <select
        className="in"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" />
    </span>
  );
}

/** Dialog mit Schliessen-Schaltfläche oben rechts (Boards 3.6 bis 3.8). */
export function PDialog({
  title,
  onClose,
  footer,
  width,
  onSubmit,
  children,
}: {
  title: string;
  onClose: () => void;
  footer: ReactNode;
  width?: number;
  onSubmit?: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog title={title} onClose={onClose} width={width} onSubmit={onSubmit} footer={footer}>
      <div className="dlg__x">
        <Button
          variant="ghost"
          icon="close"
          aria-label={t("personen.dialog.close")}
          onClick={onClose}
        />
      </div>
      {children}
    </Dialog>
  );
}

const bus = new EventTarget();

/** Meldet, dass Personen, Gruppen oder Firmen geändert wurden. Offene Tabs laden dann neu. */
export const notifyChange = () => bus.dispatchEvent(new Event("change"));

export function useOnChange(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const handler = () => ref.current();
    bus.addEventListener("change", handler);
    return () => bus.removeEventListener("change", handler);
  }, []);
}

/** Wert mit Verzögerung, z. B. für das Suchfeld. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Zusammenfassung fehlerhafter Felder mit Sprunglinks (Board 3.4). */
export function ErrorSummary({ items }: { items: Array<{ id: string; label: string }> }) {
  if (items.length === 0) return null;
  return (
    <Message tone="error" title={tp("personen.error.summary", items.length)}>
      {t("personen.error.summary.fix")}{" "}
      {items.map((item, i) => (
        <span key={item.id}>
          {i > 0 && (i === items.length - 1 ? ` ${t("personen.and")} ` : ", ")}
          <a
            className="lk"
            href={`#${item.id}`}
            onClick={(e) => {
              e.preventDefault();
              focusField(item.id);
            }}
          >
            {item.label}
          </a>
        </span>
      ))}
      {t("personen.error.summary.end")}
    </Message>
  );
}

/** Fokussiert das Feld mit dieser ID (Sprunglink in Fehlerzusammenfassungen). */
export function focusField(id: string) {
  document.getElementById(id)?.focus();
}
