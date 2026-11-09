import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { t } from "../../i18n";
import { Icon } from "../../ui";
import type { Recipient } from "./model";

interface Props {
  value: Recipient | null;
  onChange: (value: Recipient) => void;
  search: (query: string, signal: AbortSignal) => Promise<Recipient[]>;
  error?: string | undefined;
}

/** Empfänger aus Personen und Firmen wählen (Design 4.2): Eingabe sucht, Pfeiltasten und Enter wählen. */
export function RecipientPicker({ value, onChange, search, error }: Props) {
  const id = useId();
  const [text, setText] = useState(value?.name ?? "");
  const [results, setResults] = useState<Recipient[] | null>(null);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (value) setText(value.name);
  }, [value]);

  useEffect(() => () => abort.current?.abort(), []);

  const find = (query: string) => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    search(query, ctl.signal).then(
      (list) => {
        if (ctl.signal.aborted) return;
        setResults(list);
        setActive(0);
      },
      () => !ctl.signal.aborted && setResults([]),
    );
  };

  const choose = (r: Recipient) => {
    onChange(r);
    setText(r.name);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        find(text);
        return;
      }
      const n = results?.length ?? 0;
      if (n > 0) setActive((active + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter" && open && results?.[active]) {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  const listId = `${id}-list`;
  return (
    <div className="lbl">
      <label htmlFor={id}>
        {t("rechnungen.form.recipient")}
        <span aria-hidden="true"> *</span>
      </label>
      <div className="rg-pick">
        <input
          id={id}
          className={error ? "in in--err" : "in"}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && results?.[active] ? `${id}-o${active}` : undefined}
          aria-invalid={error ? true : undefined}
          required
          placeholder={t("rechnungen.form.recipientPlaceholder")}
          autoComplete="off"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            find(e.target.value);
          }}
          onFocus={() => {
            setOpen(true);
            find(text === value?.name ? "" : text);
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        <Icon name="chevronDown" className="rg-pick__icon" />
        {open && (
          <ul
            id={listId}
            role="listbox"
            className="rg-pick__list"
            aria-label={t("rechnungen.form.recipient")}
          >
            {results?.map((r, i) => (
              <li
                key={r.id}
                id={`${id}-o${i}`}
                role="option"
                aria-selected={i === active}
                className="rg-pick__item"
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(r);
                }}
              >
                {r.name}
              </li>
            ))}
            {results?.length === 0 && (
              <li className="rg-pick__empty">{t("rechnungen.form.recipientNone")}</li>
            )}
          </ul>
        )}
      </div>
      {error && <span className="lbl__error">{error}</span>}
    </div>
  );
}
