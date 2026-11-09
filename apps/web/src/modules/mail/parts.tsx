import { useEffect, useState, type ReactNode } from "react";
import { t, tp, type TextKey } from "../../i18n";
import { useCurrentTab, useTabs } from "../../shell/tabs";
import { Button, EmptyState, ErrorState, Icon, Message, type IconName } from "../../ui";
import { useMailService } from "./mailContext";
import {
  MailServiceError,
  type MailAccount,
  type MailCounts,
  type MailFolder,
} from "./mailService";
import { errorText, useAccount, type Load } from "./useMail";
import "./mail.css";

export type NavId = MailFolder | "bulk" | "lists" | "plan" | "status";

interface NavEntry {
  id: NavId;
  icon: IconName;
  label: TextKey;
  count?: keyof MailCounts;
  open: (openTab: ReturnType<typeof useTabs>["openTab"]) => void;
}

const folderEntry = (id: MailFolder, icon: IconName): NavEntry => ({
  id,
  icon,
  label: `mail.folder.${id}` as TextKey,
  count: id,
  // Der Posteingang teilt den Tab mit dem Eintrag der Seitenleiste (Schlüssel = Tab-Typ).
  open: (openTab) =>
    id === "inbox"
      ? openTab("mail", { key: "mail", params: { folder: id } })
      : openTab("mail", {
          key: `mail:${id}`,
          params: { folder: id },
          title: t(`mail.folder.${id}` as TextKey),
        }),
});

const tabEntry = (id: NavId, icon: IconName, type: string, count?: keyof MailCounts): NavEntry => ({
  id,
  icon,
  label: `mail.nav.${id}` as TextKey,
  ...(count ? { count } : {}),
  open: (openTab) => openTab(type, { key: type }),
});

const FOLDER_ENTRIES: NavEntry[] = [
  folderEntry("inbox", "inbox"),
  folderEntry("drafts", "edit"),
  folderEntry("sent", "send"),
  folderEntry("trash", "trash"),
];

const BULK_ENTRIES: NavEntry[] = [
  tabEntry("bulk", "mail", "mail-bulk"),
  tabEntry("lists", "people", "mail-lists", "lists"),
  tabEntry("plan", "clock", "mail-plan", "plan"),
  tabEntry("status", "refresh", "mail-status", "status"),
];

/** Seitenleiste des Moduls (Design 7.1) mit dem Inhalt der Seite daneben. */
export function MailLayout({ current, children }: { current: NavId; children: ReactNode }) {
  const { openTab } = useTabs();
  const service = useMailService();
  const [counts, setCounts] = useState<MailCounts>({});

  useEffect(() => {
    const abort = new AbortController();
    // Die Zähler sind Beiwerk: schlägt der Abruf fehl, bleiben sie einfach weg.
    service.counts(abort.signal).then(
      (c) => !abort.signal.aborted && setCounts(c),
      () => undefined,
    );
    return () => abort.abort();
  }, [service]);

  const item = (e: NavEntry) => {
    const n = e.count ? counts[e.count] : undefined;
    return (
      <button
        key={e.id}
        type="button"
        className={e.id === current ? "nav__item is-active" : "nav__item"}
        aria-current={e.id === current ? "page" : undefined}
        onClick={() => e.open(openTab)}
      >
        <Icon name={e.icon} size={18} />
        <span>{t(e.label)}</span>
        {n !== undefined && <span className="nav__count">{n}</span>}
      </button>
    );
  };

  return (
    <div className="mail">
      <nav className="nav mail__nav" aria-label={t("mail.nav.label")}>
        {FOLDER_ENTRIES.map(item)}
        <div className="nav__sep" role="separator" />
        <div className="nav__label">{t("mail.nav.group")}</div>
        {BULK_ENTRIES.map(item)}
      </nav>
      <div className="mail__main">{children}</div>
    </div>
  );
}

/** Meldet ungespeicherte Eingaben dem Tab (Punkt, Warnung beim Schliessen). */
export function useTabDirty(dirty: boolean) {
  const { setDirty } = useCurrentTab();
  useEffect(() => setDirty(dirty), [setDirty, dirty]);
}

/**
 * Schliesst den Tab, sobald `done` gilt. Erst im Effekt, damit die Shell vorher «nicht mehr
 * ungespeichert» kennt und nicht nachfragt.
 */
export function useCloseWhen(done: boolean) {
  const { close } = useCurrentTab();
  // Zwei Schritte: im ersten Durchgang nimmt die Shell «ungespeichert» zurück, im zweiten schliesst der Tab.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (done) setReady(true);
  }, [done]);
  useEffect(() => {
    if (ready) close();
  }, [ready, close]);
}

export function Loading() {
  return (
    <p className="muted mail__loading" role="status">
      {t("mail.loading")}
    </p>
  );
}

