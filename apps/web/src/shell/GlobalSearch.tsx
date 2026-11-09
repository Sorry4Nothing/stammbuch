import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { SearchHit, SearchProvider } from "../modules/types";
import { t, tp } from "../i18n";
import { Badge, Button, Dialog, Icon, Kbd, Message } from "../ui";

export const SEARCH_DEBOUNCE_MS = 150;

interface Group {
  provider: SearchProvider;
  hits: SearchHit[];
}

interface GlobalSearchProps {
  providers: readonly SearchProvider[];
  onClose: () => void;
  /** Öffnet den Treffer in einem neuen Tab. */
  onOpen: (hit: SearchHit) => void;
  /** «Person anlegen» bei der Meldung ohne Treffer. Ohne Angabe erscheint die Schaltfläche nicht. */
  onCreatePerson?: () => void;
}

/** Globale Suche (Strg+K, Design 2.2 und 2.3). Combobox-Muster: Fokus bleibt im Feld, ↑/↓ wählen. */
export function GlobalSearch({ providers, onClose, onOpen, onCreatePerson }: GlobalSearchProps) {
  const base = useId();
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [searched, setSearched] = useState("");
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setGroups([]);
      setSearched("");
      setFailed(false);
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      let anyFailed = false;
      const results = await Promise.all(
        providers.map(async (provider) => {
          try {
            return { provider, hits: await provider.search(q, abort.signal) };
          } catch {
            anyFailed = true;
            return { provider, hits: [] as SearchHit[] };
          }
        }),
      );
      if (abort.signal.aborted) return;
      setGroups(results.filter((g) => g.hits.length > 0));
      setSearched(q);
      setFailed(anyFailed);
      setActive(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [query, providers]);

  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);
  const optionId = (i: number) => `${base}-opt-${i}`;
  const listId = `${base}-list`;
  const hasResult = searched !== "" && flat.length > 0;
  const noResult = searched !== "" && flat.length === 0 && !failed;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && flat.length > 0) {
      e.preventDefault();
      setActive((i) => (i + 1) % flat.length);
    } else if (e.key === "ArrowUp" && flat.length > 0) {
      e.preventDefault();
      setActive((i) => (i - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = flat[active];
      if (hit) onOpen(hit);
    }
  };

  let index = -1;
  return (
    <Dialog
      title={t("search.title")}
      label={t("search.title")}
      closeLabel={t("search.close")}
      width={680}
      top={90}
      onClose={onClose}
      flush
    >
      <div>
        <div className="search__top">
          <label htmlFor={`${base}-in`} className="search__label muted">
            {t("search.label")}
          </label>
          <div className="in search__box">
            <Icon name="search" size={18} />
            <input
              ref={input}
              id={`${base}-in`}
              name="q"
              placeholder={t("search.placeholder")}
              data-autofocus
              type="text"
              role="combobox"
              aria-expanded={hasResult}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={hasResult ? optionId(active) : undefined}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>
        </div>

        {failed && (
          <div className="search__fail">
            <Message tone="warning">{t("search.partialFail")}</Message>
          </div>
        )}

        <div id={listId} role="listbox" aria-label={t("search.results")} className="search__list">
          {groups.map((g) => (
            <div key={g.provider.id} role="group" aria-labelledby={`${base}-g-${g.provider.id}`}>
              <div className="search__group" id={`${base}-g-${g.provider.id}`}>
                {t(g.provider.groupKey)}
              </div>
              <div className="search__items">
                {g.hits.map((hit) => {
                  index += 1;
                  const i = index;
                  return (
                    <div
                      key={hit.id}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === active}
                      className={i === active ? "search__item is-active" : "search__item"}
                      onMouseMove={() => setActive(i)}
                      onClick={() => onOpen(hit)}
                    >
                      <Icon name={hit.icon} />
                      <span
                        className="search__text"
                        title={`${hit.title} ${hit.subtitle ?? ""}`.trim()}
                      >
                        <b>{hit.title}</b>
                        {hit.subtitle && <span className="search__sub"> {hit.subtitle}</span>}
                      </span>
                      <span className="search__kind">
                        {hit.status ? (
                          <Badge tone={hit.status.tone}>{hit.status.label}</Badge>
                        ) : (
                          hit.kind
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {noResult && (
          <div className="search__empty">
            <b className="search__empty-title">{t("search.none", { q: searched })}</b>
            <span className="muted search__empty-text">{t("search.noneHelp")}</span>
            <div className="search__empty-actions">
              <Button
                icon="close"
                onClick={() => {
                  setQuery("");
                  input.current?.focus();
                }}
              >
                {t("search.clear")}
              </Button>
              {onCreatePerson && (
                <Button icon="plus" onClick={onCreatePerson}>
                  {t("search.createPerson")}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="search__foot muted">
        {hasResult && (
          <>
            <span>
              <Kbd>↑↓</Kbd> {t("search.keys.select")}
            </span>
            <span>
              <Kbd>Enter</Kbd> {t("search.keys.open")}
            </span>
          </>
        )}
        <span>
          <Kbd>Esc</Kbd> {t("search.keys.close")}
        </span>
        {noResult && (
          <span>
            <Kbd>Strg+A</Kbd> {t("search.keys.selectInput")}
          </span>
        )}
        <span className="search__count" role="status">
          {searched !== "" ? tp("search.count", flat.length) : ""}
        </span>
      </div>
    </Dialog>
  );
}
