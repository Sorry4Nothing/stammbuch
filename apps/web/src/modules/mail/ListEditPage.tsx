import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { useCurrentTab, useTabs } from "../../shell/tabs";
import { Badge, Button, Icon, Message, PageHeader, Panel, TextField, useToast } from "../../ui";
import { useMailService } from "./mailContext";
import type { AddressListDetail, ListEntry, PersonHit } from "./mailService";
import { ActionError, Loading, LoadError, MailLayout, useCloseWhen, useTabDirty } from "./parts";
import { useLoad } from "./useMail";

const blank: AddressListDetail = {
  id: "",
  name: "",
  kind: "manual",
  source: "",
  persons: 0,
  withoutEmail: 0,
  recipients: 0,
  lastUsedAt: null,
  description: "",
  entries: [],
  groupIds: [],
};

/** Einträge aus dem Tab-Parameter «entries»; ungültige Angaben ergeben eine leere Liste. */
function presetEntries(json: string | undefined): ListEntry[] {
  if (!json) return [];
  try {
    const list: unknown = JSON.parse(json);
    return Array.isArray(list)
      ? list.filter(
          (e): e is ListEntry => typeof e?.key === "string" && typeof e?.name === "string",
        )
      : [];
  } catch {
    return [];
  }
}

/** Suche nach Personen für die Adressliste: Treffer nach kurzer Pause, ältere Antworten fallen weg. */
function usePeopleSearch(query: string) {
  const service = useMailService();
  const [hits, setHits] = useState<PersonHit[]>([]);
  useEffect(() => {
    const text = query.trim();
    if (text === "") {
      setHits([]);
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      service.searchPeople(text, abort.signal).then(
        (found) => !abort.signal.aborted && setHits(found),
        () => !abort.signal.aborted && setHits([]),
      );
    }, 200);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [service, query]);
  return hits;
}

