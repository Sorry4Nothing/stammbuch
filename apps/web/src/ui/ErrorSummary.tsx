import { t, tp } from "../i18n";
import { Message } from "./Message";

/** Fokussiert das Feld mit dieser ID (Sprunglink in Fehlerzusammenfassungen). */
export function focusField(id: string) {
  document.getElementById(id)?.focus();
}

/** Fehlerbanner «N Angaben prüfen.» mit Sprunglinks zu den Feldern (Board 3.4). */
export function ErrorSummary({
  items,
}: {
  /** `onSelect` bereitet das Ziel vor, z. B. den Tab wechseln; danach geht der Fokus ins Feld. */
  items: Array<{ id: string; label: string; onSelect?: () => void }>;
}) {
  if (items.length === 0) return null;
  return (
    <Message tone="error" title={tp("ui.errors.summary", items.length)}>
      {items.map((item, i) => (
        <span key={item.id}>
          {i > 0 && (i === items.length - 1 ? ` ${t("ui.errors.and")} ` : ", ")}
          <a
            className="lk"
            href={`#${item.id}`}
            onClick={(e) => {
              e.preventDefault();
              if (item.onSelect) {
                item.onSelect();
                setTimeout(() => focusField(item.id), 0);
              } else focusField(item.id);
            }}
          >
            {item.label}
          </a>
        </span>
      ))}
    </Message>
  );
}