/** Mail ist serverseitig aus oder hat kein Konto: ruhiger Zustand mit Weg in die Einstellungen. */
export function NotConfigured() {
  const { openTab, tabs, update } = useTabs();
  const setup = () => {
    const params = { section: "mail" };
    const open = tabs.find((x) => x.type === "settings");
    if (open) update(open.id, { params });
    openTab("settings", { key: "settings", params });
  };
  return (
    <div className="mail__state">
      <EmptyState
        title={t("mail.notConfigured.title")}
        text={t("mail.notConfigured.text")}
        actions={
          <Button variant="primary" onClick={setup}>
            {t("mail.notConfigured.action")}
          </Button>
        }
      />
    </div>
  );
}

/** Fehlerzustand einer Seite (Design 2.6). */
export function LoadError({
  load,
  onRetry,
}: {
  load: Extract<Load<unknown>, { status: "error" }>;
  onRetry: () => void;
}) {
  if (load.error instanceof MailServiceError && load.error.kind === "notAvailable") {
    return <NotConfigured />;
  }
  return (
    <div className="mail__state">
      <div className="state-page__alert">
        <Message tone="error" title={t("mail.error.title")}>
          {t("mail.error.text")}
        </Message>
      </div>
      <ErrorState
        message={errorText(load.error)}
        at={load.at}
        errorId={load.errorId}
        onRetry={onRetry}
      />
    </div>
  );
}

/** Meldung nach einer fehlgeschlagenen Aktion (`role="alert"`). */
export function ActionError({ error }: { error: unknown }) {
  return (
    <div className="mail__alert">
      <Message tone="error" title={t("mail.error.action")}>
        {errorText(error)}
      </Message>
    </div>
  );
}

/** Zeigt die Seite erst, wenn ein Mail-Konto geladen ist; sonst Laden, Fehler oder Leer-Zustand. */
export function WithAccount({
  current,
  children,
}: {
  current: NavId;
  children: (account: MailAccount) => ReactNode;
}) {
  const [load, reload] = useAccount();
  return (
    <MailLayout current={current}>
      {load.status === "loading" && <Loading />}
      {load.status === "error" && <LoadError load={load} onRetry={reload} />}
      {load.status === "ready" && load.data === null && <NotConfigured />}
      {load.status === "ready" && load.data && children(load.data)}
    </MailLayout>
  );
}

interface SearchBoxProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

/** Suchfeld der Werkzeugleiste (Design 7.1): Lupe, Platzhalter = Beschriftung. */
export function SearchBox({ label, value, onChange }: SearchBoxProps) {
  return (
    <label className="in mail-search">
      <Icon name="search" size={16} />
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

/** Auswahl der Werkzeugleiste, z. B. «Status: Alle». */
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
    <span className="sel mail-filter">
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

/** Anzahl rechts in der Werkzeugleiste. */
export function ToolCount({ shown, total }: { shown: number; total: number }) {
  return (
    <>
      <span className="tool__spacer" />
      <span className="muted" aria-live="polite">
        {t("mail.count", { shown, total })}
      </span>
    </>
  );
}

/** Leiste «1 ausgewählt» mit den Aktionen für die Auswahl. */
export function SelectionBar({ count, children }: { count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <div className="selbar">
      <span className="selbar__count" role="status">
        {tp("mail.selected", count)}
      </span>
      {children}
    </div>
  );
}

/** Blättern unter einer Tabelle: «Seite 1 von 8». */
export function Pager({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="pager">
      <Button
        variant="ghost"
        small
        icon="chevronLeft"
        aria-label={t("mail.pager.prev")}
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      />
      <span>{t("mail.pager.page", { page, pages })}</span>
      <Button
        variant="ghost"
        small
        icon="chevronRight"
        aria-label={t("mail.pager.next")}
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
      />
    </div>
  );
}

/** Beschriftete Angaben untereinander (Seitenfelder der Boards 7.2 bis 7.4). */
export function Facts({ items }: { items: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="mail-facts">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Dateikachel eines Anhangs. */
export function FileTag({ name, size }: { name: string; size: string }) {
  return (
    <span className="mail-tag">
      <Icon name="paperclip" size={16} />
      {name} <span className="mail-tag__size">{size}</span>
    </span>
  );
}

/** Schrittanzeige des Multiversands (Design 7.5 bis 7.7). */
export function Steps({ current, labels }: { current: number; labels: readonly string[] }) {
  return (
    <ol className="steps" aria-label={t("mail.bulk.steps")}>
      {labels.map((label, i) => {
        const n = i + 1;
        const state = n < current ? "done" : n === current ? "current" : "todo";
        return (
          <li
            key={label}
            className={`opt steps__item steps__item--${state}`}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className={`steps__num steps__num--${state}`} aria-hidden={state !== "done"}>
              {state === "done" ? <Icon name="check" size={14} /> : n}
            </span>
            {state === "done" && <span className="visually-hidden">{t("mail.bulk.done")}</span>}
            <span>{label}</span>
            {n < labels.length && <span className="steps__line" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}