function Editor({ detail }: { detail: AddressListDetail }) {
  const service = useMailService();
  const toast = useToast();
  const tab = useCurrentTab();
  const { openTab } = useTabs();
  const [name, setName] = useState(detail.name);
  const [description, setDescription] = useState(detail.description);
  const [entries, setEntries] = useState<ListEntry[]>(detail.entries);
  const [query, setQuery] = useState("");
  const [nameError, setNameError] = useState<string>();
  const [actionError, setActionError] = useState<unknown>();
  const [done, setDone] = useState(false);
  const hits = usePeopleSearch(query).filter((h) => !entries.some((e) => e.key === h.key));

  const snapshot = JSON.stringify([name, description, entries.map((e) => e.key)]);
  const [saved, setSaved] = useState(snapshot);
  const dirty = snapshot !== saved;
  useTabDirty(!done && dirty);
  useCloseWhen(done);
  useEffect(() => tab.setTitle(name.trim() || t("mail.listEdit.new")), [tab, name]);

  const add = (hit: PersonHit | undefined) => {
    if (!hit) return;
    setEntries((list) => [
      ...list,
      {
        key: hit.key,
        name: hit.name,
        email: hit.email,
        group: hit.group,
        ...(hit.personId ? { personId: hit.personId } : {}),
        ...(hit.anrede ? { anrede: hit.anrede } : {}),
        ...(hit.vorname ? { vorname: hit.vorname } : {}),
        ...(hit.nachname ? { nachname: hit.nachname } : {}),
      },
    ]);
    setQuery("");
  };

  const save = async (): Promise<boolean> => {
    setActionError(undefined);
    if (name.trim() === "") {
      setNameError(t("mail.listEdit.error.name"));
      return false;
    }
    setNameError(undefined);
    try {
      await service.saveList({
        ...(detail.id ? { id: detail.id } : {}),
        name: name.trim(),
        description,
        entries,
        groupIds: detail.groupIds,
      });
      toast.show({ tone: "ok", title: t("mail.listEdit.saved") });
      setSaved(snapshot);
      return true;
    } catch (e) {
      setActionError(e);
      return false;
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => tab.registerSave(() => saveRef.current()), [tab]);

  const finish = async () => {
    if (await save()) {
      setDone(true);
      openTab("mail-lists", { key: "mail-lists" });
    }
  };

  const withoutEmail = entries.filter((e) => !e.email);
  // Personen aus Gruppen, die diese Liste zusätzlich enthält, zählt der Dienst selbst.
  const fromGroups = Math.max(0, (detail.persons ?? 0) - detail.entries.length);
  const persons = entries.length + fromGroups;

  return (
    <>
      <PageHeader
        crumb={t("mail.crumb.listEdit", { name: name.trim() || t("mail.listEdit.new") })}
        title={name.trim() || t("mail.listEdit.new")}
        status={
          <>
            <Badge tone="neutral">{t("mail.lists.type.manual")}</Badge>
            {dirty && (
              <Badge tone="warning">
                <Icon name="warning" size={12} />
                {t("mail.listEdit.unsaved")}
              </Badge>
            )}
          </>
        }
        actions={
          <>
            <Button icon="close" onClick={() => setDone(true)}>
              {t("ui.cancel")}
            </Button>
            <Button variant="primary" icon="save" onClick={() => void finish()}>
              {t("mail.listEdit.save")}
            </Button>
          </>
        }
      />
      {actionError !== undefined && <ActionError error={actionError} />}
      <div className="mail-cols">
        <div className="mail-cols__main mail-form">
          <div className="mail-grid mail-grid--half">
            <TextField
              label={t("mail.listEdit.name")}
              required
              value={name}
              error={nameError}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
            <TextField
              label={t("mail.listEdit.description")}
              value={description}
              autoComplete="off"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <Panel title={t("mail.listEdit.persons", { n: entries.length })} flush>
            <div className="mail-add">
              <label className="in mail-search mail-search--grow">
                <Icon name="search" size={16} />
                <input
                  name="q"
                  type="search"
                  aria-label={t("mail.listEdit.search")}
                  placeholder={t("mail.listEdit.search")}
                  value={query}
                  autoComplete="off"
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <Button icon="plus" disabled={hits.length === 0} onClick={() => add(hits[0])}>
                {t("mail.listEdit.add")}
              </Button>
            </div>
            {hits.length > 0 && (
              <ul className="mail-hits" aria-label={t("mail.listEdit.hits")}>
                {hits.map((h) => (
                  <li key={h.key}>
                    <button type="button" className="mail-hits__item" onClick={() => add(h)}>
                      <b>{h.name}</b>
                      <span className="muted">{h.email}</span>
                      {h.group && <span className="muted">{h.group}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <table className="tbl" aria-label={t("mail.listEdit.table")}>
              <colgroup>
                <col style={{ width: "173px" }} />
                <col />
                <col style={{ width: "162px" }} />
                <col style={{ width: "52px" }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">{t("mail.listEdit.col.name")}</th>
                  <th scope="col">{t("mail.listEdit.col.email")}</th>
                  <th scope="col">{t("mail.listEdit.col.group")}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t("mail.listEdit.col.action")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.length === 0 && (
                  <tr>
                    <td colSpan={4} className="tbl__empty">
                      <span className="muted">{t("mail.listEdit.empty")}</span>
                    </td>
                  </tr>
                )}
                {entries.map((e) => (
                  <tr key={e.key}>
                    <td>
                      <b>{e.name}</b>
                    </td>
                    <td>
                      {e.email ?? (
                        <Badge tone="warning">
                          <Icon name="warning" size={12} />
                          {t("mail.listEdit.noEmail")}
                        </Badge>
                      )}
                    </td>
                    <td>{e.group ?? "–"}</td>
                    <td>
                      <Button
                        variant="ghost"
                        small
                        icon="trash"
                        aria-label={t("mail.listEdit.remove", { name: e.name })}
                        onClick={() => setEntries((list) => list.filter((x) => x.key !== e.key))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
        <div className="mail-side">
          <Panel title={t("mail.bulk.summary")}>
            <dl className="kv mail__kv">
              <dt>{t("mail.bulk.persons")}</dt>
              <dd>{persons}</dd>
              <dt>{t("mail.bulk.noEmail")}</dt>
              <dd>{withoutEmail.length}</dd>
              <dt>{t("mail.bulk.recipientCount")}</dt>
              <dd>
                <b>{persons - withoutEmail.length}</b>
              </dd>
            </dl>
          </Panel>
          {withoutEmail.map((e) => (
            <Message
              key={e.key}
              tone="warning"
              title={t("mail.listEdit.warn.title", { name: e.name })}
            >
              {t("mail.listEdit.warn.text")}
            </Message>
          ))}
        </div>
      </div>
    </>
  );
}

/** Adressliste bearbeiten oder anlegen (Design 7.9). */
export function ListEditPage() {
  const service = useMailService();
  const tab = useCurrentTab();
  const id = tab.params["listId"];
  // Parameter «entries»: Personen, die ein anderes Modul (z. B. Personen) in die neue Liste vorgibt.
  const preset = tab.params["entries"];
  const [load, reload] = useLoad<AddressListDetail>(
    (signal) =>
      id ? service.list(id, signal) : Promise.resolve({ ...blank, entries: presetEntries(preset) }),
    [service, id, preset],
  );
  return (
    <MailLayout current="lists">
      {load.status === "loading" && <Loading />}
      {load.status === "error" && <LoadError load={load} onRetry={reload} />}
      {load.status === "ready" && <Editor detail={load.data} />}
    </MailLayout>
  );
}
