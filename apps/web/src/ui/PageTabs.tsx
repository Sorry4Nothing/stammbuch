import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export interface PageTab {
  id: string;
  label: string;
  content: ReactNode;
}

interface PageTabsProps {
  label: string;
  tabs: readonly PageTab[];
  value: string;
  onChange: (id: string) => void;
}

/** Seitentabs innerhalb einer Ansicht (Design 11.5), z. B. Einstellungen. Pfeiltasten wechseln. */
export function PageTabs({ label, tabs, value, onChange }: PageTabsProps) {
  const base = useId();
  const list = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((x) => x.id === value);
    const move = (to: number) => {
      const target = tabs[(to + tabs.length) % tabs.length];
      if (!target) return;
      e.preventDefault();
      onChange(target.id);
      list.current?.querySelector<HTMLElement>(`[data-tab="${target.id}"]`)?.focus();
    };
    if (e.key === "ArrowRight") move(index + 1);
    else if (e.key === "ArrowLeft") move(index - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(tabs.length - 1);
  };

  const active = tabs.find((x) => x.id === value);
  return (
    <>
      <div ref={list} className="ptabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            id={`${base}-t-${x.id}`}
            data-tab={x.id}
            aria-selected={x.id === value}
            aria-controls={`${base}-p-${x.id}`}
            tabIndex={x.id === value ? 0 : -1}
            className="pt"
            onClick={() => onChange(x.id)}
          >
            {x.label}
          </button>
        ))}
      </div>
      {active && (
        <div
          role="tabpanel"
          id={`${base}-p-${active.id}`}
          aria-labelledby={`${base}-t-${active.id}`}
        >
          {active.content}
        </div>
      )}
    </>
  );
}
