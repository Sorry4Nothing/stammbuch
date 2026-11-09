import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { useCurrentTab } from "../../shell/tabs";
import { Button, Icon } from "../../ui";

/** Zeilen pro Seite in den Listen (Design 8.5, 8.6). */
export const PAGE_SIZE = 16;

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
    <label className="in cal-search">
      <Icon name="search" />
      <span className="visually-hidden">{label}</span>
      <input
        type="search"
        placeholder={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** Filter als natives Auswahlfeld (Tastatur und Screenreader ohne Zusatzcode); Beschriftung wie im Design: «Gruppe: Alle». */
export function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <span className="sel cal-filter">
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

/** Seitenwahl; meldet «Seite x von y» auch an die Fusszeile des Tabs. */
export function usePaging(total: number, resetKey: string) {
  const tab = useCurrentTab();
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const [requested, setPage] = useState(1);
  const page = Math.min(requested, pages);

  // Neue Suche oder neuer Filter beginnt wieder auf Seite 1.
  useEffect(() => setPage(1), [resetKey]);
  useEffect(() => tab.setPage(page, pages), [tab, page, pages]);

  return {
    page,
    pages,
    setPage,
    slice: <T,>(rows: readonly T[]) => rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
  };
}

export function Pager({
  page,
  pages,
  onChange,
}: {
  page: number;
  pages: number;
  onChange: (page: number) => void;
}) {
  // Eine einzige Seite braucht kein Blättern.
  if (pages <= 1) return null;
  return (
    <div className="cal-pg">
      <Button
        small
        variant="ghost"
        icon="chevronLeft"
        aria-label={t("kalender.pager.prev")}
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      />
      <span>{t("kalender.pager.page", { page, pages })}</span>
      <Button
        small
        variant="ghost"
        icon="chevronRight"
        aria-label={t("kalender.pager.next")}
        disabled={page >= pages}
        onClick={() => onChange(page + 1)}
      />
    </div>
  );
}
