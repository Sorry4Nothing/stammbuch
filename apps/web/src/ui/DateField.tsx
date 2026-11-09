import { useRef } from "react";
import { t } from "../i18n";
import { Icon } from "./Icon";
import { TextField, type TextFieldProps } from "./Field";
import { parseDateInput } from "./swiss";

export interface DateFieldProps extends Omit<TextFieldProps, "onChange" | "type" | "trailing"> {
  value: string;
  /** Neuer Text im Format TT.MM.JJJJ (getippt oder im Kalender gewählt). */
  onChange: (text: string) => void;
}

/** Der Browser kann den Kalender per Skript öffnen (sonst bleibt nur das Textfeld). */
const canPick = () =>
  typeof HTMLInputElement !== "undefined" && "showPicker" in HTMLInputElement.prototype;

/** Datumsfeld: Text TT.MM.JJJJ wie überall, dazu ein Knopf, der den Kalender des Browsers öffnet. */
export function DateField({ value, onChange, ...rest }: DateFieldProps) {
  const native = useRef<HTMLInputElement>(null);
  const text = useRef<HTMLInputElement>(null);

  const open = () => {
    const el = native.current;
    if (!el) return;
    const parsed = parseDateInput(value, { shortYear: true });
    el.value = "iso" in parsed ? parsed.iso : "";
    try {
      el.showPicker();
    } catch {
      // Der Browser verweigert den Kalender (z. B. ohne Nutzeraktion): das Textfeld bleibt.
    }
  };

  const picked = (iso: string) => {
    if (!iso) return;
    onChange(iso.split("-").reverse().join("."));
    text.current?.focus();
  };

  return (
    <TextField
      autoComplete="off"
      {...rest}
      ref={text}
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      trailing={
        canPick() && (
          <>
            <button
              type="button"
              className="in-wrap__btn"
              aria-label={t("ui.date.pick")}
              title={t("ui.date.pick")}
              disabled={rest.disabled || rest.readOnly}
              onClick={open}
            >
              <Icon name="calendar" size={16} />
            </button>
            <input
              ref={native}
              type="date"
              tabIndex={-1}
              aria-hidden="true"
              className="in-wrap__native"
              onChange={(e) => picked(e.target.value)}
            />
          </>
        )
      }
    />
  );
}
